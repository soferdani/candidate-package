-- Order Ops schema. Idempotent: safe to re-run.
-- Edge cases baked into the column choices are documented in docs/04-DATA-NOTES.md.

DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS categories CASCADE;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Self-referential; parent_id may form cycles (handled with a cycle-safe CTE in queries).
-- No FK on parent_id on purpose: the data contains references we don't want to reject at load.
CREATE TABLE categories (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id TEXT
);

CREATE TABLE suppliers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  rating     NUMERIC,            -- nullable: ~14 rows have a blank rating
  country    TEXT,
  active     BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ
);

CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id TEXT,
  sku         TEXT,
  price       NUMERIC NOT NULL    -- base/catalog price; used by anomalies + price_consistency
);

CREATE TABLE orders (
  id          TEXT PRIMARY KEY,
  supplier_id TEXT,
  product_id  TEXT,
  quantity    INTEGER,            -- can be negative (returns) — intentionally unconstrained
  unit_price  NUMERIC,
  total_price NUMERIC,            -- sometimes intentionally != quantity*unit_price
  status      TEXT NOT NULL,
  priority    TEXT,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,        -- sometimes < created_at (timestamp anomaly)
  warehouse   TEXT,              -- null/empty -> 'unassigned' at query time
  notes       TEXT,              -- may contain XSS payloads; stored raw
  version     INTEGER NOT NULL DEFAULT 0  -- optimistic-lock counter
);
