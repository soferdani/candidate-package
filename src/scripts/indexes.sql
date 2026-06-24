-- Built AFTER bulk load (faster) and ANALYZEd. Each index maps to a perf budget; see docs/02.
CREATE INDEX IF NOT EXISTS idx_orders_status        ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_supplier       ON orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_orders_warehouse      ON orders(warehouse);
CREATE INDEX IF NOT EXISTS idx_orders_priority       ON orders(priority);
CREATE INDEX IF NOT EXISTS idx_orders_created_at     ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_total_price    ON orders(total_price);
CREATE INDEX IF NOT EXISTS idx_orders_product        ON orders(product_id);
-- hot path: filter by status + sort by created_at (perf test #2)
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
-- case-insensitive product-name search (perf test #3): trigram GIN serves leading-wildcard ILIKE
CREATE INDEX IF NOT EXISTS idx_products_name_trgm    ON products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_category     ON products(category_id);

ANALYZE categories;
ANALYZE suppliers;
ANALYZE products;
ANALYZE orders;
