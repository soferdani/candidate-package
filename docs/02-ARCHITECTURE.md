# 02 — Proposed Architecture

This is the design we'll implement. It doubles as the skeleton for the required
`ARCHITECTURE.md` submission — but here every choice carries the *why* so you can defend it.

---

## Stack choice

| Layer | Pick | Why this and not the alternative |
|-------|------|----------------------------------|
| Runtime | **Node 20 + TypeScript** | README offers Node or .NET; the tests are TS, the data tooling is JS-friendly, and types catch the envelope-shape bugs that cost points. |
| HTTP | **Fastify** | ~2× Express throughput, first-class JSON schema validation (helps the security tests), built-in SSE-friendly streaming. Express is fine too; Fastify just gives perf headroom for the p95 budgets for free. |
| DB driver | **`pg`** (node-postgres) with a Pool | Raw SQL + a thin query layer beats an ORM here: the aggregations and recursive CTE are far clearer in SQL, and we control exactly which index is used. An ORM would hide the thing being graded (perf). |
| DB | **PostgreSQL 16** (provided) | Source of truth for everything. |
| Cache/queue | **Redis 7** (provided) | Job queue + dedup locks; optional stats cache. See `03`. |
| Realtime | **SSE** | Tests accept WS or SSE; SSE is plain HTTP, no extra deps, trivial to broadcast. |
| Frontend | **React + TypeScript + Vite** | Fast dev server, simple build. Charts via Recharts. |

**Validation library:** **Zod** for request parsing (query params, bulk body). Centralizes the
400s (invalid status, bad limit, oversized batch) and keeps SQL injection impossible because
nothing unvalidated reaches a query.

---

## Project structure (inside `src/`)

```
src/
├── server/
│   ├── index.ts            # Fastify bootstrap, listens on :3000, registers routes IN ORDER
│   ├── db.ts               # pg Pool, query helpers
│   ├── redis.ts            # ioredis client(s) — one normal, one for pub/sub if used
│   ├── events.ts           # in-process EventEmitter + SSE broadcaster
│   ├── routes/
│   │   ├── orders.ts       # list/get/patch/stats/anomalies  (literal routes before :id!)
│   │   ├── suppliers.ts    # list/get/performance
│   │   ├── products.ts     # list + recursive category filter
│   │   ├── bulk.ts         # the 3 bulk paths -> enqueue -> 202
│   │   ├── jobs.ts         # GET /api/jobs/:id
│   │   └── events.ts       # GET /api/events (SSE)
│   ├── services/
│   │   ├── orders.service.ts
│   │   ├── stats.service.ts      # the heavy aggregation SQL (+ optional cache)
│   │   ├── anomalies.service.ts
│   │   └── bulk.worker.ts        # consumes the queue, dedup, updates, emits events
│   └── lib/
│       ├── validation.ts   # Zod schemas, status/action enums
│       └── envelope.ts     # paginate() and error() helpers
├── scripts/
│   ├── schema.sql          # tables + indexes
│   └── import.ts           # CSV -> Postgres via COPY (streaming, handles edge cases)
└── web/                    # React app (separate Vite project or subfolder)
```

---

## Database schema

```sql
-- categories: self-referential, may contain cycles
CREATE TABLE categories (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id TEXT            -- nullable for roots; may form a cycle (handle in query)
);

CREATE TABLE suppliers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  rating     NUMERIC,       -- nullable: some rows have blank rating
  country    TEXT,
  active     BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ
);

CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id),
  sku         TEXT,
  price       NUMERIC NOT NULL      -- base/catalog price; used by anomalies & price_consistency
);

CREATE TABLE orders (
  id          TEXT PRIMARY KEY,
  supplier_id TEXT REFERENCES suppliers(id),
  product_id  TEXT REFERENCES products(id),
  quantity    INTEGER,              -- can be NEGATIVE (returns) — do not constrain > 0
  unit_price  NUMERIC,
  total_price NUMERIC,              -- sometimes intentionally != qty*unit_price
  status      TEXT NOT NULL,
  priority    TEXT,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,          -- sometimes < created_at (anomaly)
  warehouse   TEXT,                 -- nullable/empty -> 'unassigned' in stats
  notes       TEXT,                 -- may contain XSS payloads; store raw
  version     INTEGER NOT NULL DEFAULT 0   -- optimistic lock counter
);
```

**Money type note:** use `NUMERIC` for prices to avoid float drift, but the API returns plain
JSON numbers — the `toBeCloseTo(…, 0)` tolerance in the agg tests means we don't need penny-perfect,
but `NUMERIC` keeps us safe and the SUMs honest.

