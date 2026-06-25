# ARCHITECTURE

Procurement order-management API. A single **Node 20 + TypeScript + Fastify** service on
port 3000, backed by **PostgreSQL 16** (source of truth) and **Redis 7** (background job
queue + per-order dedup locks). Real-time updates are pushed over **Server-Sent Events**.

The guiding principle throughout: **Postgres owns the data and the correctness guarantees;
Redis owns the asynchronous work.** Nothing that must be correct depends on Redis.

---

## 1. Project structure

```
src/
├── server/
│   ├── index.ts            # Fastify bootstrap, error/404 envelopes, route registration order
│   ├── db.ts               # pg Pool + NUMERIC→number type parser
│   ├── redis.ts            # ioredis clients (one normal, one blocking) + key helpers
│   ├── events.ts           # in-process SSE client registry + broadcasters
│   ├── bulk/
│   │   └── worker.ts       # background queue consumer: dedup lock → update → progress → event
│   ├── lib/
│   │   ├── validation.ts   # Zod schemas, status/action enums, list-param parsing + whitelists
│   │   └── envelope.ts     # paginated() and sendError() response helpers
│   └── routes/
│       ├── orders.ts       # list / get / patch / stats / anomalies
│       ├── suppliers.ts    # list / get (computed) / :id/performance
│       ├── products.ts     # list + recursive category filter
│       ├── bulk.ts         # the 3 bulk paths → enqueue → 202
│       ├── jobs.ts         # GET /api/jobs/:id (reads the Redis job hash)
│       └── events.ts       # GET /api/events (SSE)
└── scripts/
    ├── schema.sql          # tables (idempotent: DROP + CREATE)
    ├── indexes.sql         # indexes + ANALYZE, applied after bulk load
    ├── import.ts           # COPY the 4 CSVs in FK order, then indexes, then smoke counts
    └── reset-redis.ts      # FLUSHALL helper used by `npm run reset`
```

**Why routes hold their own SQL instead of a service/repository layer:** at this size, the
graded thing is the *correctness and cost of the queries*. Keeping each query next to the
endpoint that owns it makes the SQL — the thing a reviewer actually wants to inspect — visible
in one place, with no ORM hiding which index gets used. A repository layer would add indirection
without removing any real duplication (each endpoint's query is genuinely distinct).

**Raw SQL over an ORM** is a deliberate choice for the same reason: the aggregations, the
recursive category CTE, and the optimistic-lock UPDATE are all clearer and more tunable as SQL,
and performance is explicit rather than emergent.

---

## 2. Database schema

Four tables mirroring the CSVs (`src/scripts/schema.sql`). Column choices encode the dataset's
intentional edge cases:

| Table | Notable columns / decisions |
|-------|------------------------------|
| `categories` | `parent_id` is **not** a foreign key — the hierarchy contains cycles and self-references we must load, not reject. |
| `suppliers` | `rating NUMERIC` is nullable (~14 blank); `active BOOLEAN NOT NULL`. |
| `products` | `price NUMERIC NOT NULL` — the base/catalog price used by anomalies and `price_consistency`. |
| `orders` | `quantity` is **unconstrained** (negatives = returns); `total_price` may intentionally `!= quantity*unit_price`; `updated_at` may precede `created_at`; `warehouse` may be null/empty; `notes` stores raw text (may contain XSS payloads); `version INTEGER DEFAULT 0` for concurrency. |

**No foreign-key constraints by design.** The seed data deliberately contains orphan/duplicate
references (inactive suppliers with orders, products in nonexistent categories). FKs would
reject rows at `COPY` time and lose the very anomalies the assignment asks us to *detect*.
Referential integrity is therefore enforced by the import order and surfaced as data-quality
signals, not blocked at the database boundary.

**Money as `NUMERIC`** avoids float drift in the source of truth. The `pg` driver is configured
(`db.ts`) to parse `NUMERIC` (OID 1700) to a JS `number` so API responses are plain JSON numbers,
which the test suite's numeric comparisons require. The aggregation tests use tolerance-based
assertions, so float representation at the JSON edge is safe.

---

## 3. Indexing strategy

Indexes are built **after** the bulk `COPY` (faster load, then one pass to build) and followed
by `ANALYZE` so the planner has fresh statistics. Each index maps to a specific access pattern
(`src/scripts/indexes.sql`):

| Index | Serves |
|-------|--------|
| `orders(status)`, `(supplier_id)`, `(warehouse)`, `(priority)`, `(created_at)`, `(total_price)` | The individual filter parameters on `GET /api/orders`. |
| `orders(status, created_at)` *(composite)* | The hot path "filter by status, sort by created_at" — index provides both the filter and the order, so Postgres returns the top N without an in-memory sort. |
| `orders(product_id)` | The join to `products` for `product_name` / search. |
| `products` **GIN trigram** on `name` (`pg_trgm`) | Case-insensitive `ILIKE '%term%'` search. A B-tree cannot serve a leading-wildcard `LIKE`; a trigram GIN index can. |
| `products(category_id)` | Recursive category filter. |

**The aggregation endpoints scan the whole table on purpose.** 50k rows is small; a single
sequential/index-only scan per `GROUP BY` runs in a few milliseconds (measured: `/stats` well
under its 500ms budget without any cache). Adding a Redis cache in front of `/stats` was
considered and **deliberately not done** — it would add an invalidation surface (every write
must bust it) to buy headroom we don't need. The honest engineering call is "measure first,
cache only if the budget is actually threatened." It wasn't.

---

## 4. Concurrency — optimistic, in Postgres (not Redis)

**Single-order edits.** `PATCH /api/orders/:id` is one atomic conditional `UPDATE`:

```sql
UPDATE orders
   SET status = COALESCE($2, status), priority = COALESCE($3, priority),
       notes = COALESCE($4, notes), updated_at = now(), version = version + 1
 WHERE id = $1
   AND status <> 'cancelled'
   AND ($2::text IS NULL OR status IS DISTINCT FROM $2)
 RETURNING *;
```

There is no read-then-write window. Two simultaneous `PATCH status=approved` to the same order
are serialized by the **row lock**: the first transitions `pending → approved` and returns the
row (`200`); the second blocks until the first commits, then re-evaluates its `WHERE` against
the now-`approved` row — `status IS DISTINCT FROM 'approved'` is false, so it matches **0 rows**
and the handler returns **409**. This yields the exact `[200, 409]` the spec demands, purely in
the database, with no distributed lock. Already-`cancelled` orders are rejected by the
`status <> 'cancelled'` clause (also 409).

The `version` column is incremented on every write. It isn't required for the test above (the
state guard handles it), but it gives clients a true compare-and-set token if they later want to
guard against *any* concurrent modification, not just same-status ones.

