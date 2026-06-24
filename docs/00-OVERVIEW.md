# 00 — Overview & Reading Order

This `docs/` folder is the **thinking** behind the assignment, written so you can defend
every decision in a review with an opinion, not just "it passed the test."

> The assignment's own rule (README tip #6): *"The `tests/*.test.ts` files are the
> authoritative specification. When the README and a test disagree, the test is right."*
> So everything here is derived from the **tests**, not just the prose.

## Read these in order

| File | What it gives you |
|------|-------------------|
| `00-OVERVIEW.md` | This file — the map and the scoring strategy |
| `01-SPEC-FROM-TESTS.md` | The *real* contract, distilled from the 83 tests, including 3 traps the README hides |
| `02-ARCHITECTURE.md` | The proposed system: stack, layers, schema, indexes, concurrency, jobs, events |
| `03-REDIS-EXPLAINED.md` | Redis from zero → where we use it here and **why**, with honest opinions on where *not* to |
| `04-DATA-NOTES.md` | The intentional landmines in the CSVs and how each maps to a feature |
| `05-BUILD-PLAN.md` | The exact order to build in so tests go green incrementally |

## The scoreboard (what we're optimizing)

145 points total: **115 automated** + **30 qualitative**.

```
Automated (115)                          Qualitative (30)
├─ Basic CRUD ............ 15  (easy)    ├─ Code quality ......... 10
├─ Filtering ............. 10  (easy)    ├─ Frontend UX .......... 10
├─ Aggregations .......... 20  (medium)  ├─ ARCHITECTURE.md ...... 5
├─ Anomaly detection ..... 15  (medium)  └─ ANOMALY_STRATEGY.md .. 5
├─ Bulk operations ....... 15  (hard)
├─ Concurrency ........... 15  (hard)
├─ Performance ........... 10  (cross-cutting)
├─ Real-time ............. 10  (medium)
└─ Security ...............  5  (easy)
```

**Strategy opinion:** the points-per-hour is highest in CRUD → Filtering → Aggregations →
Anomalies (60 pts, mostly straightforward once the schema + indexes are right). Bulk +
Concurrency + Real-time (40 pts) are where the engineering judgment shows and where Redis
earns its place. Do them in the order in `05-BUILD-PLAN.md`, not the README order — the
README order would have you build the frontend before the hard backend is proven.

## The one-paragraph architecture

A **Node + TypeScript + Fastify (or Express)** API on port 3000, backed by **PostgreSQL 16**
for all source-of-truth data (orders, suppliers, products, categories), with **Redis 7**
used for exactly two jobs: (1) the **background job queue + per-order dedup lock** that powers
bulk actions, and (2) an **optional short-TTL cache** for the heavy `/stats` aggregation.
Concurrency on single-order edits is handled in Postgres with an **optimistic-lock version
column** (not Redis). Real-time `/api/events` is **SSE** broadcast from an in-process emitter.
A **React + TypeScript + Vite** frontend consumes it. Full reasoning in `02` and `03`.
