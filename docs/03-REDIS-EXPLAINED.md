# 03 — Redis, From Zero, For This Assignment

You said it's your first time with Redis. This file takes you from "what even is it" to
"here's exactly where we use it and why I'd defend that in the interview." Read it slowly; it's
the part you'll get asked about.

---

## 1. What Redis actually is

Redis is an **in-memory key-value store**. Think of it as a giant `Map` / dictionary that lives
in its own process (or its own server), that *any* part of your app — or any number of separate
server processes — can read and write over a network connection.

Two properties make it special:

1. **It's in RAM**, so reads/writes are sub-millisecond. Postgres goes to disk; Redis doesn't.
2. **Its operations are atomic and single-threaded.** Redis runs one command at a time, start to
   finish, with nothing interleaved. That's the secret sauce for concurrency primitives — more below.

It is **not** a replacement for Postgres. Postgres is your durable, relational, queryable source
of truth. Redis is a fast scratchpad for things that are *ephemeral, hot, or coordination-related*.
The mental model: **Postgres = the filing cabinet, Redis = the sticky notes on your monitor.**

### The handful of Redis data types we care about

| Type | Like | Command examples | We use it for |
|------|------|------------------|---------------|
| String | a single value | `SET k v`, `GET k`, `SET k v EX 30` (with 30s expiry) | the stats cache |
| Hash | an object/dict | `HSET job total 1000`, `HGETALL job` | job progress record |
| List | a queue/array | `LPUSH q x`, `BRPOP q` (blocking pop) | the job queue |
| Set | unique members | `SADD s x`, `SISMEMBER s x` | (alt) processed-order set |
| String + NX | "set only if absent" | `SET lock:ord_1 1 NX EX 60` | the dedup lock |

`EX`/`TTL` = **time to live**. You can tell a key to auto-delete after N seconds. This is huge: a
finished job's status can expire on its own, so Redis never fills up with stale data.

---

## 2. The "single-threaded + atomic" idea (why it matters here)

The hardest test in this assignment: *two bulk jobs with overlapping order IDs — each order must
be processed exactly once.* How do you guarantee that when two background workers might grab the
same order at the same moment?

In a normal multi-threaded world you'd reach for locks and pray. In Redis it's one line:

```
SET lock:ord_00012 <jobId> NX EX 300
```

`NX` means **"only set this key if it does NOT already exist."** Because Redis does one command at
a time, exactly **one** of the two competing workers' `SET … NX` succeeds and gets back `OK`; the
other gets back `nil`. The winner processes the order; the loser sees `nil` and skips it. No race,
no torn writes, no double-processing — and it's atomic *for free* because Redis is single-threaded.

That single property — "set if absent, atomically" — is the whole reason Redis is the *right* tool
for the dedup requirement, and it's the thing to say out loud in a review.

---

## 3. Where we use Redis in THIS project (exactly two places)

### Place A — Background job queue + progress + dedup (the real win)

This powers `POST /api/orders/bulk*` and `GET /api/jobs/:id`. Flow:

```
Client                API (request thread)              Redis                 Worker (background)
  │  POST bulk          │                                 │                      │
  │────────────────────>│ validate (400s here)            │                      │
  │                     │ jobId = nanoid()                 │                      │
  │                     │ HSET job:<id> total=N completed=0 failed=0 status=processing
  │                     │ RPUSH jobqueue <id>  ───────────>│                      │
  │  202 {jobId,job_id} │                                  │   BRPOP jobqueue ───>│ wakes up
  │<────────────────────│  (returns in ~5ms, well <500ms)  │                      │ for each orderId:
  │                     │                                  │   SET lock:ord NX ──>│  won? UPDATE pg, completed++
  │  GET /api/jobs/:id  │                                  │                      │  lost/cancelled/missing? failed++
  │────────────────────>│ HGETALL job:<id> ──────────────>│                      │ on done: status=completed,
  │  {status,progress}  │                                  │                      │   emit bulk_completed
```

Why each Redis piece earns its place:
- **The queue (`RPUSH`/`BRPOP`)** decouples "accept the request" from "do the work," which is the
  *entire point* of the < 500ms-for-10000-items rule. The HTTP handler does nothing but validate +
  enqueue + return.
- **The job hash (`HSET`/`HGETALL`)** is shared state the polling endpoint reads. If the API and
  worker were ever separate processes, in-memory wouldn't work — Redis is the shared truth. It also
  gets a TTL so completed jobs clean themselves up.