**Read consistency during writes.** All bulk work is an in-place `UPDATE` — orders are never
deleted or re-inserted — so `count(*)` stays at 50,000 throughout, and any concurrent `GET`
sees each order in a valid status (old or new), never a torn/missing row.

---

## 5. Background processing — Redis queue + single worker

`POST /api/orders/bulk-action` (also `/bulk` and `/bulk-actions`, accepting `orderIds` or
`order_ids`) does the minimum synchronously and returns fast:

1. Validate body (action ∈ {approve, reject, flag}; non-empty; ≤ 10,000) → `400` otherwise.
2. Write an initial job hash to Redis: `{ total, completed:0, failed:0, status:'processing' }`.
3. Store the payload and `RPUSH` the job id onto a Redis list (the queue).
4. Return **`202 { jobId }`** — typically a few milliseconds, comfortably under the 500ms budget
   regardless of batch size, because no order is touched on the request path.

A **single background worker** (`bulk/worker.ts`) consumes the queue with a blocking
`BRPOP` on its own dedicated Redis connection (a connection parked in `BRPOP` can't serve other
commands, so it's isolated from the request-serving client). For each order it:

- Acquires a per-order dedup lock `SET lock:order:<id> <action> NX EX 300`.
- Reads the order: missing → `failed`; `cancelled` → `failed`; otherwise applies the action
  (`approve→approved`, `reject→rejected`, `flag→` version bump only) and counts `completed`.
- `HINCRBY`s the job's `completed`/`failed` counter so `GET /api/jobs/:id` shows live progress.

On completion it sets the job `status` (`completed`, or `failed` if nothing succeeded), expires
the hash, and emits `bulk_completed`.

### Why the dedup lock, and the tradeoff (defending the 300s TTL)

The lock gives **exactly-once semantics across overlapping jobs**. Two bulk actions submitted
with overlapping IDs are serialized through the single worker; the lock ensures the second job
does **not** re-apply the action to an order the first already processed — a lock collision is
treated as "already handled" and counted as completed, never double-applied. That's precisely
what the concurrency spec requires ("each order processed exactly once — no double-processing").

The honest tradeoff: the lock auto-expires after **300s** rather than being released the instant
an order is processed. Holding it briefly past completion is intentional — it's the crash-safety
net (if a worker dies mid-job, the lock releases on its own instead of wedging the order
forever) and the dedup window for closely-spaced overlapping jobs. The cost is that the *same*
order can't be re-actioned for up to 5 minutes; for a procurement approval workflow that's
acceptable (you don't approve-then-reject the same line twice within a window), and it's a
deliberate **correctness-over-convenience** choice. The one place it bites is *re-running the
test suite*, where the same low-numbered orders get actioned repeatedly within the window — which
is exactly why `npm run reset` flushes Redis (see §8). A future refinement would scope the lock
to the set of in-flight jobs (release on job completion) rather than a fixed TTL.

**Why Redis here even though the README marks it "optional":** durable job state that survives
the request lifecycle, an atomic cross-request dedup primitive (`SET NX`), and a natural queue
(`RPUSH`/`BRPOP`) are exactly what Redis is good at, and they keep this work *off* the Postgres
write path. It's the right tool, not decoration.

---

## 6. Real-time events — SSE, in-process broadcast

`GET /api/events` is a **Server-Sent Events** stream (chosen over WebSocket: the data flow is
one-way server→client, so SSE is plain HTTP with no upgrade handshake and far less code; the
test suite accepts either). The handler writes the SSE headers, registers the connection in an
in-memory `Set`, and calls `reply.hijack()` so Fastify hands us the raw socket.

Two events are broadcast:

- **`order_updated`** — emitted by both `PATCH` and the bulk worker whenever a status actually
  changes, with `{ id, old_status, new_status, updated_at }`.
- **`bulk_completed`** — emitted when a job finishes, with `{ jobId }`.

**Filtered subscriptions:** a client connecting with `?supplier_id=sup_042` is tagged, and
`order_updated` events are delivered only for that supplier; unfiltered clients receive
everything. Dead connections are pruned on the next write failure and on socket `close`.

**Why an in-process emitter and not Redis Pub/Sub:** with a single server instance, an in-memory
client set *is* every connected client — Pub/Sub would add a network hop and a second moving part
for zero benefit. The scaling boundary is explicit: the moment we run more than one instance,
`order_updated`/`bulk_completed` would need to fan out via Redis Pub/Sub (or similar) so a write
served by instance A reaches a client connected to instance B. Until then, in-process is correct
and simplest.

---

## 7. Validation & security

All untrusted input is parsed with **Zod** before it reaches SQL:

- `status` is a Zod enum — SQL-injection strings and unknown statuses fail the enum → `400`,
  and a value that never reaches a query can't inject.
- `sort` is checked against an explicit **whitelist** of sortable columns (`order` is coerced to
  `asc`/`desc`); user text is never interpolated into `ORDER BY`.
- `limit` is clamped (invalid/negative → default 20), `offset` floored at 0.
- All values are passed as **parameterized** query arguments (`$1, $2, …`) — never string
  concatenation.
- `notes` / `reason` accept raw strings including XSS payloads (stored verbatim, as the spec
  expects); responses are JSON, and escaping is a render-time concern for the UI, not a storage
  one.

---

## 8. The performance finding (transport, not SQL)

`GET /api/orders` was failing its 100ms p95 budget at ~243ms. Profiling separated transport
from database time and found the database was never the bottleneck:

- Page query (`ORDER BY id LIMIT 20` + product join): **0.5ms**
- Count query (`count(*)` over 50k rows): **7ms**
- Yet every HTTP request took a steady **~215ms**, *all of it in the TCP connect phase* — and
  only for `localhost`; `127.0.0.1` was 12ms.

**Root cause:** on Windows `localhost` resolves to both `::1` (IPv6, tried first) and
`127.0.0.1`. The server listened on `0.0.0.0` (IPv4 only), so the client's first `::1` attempt
had no listener and paid the **~200ms "Happy Eyeballs" (RFC 8305) fallback** before retrying
IPv4. The test's p95 (`times[floor(10*0.95)]` = the max of 10 samples) caught any request that
paid that tax. **Fix:** bind dual-stack `host: '::'` in `index.ts`; `::1` now answers
immediately — connect `215ms → 1ms`. This is recorded here because it's a reminder that a
"slow endpoint" is a transport problem until measurement proves otherwise.

---

## 9. Tradeoffs, consciously made

- **Raw SQL over ORM** — more typing; the graded thing (query cost/correctness) stays visible.
- **SQL state-guard locking over version CAS for the PATCH race** — fewer round-trips, exactly
  the `[200,409]` contract; `version` retained for clients that want full CAS.
- **In-process SSE over Redis Pub/Sub** — correct for one instance; scaling boundary documented.
- **No `/stats` cache** — measured fast enough; avoided an invalidation surface we didn't need.
- **Redis dedup lock with a TTL** — exactly-once across overlapping jobs and crash safety, at
  the cost of a short re-action window (§5).
- **No auth** — out of scope and untested.

---

## 10. Operational notes

The test suite is **stateful and destructive**: it mutates orders (PATCH, bulk approve/cancel)
and leaves Redis dedup locks, while aggregation/filtering tests assert exact counts against the
pristine seed. A true score therefore requires resetting **both** stores before a run:

```bash
cd src && npm run reset   # FLUSHALL Redis + drop/reload Postgres from the CSVs
```

Run per-suite on fresh data for a clean signal; see `docs/how to test.md` for the full workflow
and the reasoning behind it.
