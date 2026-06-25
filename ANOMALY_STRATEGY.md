# ANOMALY DETECTION STRATEGY

`GET /api/orders/anomalies` scans all 50,000 orders in a **single pass** and returns every
flagged order with the rules it matched and a severity. Each flag is a boolean SQL expression
evaluated in one query (with `LEFT JOIN`s to `suppliers` and `products`); the row assembly and
severity classification happen in code (`src/server/routes/orders.ts`). The whole endpoint runs
comfortably under its 1000ms budget.

---

## Rules implemented

### Required (all four)

| Rule | Condition | Notes |
|------|-----------|-------|
| `price_mismatch` | `abs(total_price - quantity*unit_price) > 0.01` | Stored total disagrees with line math. ~992 orders. |
| `inactive_supplier` | supplier `active = false` | Inactive suppliers still placing orders. ~2,247 orders. |
| `negative_quantity` | `quantity < 0` | Returns encoded as negative lines. ~507 orders. |
| `timestamp_anomaly` | `updated_at < created_at` | Impossible ordering of timestamps. ~208 orders. |

### Bonus (all three)

| Rule | Condition | Notes |
|------|-----------|-------|
| `price_spike` | `unit_price > product.price * 3` (and base price > 0) | Charged far above catalog price. ~1,486 orders. |
| `after_hours` | `created_at` hour (UTC) ≥ 22 or < 06 | Created outside business hours. ~16,677 orders. |
| `risky_supplier` | supplier where > 50% of their orders are anomalous | Computed with a windowed pre-pass (below). |

`risky_supplier` is derived, not row-local: a first CTE computes, per supplier, the fraction of
their orders carrying any required anomaly, and flags suppliers above 50%. Orders belonging to
those suppliers get the `risky_supplier` tag added.

---

## Inclusion policy (a deliberate decision)

An order is **included in the response** if it matches any of: `price_mismatch`,
`inactive_supplier`, `negative_quantity`, `timestamp_anomaly`, or `price_spike`.

`after_hours` is intentionally **not** an inclusion trigger. It matches ~16,677 orders (a third
of the dataset) — treating "ordered at night" as a standalone anomaly would bury the genuinely
broken records (~3,881 orders) in noise and bloat the payload against the 1s budget. Instead,
`after_hours` is reported as a **modifier tag** on orders already flagged for a real reason. It
adds context ("this bad order also happened at 3am") without drowning the signal. This keeps the
returned set focused on the ~3,881 truly anomalous orders the data was seeded with.

---

## Severity classification

An order can match multiple rules; severity reflects both *which* and *how many*:

| Severity | Triggered when |
|----------|----------------|
| **high** | `price_mismatch` **or** `negative_quantity` is present, **or** the order matches **≥ 3** rule types. |
| **medium** | (not high, and) `inactive_supplier`, `timestamp_anomaly`, or `price_spike` is present, **or** exactly **2** rule types match. |
| **low** | a single, lower-impact flag (e.g. `after_hours`/`risky_supplier` context only). |

**Rationale:**
- `price_mismatch` and `negative_quantity` are **financial-integrity** problems — wrong money or
  a return masquerading as a purchase. They directly corrupt revenue aggregates, so they're
  always **high**.
- `inactive_supplier`, `timestamp_anomaly`, `price_spike` are **process/data-quality** problems —
  serious and worth review, but not necessarily a wrong number on the books → **medium**.
- **Co-occurrence escalates.** Three or more independent flags on one order signal a systemically
  bad record, so it's promoted to **high** regardless of which flags; two flags reach at least
  **medium**. This makes severity a function of evidence weight, not just a static per-rule label.

---

## Patterns discovered in the data

- **Anomalies cluster.** `ord_00150`, for example, is both `price_mismatch` and
  `negative_quantity` — a return whose total was also miscomputed. Many high-severity orders
  carry more than one flag, which is what motivated the co-occurrence escalation rule.
- **Inactive suppliers remain active in practice.** ~2,247 orders belong to suppliers marked
  `active = false`, and they concentrate in a subset of suppliers — the signal behind
  `risky_supplier`.
- **Price spikes are independent of price mismatches.** A spike (`unit_price` ≫ catalog) is a
  legitimately recorded but suspicious price, distinct from `price_mismatch` (arithmetic that
  doesn't add up). Keeping them as separate rules avoids conflating "overcharged" with
  "miscalculated."
- **After-hours volume is large and mostly benign**, which is exactly why it's a modifier rather
  than a trigger.

---

## What I'd improve with more time

- **Tunable thresholds.** The 3× price-spike multiplier, the 20% price-consistency band, and the
  50% risky-supplier cutoff are reasonable defaults but should be configurable and ideally
  data-driven (e.g. per-category price distributions instead of a flat 3×).
- **Statistical spikes.** Replace the fixed 3× rule with a per-product z-score / IQR outlier test
  so the rule adapts to each product's normal price variance.
- **Severity scoring instead of buckets.** Compute a weighted numeric risk score per order and
  derive low/medium/high from percentiles — more honest than hard boolean cutoffs.
- **Pagination / streaming.** The endpoint returns the full flagged set; with a much larger
  dataset it should paginate or stream, and the heavy scan could be materialized and refreshed
  on a schedule rather than computed per request.