### Indexes (this is where the perf points live)

```sql
CREATE INDEX idx_orders_status      ON orders(status);
CREATE INDEX idx_orders_supplier    ON orders(supplier_id);
CREATE INDEX idx_orders_warehouse   ON orders(warehouse);
CREATE INDEX idx_orders_priority    ON orders(priority);
CREATE INDEX idx_orders_created_at  ON orders(created_at);
CREATE INDEX idx_orders_total_price ON orders(total_price);
-- composite for the common "status + sort by created_at" hot path (perf test #2)
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
-- trigram index for case-insensitive product_name search (perf test #3)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_category  ON products(category_id);
```

**Why these specifically:** each maps to a test. `status`/`supplier`/`warehouse`/`created_at`
back the filter tests. `idx_orders_status_created` backs the 200ms `status + sort` budget so
Postgres doesn't sort 7.5k rows in memory. `pg_trgm` GIN index backs the 300ms `ILIKE
'%hydraulic%'` search — a plain b-tree can't serve a leading-wildcard `LIKE`, trigram can.
Aggregations scan the whole table anyway (50k rows is small); the index that matters there is
just keeping the scan to a single pass, plus the optional Redis cache.

---

## How each hard requirement is handled

### Pagination & filtering
One query builder composes a `WHERE` from validated params + a `JOIN products` (needed for
`search` and to return `product_name`). `total` comes from a `COUNT(*) OVER()` window or a
second cheap count. Sort column is whitelisted (never interpolate user text into ORDER BY).

### Aggregations (`/stats`)
A small number of `GROUP BY` queries (by_status, by_month via `to_char(created_at,'YYYY-MM')`,
by_warehouse with `COALESCE(NULLIF(warehouse,''),'unassigned')`, top_suppliers via join+order+limit
10). 50k rows → a few ms each. **Optional** Redis cache with ~30–60s TTL in front, invalidated on
any write, purely as p95 insurance. See `03` for the honest take on whether it's needed.

### Supplier performance
Per-supplier filtered aggregates. `price_consistency` joins orders→products and counts the
fraction where `abs(unit_price - price)/price <= 0.20`.

### Anomaly detection
A single pass: one SQL query (or a few `UNION`ed selects) that LEFT JOINs suppliers/products and
computes each flag as a boolean expression, then we assemble `anomaly_types[]` + `severity` in
code. Severity logic lives in `ANOMALY_STRATEGY.md`. 50k rows under the 1000ms budget easily.

### Optimistic locking (concurrency)
`PATCH` does `UPDATE orders SET status=$1, version=version+1, updated_at=now()
WHERE id=$2 AND version=$3 RETURNING *`. We read the current version first (or the client never
sees it — so we read-then-write inside the handler). If `rowCount === 0`, someone else won the
race → **409**. Two simultaneous PATCHes: first commits version 0→1, second's `WHERE version=0`
matches nothing → 409. This gives the exact `[200, 409]` the test wants **without Redis**.
Already-`cancelled` is a separate pre-check → also 409.

### Background jobs (bulk)
Endpoint validates, creates a `jobId`, writes initial job state to Redis, **enqueues** the work,
returns `202` immediately (well under 500ms). A worker drains the queue, processes each order,
updates progress in Redis, and on finish emits `bulk_completed`. Full mechanics + the
exactly-once dedup in `03`.

### Real-time events
`src/server/events.ts` holds a Node `EventEmitter` and a set of connected SSE responses. PATCH
and the bulk worker call `emit('order_updated', …)`; the SSE layer writes `data: {json}\n\n` to
every connected client (or only matching ones if they connected with `?supplier_id=`).
`bulk_completed` emitted when a job finishes. Single-process, so an in-memory emitter is correct
and simplest; Redis Pub/Sub only becomes necessary with >1 server instance (discussed in `03`).

---

## Tradeoffs we're consciously making
- **Raw SQL over ORM:** more typing, but the graded thing (perf, correctness of aggregates) is
  visible and tunable. Worth it.
- **SSE over WebSocket:** one-way is all the tests need; SSE is less code and no upgrade handshake.
- **In-process emitter over Redis Pub/Sub:** correct for a single instance, far simpler. We note
  the scaling boundary instead of over-engineering.
- **Redis for jobs even though "optional":** it's the honest tool for durable job state + atomic
  dedup, and demonstrates the skill the assignment is probing. See `03`.
- **No auth:** out of scope; not tested.
