# 05 — Build Plan (the order to actually write code in)

Build so the test suite goes green **incrementally** — never spend an hour without a passing
test to show for it. The vitest config runs files in this order: basic → filtering → security →
aggregations → anomalies → bulk → performance → concurrency → realtime. We build roughly along
that grain, with infra first.

Run progress checks with the per-category scripts (`cd tests && npm run test:basic`, etc).

---

## Phase 0 — Infra & import (no points yet, unblocks everything)
1. `docker-compose up -d` → Postgres + Redis healthy.
2. `src/scripts/schema.sql` — tables from `02` (no indexes yet).
3. `src/scripts/import.ts` — `COPY` the 4 CSVs in FK order (`04`).
4. Run the smoke counts in `04` (50000 / 500 / 5000 / 1512). **Do not proceed until these match.**
5. Add the indexes from `02`, then `ANALYZE`.

## Phase 1 — Server skeleton + Basic CRUD  → `test:basic` (15 pts)
6. Fastify on `:3000`; JSON content-type default; `envelope.ts` (`paginate`, `error`).
7. **Register literal routes before `:id`** (`/orders/stats`, `/orders/anomalies` first) — Trap 2.
8. `GET /api/orders` (paginate, default limit 20), `GET /api/orders/:id` (join supplier+product
   names, 404), `PATCH /api/orders/:id` (400 invalid status via Zod enum, 409 if cancelled).
9. `GET /api/suppliers` + `/:id` (computed `order_count`, `total_revenue`, 404).
10. `GET /api/products` + `?category=` **recursive cycle-safe CTE** (Trap 3).
11. Unknown route → 404 JSON; error shape `{error, code}`.

## Phase 2 — Filtering & Search → `test:filter` (10 pts)
12. Query builder: `status` (CSV), `priority`, `supplier_id`, `warehouse`, `date_from/to`,
    `min_total`, `search` (ILIKE on joined product_name — needs the join), `sort`+`order`
    (whitelisted columns), `limit`/`offset`.
13. Confirm `supplier_id=sup_042` returns `total > 1000` and `search=hydraulic` works.

## Phase 3 — Security → `test:security` (5 pts)  *(cheap, do it now while validation is fresh)*
14. SQL-injection in `status` → 400 (Zod enum already does this). `limit=-1` → clamp ≤100 or 400.
15. Bulk-body validation stub returning 400 for >10000 / empty / bad action (full bulk in Phase 5).
16. XSS in `notes`/`reason` accepted as raw string; response stays JSON.

## Phase 4 — Aggregations → `test:agg` (20 pts)
17. `/api/orders/stats`: by_status, by_month (`to_char 'YYYY-MM'`, 24 entries), top_suppliers
    (exactly 10 desc), by_warehouse (`COALESCE` → 'unassigned'), totals. Check vs `expected-values.json`.
18. `/api/suppliers/:id/performance`: avg_delivery_days, rejection_rate, avg_order_value,
    monthly_trend (24), price_consistency (join to product base price, within 20%).

## Phase 5 — Anomalies → `test:anomaly` (15 pts)
19. Single pass query computing the 4 required flags + 3 bonus; assemble `anomaly_types[]` +
    `severity`. Verify the `sample_*_ids` from `expected-values.json` all appear. Write
    `ANOMALY_STRATEGY.md` as you go (severity logic + patterns found).

## Phase 6 — Redis + Bulk + Jobs → `test:bulk` (15 pts)
20. `redis.ts` (ioredis; separate client for blocking pop). Job hash + queue + worker (`03`).
21. Bulk handler on **all three paths** (`/bulk`, `/bulk-action`, `/bulk-actions`), accept
    `orderIds`||`order_ids`, return **both** `{jobId, job_id}` — Trap 1. 202 in <500ms.
22. Worker: per-order `SET NX EX` dedup lock, UPDATE in place, count completed/failed
    (missing + already-cancelled → failed). `GET /api/jobs/:id` reads hash, casts numbers.

## Phase 7 — Concurrency → `test:concurrent` (15 pts)
23. Add `version` column + optimistic `UPDATE … WHERE version=$` → 409 on lose. Already covered
    most of bulk overlap via the dedup lock; verify both-jobs-complete + per-job totals.
24. Verify reads stay consistent during bulk (we only UPDATE in place, never delete → total stays 50000).

## Phase 8 — Real-time → `test:realtime` (10 pts)
25. `events.ts`: EventEmitter + SSE endpoint `GET /api/events` writing `data: {json}\n\n`.
26. Emit `order_updated` from PATCH and bulk worker; `bulk_completed` on job finish. Support
    `?supplier_id=` filtering. Broadcast to all clients.

## Phase 9 — Performance pass → `test:perf` (10 pts)
27. With indexes in place, measure p95. If `/stats` flirts with 500ms, add the Redis cache-aside
    + invalidate-on-write (`03` Place B). Confirm all 6 budgets.

## Phase 10 — Frontend (qualitative, 10 pts UX)
28. Vite React app: Orders table (server pagination, filters, sort, search, multiselect + bulk),
    Analytics dashboard (status dist / monthly trend / top suppliers via Recharts), Supplier
    detail + performance, Bulk progress UX. Loading/Error/Empty states everywhere.

## Phase 11 — Docs & polish (qualitative, 10 pts)
29. Finalize `ARCHITECTURE.md` (lift from `02`) and `ANOMALY_STRATEGY.md` (from Phase 5).
30. **Commit frequently** (README tip #4 — git history is reviewed). One commit per phase minimum.

---

## Definition of done
`cd tests && npm test` → 83/83 (or as close as time allows), all p95 budgets met, frontend
handles the 3 states, both markdown docs written. Then re-read `03` so you can talk about Redis
without notes.