- **The per-order lock (`SET NX EX`)** gives exactly-once across overlapping jobs (section 2). The
  `EX` (expiry) means a crashed worker's lock auto-releases instead of jamming the order forever.

> **In production** you'd reach for **BullMQ** (a battle-tested Redis-backed queue: retries, dead-letter,
> concurrency control, dashboards). For this assignment a hand-rolled `RPUSH/BRPOP` + hash is enough
> and shows you understand the primitive instead of hiding behind a library. Mention BullMQ as "what
> I'd use with more time / in prod" — that's the kind of opinion reviewers want.

### Place B — Cache for `/api/orders/stats` (optional, p95 insurance)

The stats endpoint scans 50k rows and has a 500ms p95 budget. With the indexes in `02`, Postgres
does this in well under 500ms anyway — so caching is **not required for correctness**. But:

```
GET /api/orders/stats
  → GET stats:v1 from Redis
      hit?  return it (sub-ms)
      miss? run the aggregation SQL, SET stats:v1 <json> EX 60, return it
On any write (PATCH / bulk): DEL stats:v1   (so the cache can't go stale and break the
                                             "total_orders stays 50000" consistency test)
```

**My honest opinion:** for 50k rows this is gold-plating, and a *stale* cache is actually a risk
for the concurrency test that asserts consistent reads during writes — which is exactly why we pair
it with **invalidate-on-write** (`DEL`). I'd implement it because (a) it makes p95 rock-solid under
the 50-concurrent-request stress test, and (b) it demonstrates the cache-aside pattern + the
invalidation discipline that separates "I used a cache" from "I used a cache correctly." If time is
short, skip it — the indexes carry the budget.

---

## 4. Where we deliberately DON'T use Redis (and why that's the senior call)

This section is worth more in a review than the places we *do* use it — knowing the boundary is the
skill.

| Tempting Redis use | Why we don't | What we use instead |
|--------------------|--------------|---------------------|
| **Optimistic locking** on single-order PATCH (the `[200,409]` test) | The data already lives in Postgres; a `version` column gives atomic compare-and-set in the same transaction as the write. Doing it in Redis would split the source of truth and create a window where Redis and Postgres disagree. | Postgres `UPDATE … WHERE id=$ AND version=$` (see `02`). |
| **Pub/Sub for `/api/events`** | We run **one** Node process. An in-memory `EventEmitter` reaches every connected SSE client already. Redis Pub/Sub only adds value when you have **multiple server instances** that each hold some of the client connections and need to hear each other's events. | In-process `EventEmitter` → SSE broadcast. |
| **Storing the orders themselves** | Redis isn't relational; you'd lose joins, filtering, aggregation — everything the assignment grades. | Postgres. |

The scaling boundary to state out loud: *"The moment we run more than one API instance behind a
load balancer, two things move to Redis — the event fan-out becomes Redis Pub/Sub so an event
triggered on instance A reaches a client connected to instance B, and the in-memory emitter is no
longer sufficient. Until then it's needless complexity."* That sentence is the whole point.

---

## 5. The library and the gotchas

- Use **`ioredis`** (robust, promise-based, supports `BRPOP` blocking + separate connections).
- **One connection can't do blocking reads and normal commands at once.** A connection parked in
  `BRPOP` is busy. So: one client for the worker's blocking pop, a separate client for everything
  else (and a third if you add Pub/Sub, since a subscriber connection can't issue normal commands).
- **Numbers come back as strings.** `HGETALL` gives you `{ total: "1000", completed: "450" }` —
  cast to `Number()` before returning JSON, or the test's `typeof === 'number'` check fails.
- **Always set a TTL** on job hashes and the cache so Redis doesn't grow unbounded.
- Redis here is dev-only and provided via `docker-compose`; connect to `localhost:6379`, no auth.

---

## 6. The 30-second version (for when you're asked)

> "Postgres is my source of truth. I use Redis for exactly two things. First, it's the backbone of
> background bulk processing: a list as the job queue, a hash for live progress that the polling
> endpoint reads, and a `SET NX` per-order lock that gives me exactly-once processing across
> overlapping batches for free — because Redis is single-threaded, only one worker can claim a key.
> Second, an optional cache-aside layer on the stats endpoint with invalidate-on-write, as p95
> insurance. I deliberately keep optimistic locking in Postgres with a version column and event
> fan-out in an in-process emitter, because with a single instance Redis would just split my source
> of truth — I'd move event fan-out to Redis Pub/Sub the day we scale past one instance."
