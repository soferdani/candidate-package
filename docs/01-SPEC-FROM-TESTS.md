# 01 — The Real Spec (distilled from the tests)

The README is the *brochure*. The tests are the *contract*. This file is the contract,
with the gaps and traps the README doesn't mention called out explicitly.

---

## ⚠️ Trap 1 — The bulk endpoint is specified THREE different ways

This is the single biggest gotcha. Different test files hit different paths with different
field names and expect different response key casing. **You must support all of them.**

| Test file | Path | Request body | Response key |
|-----------|------|--------------|--------------|
| `bulk-operations.test.ts` | `POST /api/orders/bulk-action` | `{ orderIds, action, reason? }` | `{ jobId }` |
| `concurrency.test.ts` | `POST /api/orders/bulk-actions` | `{ order_ids, action }` | `{ job_id }` |
| `realtime.test.ts` | `POST /api/orders/bulk` | `{ action, orderIds }` | (reads event, not body) |
| `security.test.ts` | `POST /api/orders/bulk` | `{ action, orderIds, reason }` | status only |

**Plan:** one handler, registered on **all three paths** (`/bulk`, `/bulk-action`,
`/bulk-actions`). It accepts `orderIds` **or** `order_ids`. It returns **both** keys in the
response object: `{ jobId: id, job_id: id }`. Cheap insurance, removes the whole class of failure.

`GET /api/jobs/:id` returns `{ status, progress: { total, completed, failed } }` — this one
is consistent everywhere (see `tests/helpers/poll.ts`).

---

## ⚠️ Trap 2 — Route ordering: `/stats` and `/anomalies` vs `/:id`

`GET /api/orders/stats` and `GET /api/orders/anomalies` must be registered **before**
`GET /api/orders/:id`. If `:id` is declared first, a request for `/api/orders/stats` matches
`:id="stats"` and you 404. Register literal routes before parameterized ones.

---

## ⚠️ Trap 3 — `category` count mismatch & circular hierarchies

README says 195 categories; `expected-values.json` says `counts.categories = 193`, and the
tips warn of **circular category hierarchies**. The recursive product-by-category query
(`/api/products?category=cat_001`) **must not infinite-loop**. Use a recursive CTE with
**cycle detection** (`UNION` + a visited-path guard, or Postgres `CYCLE` clause). The count
test only checks suppliers/products/orders, but the recursion must survive a cycle.

---

## Endpoint contract (the authoritative list)

### Response envelopes
- **List:** `{ "data": [...], "total": <n>, "limit": <n>, "offset": <n> }`
- **Error:** `{ "error": "<human string>", "code": "<CODE>" }` — `error` MUST be a string.
- Every response: `Content-Type: application/json` (yes, even errors and 404s).

### Core CRUD
| Method | Path | Must do | Failure modes tested |
|--------|------|---------|----------------------|
| GET | `/api/orders` | paginated, default `limit=20` | — |
| GET | `/api/orders/:id` | include joined `supplier_name`, `product_name` | 404 if missing |
| PATCH | `/api/orders/:id` | update status/priority/notes | 400 invalid status, 409 if already `cancelled`, 409 on concurrent write |
| GET | `/api/suppliers` | paginated | — |
| GET | `/api/suppliers/:id` | include computed `order_count`, `total_revenue` | 404 if missing |
| GET | `/api/products` | paginated | — |
| GET | `/api/products?category=cat_001` | **recursive** child categories; result spans >1 `category_id` | — |
| GET | `/api/orders/stats` | dashboard aggregate (see below) | — |
| GET | `/api/suppliers/:id/performance` | per-supplier metrics | — |
| GET | `/api/orders/anomalies` | flagged records | — |
| POST | `/api/orders/bulk` \| `/bulk-action` \| `/bulk-actions` | async, 202, `{jobId, job_id}` | 400 empty/invalid/>10000 |
| GET | `/api/jobs/:id` | job status + progress | — |
| GET/WS | `/api/events` | SSE or WS stream | — |

Valid statuses: `pending, approved, rejected, shipped, delivered, cancelled`.
Valid bulk actions: `approve, reject, flag`.

