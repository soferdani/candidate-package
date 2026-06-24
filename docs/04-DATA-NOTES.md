# 04 — Data Notes (the intentional landmines)

The README warns the dataset "has intentional edge cases." Here's what's actually in the CSVs,
verified by inspection, and what each one forces in the design. Treat this as the checklist your
import script and schema must survive.

## Volumes (from the files)
- `orders.csv` — 50,000 rows. `suppliers.csv` — 500. `products.csv` — 5,000.
- `categories.csv` — **195 data rows**, but `expected-values.json` reports `counts.categories = 193`.
  The gap + the "circular hierarchies" warning means the category tree is **not a clean tree**.
  No row is its own parent (checked), so any cycle is multi-node (A→B→…→A). The count isn't tested,
  but the recursive category query **must be cycle-safe** or it hangs → real perf/anomaly failure.

## Per-file landmines

### orders.csv
| Edge case | Evidence | Forces |
|-----------|----------|--------|
| **Empty warehouse** | exactly **1512** rows have a blank warehouse column | `COALESCE(NULLIF(warehouse,''),'unassigned')` in stats; matches expected `unassigned` count exactly |
| **Negative quantity** | e.g. `ord_00122` qty `-35` (returns) | schema must NOT constrain `quantity > 0`; feeds `negative_quantity` anomaly |
| **Price mismatch** | `ord_00150`: total 511.66 ≠ -11 × 51.16 | `price_mismatch` anomaly; ~992 rows |
| **Timestamp anomaly** | some `updated_at < created_at` | `timestamp_anomaly`; ~208 rows |
| **XSS in notes** | tips + security test inject `<script>`/`<img onerror>` | store **raw**; never sanitize server-side; escape at render in React |
| **Quoted/comma fields** | notes/product names contain commas & quotes | import must use a real CSV parser or Postgres `COPY … CSV`, not a naive split |
| **Seasonal spikes** | Jan/Dec months ~4700 orders vs ~1500 others | nothing to fix; explains the lumpy `by_month` numbers |

### suppliers.csv
| Edge case | Evidence | Forces |
|-----------|----------|--------|
| **Inactive suppliers with orders** | `sup_003`, `sup_005` `active=false`; ~2247 orders point to inactive suppliers | `active BOOLEAN`; feeds `inactive_supplier` anomaly |
| **Blank rating** | **14** rows have empty rating (e.g. `sup_002`) | `rating NUMERIC NULL` — don't force NOT NULL or import dies |
| **Duplicate name variations** | `Acme Industrial Supply` / `ACME Industrial Supply Inc.` / `acme industrial` | not deduped — they're distinct IDs; just be aware for the UI |
| **active is literal `true`/`false`** | text in CSV | cast to boolean on import |

### products.csv
| Edge case | Evidence | Forces |
|-----------|----------|--------|
| **Quoted names with embedded quotes** | `prod_0005` = `"Electric Rod 3/4"" Kit"` | proper CSV parsing (doubled `""` = one `"`) |
| **`price` is the base/catalog price** | — | used by `price_consistency` and `price_spike`; join orders→products on it |

### categories.csv
| Edge case | Evidence | Forces |
|-----------|----------|--------|
| **`parent_id` empty for roots** | `cat_001` has blank parent | nullable `parent_id` |
| **Circular hierarchy** | 195 rows vs 193 counted + explicit warning | **cycle-safe recursive CTE** for `/api/products?category=` |

## Import strategy (script in `src/scripts/import.ts`)
- Use Postgres **`COPY ... FROM ... WITH (FORMAT csv, HEADER true)`** for speed (50k rows in
  one shot), into the tables defined in `02`. `COPY` handles the quoting/escaping correctly —
  this is why we don't hand-roll a parser.
- Order matters for FKs: `categories` → `suppliers` → `products` → `orders`. If a cycle in
  categories makes the FK self-reference awkward, import categories with the FK deferred or
  add the self-FK after load.
- Coerce: empty `rating` → NULL, empty `warehouse` left as-is (we bucket at query time), `active`
  text → boolean.
- After load: `CREATE INDEX`es (faster to build them *after* the bulk insert), then `ANALYZE`.

## Numbers to sanity-check against `expected-values.json` after import
- `SELECT count(*) FROM orders` → 50000; suppliers 500; products 5000.
- `SELECT count(*) FROM orders WHERE warehouse IS NULL OR warehouse=''` → **1512**.
- `SELECT count(*) FROM orders WHERE quantity < 0` → ~507.
- `SELECT count(*) FROM orders WHERE updated_at < created_at` → ~208.
- These are your "did the import work" smoke tests before you even start the API.