### Filtering on `/api/orders` (all combinable)
`status` (single or `a,b` CSV) · `priority` · `supplier_id` · `warehouse` ·
`date_from`/`date_to` (inclusive on `created_at`) · `min_total` (`>=`) ·
`search` (case-insensitive on **joined product_name**) · `sort`+`order` (asc/desc) ·
`limit`/`offset`.

> Note from `filtering.test.ts`: `supplier_id=sup_042` expects `total > 1000`. `search=hydraulic`
> filters on the **product name**, which means the orders list query needs a join to products.

### Aggregations — exact expectations (`expected-values.json`)
- `total_orders` = **50000** (exact). `total_revenue` ≈ 2,318,108,880 (`toBeCloseTo(…, 0)`).
- `by_status`: exact `count` per status; `total_value` close (precision 0).
- `by_month`: **24 entries**, `"YYYY-MM"`, chronological, each `{month, order_count, revenue}`.
- `top_suppliers`: **exactly 10**, sorted by `total_revenue` desc.
- `by_warehouse`: 6 entries; null/empty warehouse bucketed as `"unassigned"` (count 1512).
- Supplier performance (`sup_042`): tolerances are **±20%**, so these don't need to be exact:
  `avg_delivery_days≈9.41`, `rejection_rate≈0.091`, `monthly_trend` length **24** (exact),
  `price_consistency≈0.6486` (fraction of orders where `unit_price` within 20% of product base price).

### Anomalies — what the tests actually check
Required (must produce these): `price_mismatch`, `inactive_supplier`, `negative_quantity`,
`timestamp_anomaly`. The timestamp test matches any type containing `timestamp`/`date`/`time_travel`
and wants **≥ 80% of 208** of them. Specific sample order IDs must appear (see `expected-values.json`
→ `sample_*_ids`). Bonus (each just needs `length > 0`): `price_spike`, `after_hours`, `risky_supplier`.
Each record: `{ order_id, anomaly_types: string[], severity: 'low'|'medium'|'high' }`.

### Bulk — the rules that bite
- Respond **< 500ms** regardless of batch size up to 10,000 → work happens in background.
- Empty `orderIds` → 400. Invalid action → 400. > 10,000 IDs → 400.
- Non-existent IDs and already-`cancelled` orders count as **`failed`**, not errors.
- `progress.total` = number of IDs submitted (per job — see concurrency test: each job reports its own 7).
- Overlapping batches: each order processed **exactly once** globally, but **both jobs complete**
  and each reports its own total. This is the dedup requirement → `03-REDIS-EXPLAINED.md`.

### Concurrency — the rules that bite
- Two simultaneous `PATCH` to the same order: results sorted must equal `[200, 409]`. The 409
  body must have an `error` field. → optimistic locking with a version column.
- During a bulk job: `/api/orders/stats` still returns `total_orders === 50000`; an individual
  order always has a valid status. → never delete/re-insert; only `UPDATE` in place.
- Stress: 50 concurrent `GET /api/orders` each < 500ms; 10 concurrent PATCH to *different*
  orders all 200.

### Real-time — what the client does (`helpers/events-client.ts`)
- Client tries **WebSocket first**, falls back to **SSE**. Either passes. SSE is simpler → we pick SSE.
- SSE format the client parses: lines starting with `data: ` containing a JSON
  `{ type, data }`. (So: `data: {...}\n\n`.)
- Events: `order_updated` `{ id, old_status, new_status, updated_at }` on any status change
  (single PATCH **and** bulk). `bulk_completed` `{ jobId }` when a job finishes.
- Filtered connect: `?supplier_id=sup_042` → only that supplier's `order_updated` events.
- Broadcast: every connected client gets the same (unfiltered) events.

### Security — what's checked
- SQL injection in `status` → 400 (validate against the enum; never string-concat SQL — use params).
- `limit=-1` → either 400, or 200 with length clamped ≤ 100.
- Bulk with 10001 IDs → 400.
- XSS payload in `notes`/`reason` is **stored/accepted as-is** and returned as a string
  (escaping is the frontend's job at render time; the API must not choke). Content-Type stays JSON.

### Performance budgets (p95 over 10 runs)
`/api/orders` < 100ms · `?status=&sort=` < 200ms · `?search=` < 300ms · `/stats` < 500ms ·
`/suppliers/:id/performance` < 500ms · `/anomalies` < 1000ms. → **indexes are mandatory**, see `02`.
