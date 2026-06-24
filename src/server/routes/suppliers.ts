import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { paginated, sendError } from '../lib/envelope.js';
import { parseListParams } from '../lib/validation.js';

export async function suppliersRoutes(app: FastifyInstance) {
  app.get('/api/suppliers', async (req) => {
    const p = parseListParams(req.query as Record<string, any>);
    const res = await pool.query(
      `SELECT *, count(*) OVER()::int AS __total
       FROM suppliers ORDER BY id ASC LIMIT $1 OFFSET $2`,
      [p.limit, p.offset],
    );
    const total = res.rows.length ? res.rows[0].__total : 0;
    const data = res.rows.map(({ __total, ...rest }) => rest);
    return paginated(data, total, p.limit, p.offset);
  });

  // Per-supplier performance — registered before /:id is fine (Fastify matches static segments).
  app.get('/api/suppliers/:id/performance', async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id]);
    if (exists.rows.length === 0) return sendError(reply, 404, 'NOT_FOUND', `Supplier ${id} not found`);

    const [agg, trend, consistency] = await Promise.all([
      pool.query(
        `SELECT
           AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0)
             FILTER (WHERE status = 'delivered')::float8 AS avg_delivery_days,
           (count(*) FILTER (WHERE status = 'rejected'))::float8 / NULLIF(count(*),0) AS rejection_rate,
           COALESCE(avg(total_price),0)::float8 AS avg_order_value
         FROM orders WHERE supplier_id = $1`,
        [id],
      ),
      pool.query(
        `SELECT to_char(created_at,'YYYY-MM') AS month, count(*)::int AS order_count
         FROM orders WHERE supplier_id = $1 GROUP BY 1 ORDER BY 1`,
        [id],
      ),
      pool.query(
        `SELECT
           (count(*) FILTER (WHERE p.price > 0
              AND abs(o.unit_price - p.price) / p.price <= 0.20))::float8
           / NULLIF(count(*),0) AS price_consistency
         FROM orders o JOIN products p ON p.id = o.product_id
         WHERE o.supplier_id = $1`,
        [id],
      ),
    ]);

    const a = agg.rows[0];
    return {
      avg_delivery_days: a.avg_delivery_days ?? 0,
      rejection_rate: a.rejection_rate ?? 0,
      avg_order_value: a.avg_order_value ?? 0,
      monthly_trend: trend.rows,
      price_consistency: consistency.rows[0].price_consistency ?? 0,
    };
  });

  app.get('/api/suppliers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await pool.query(
      `SELECT s.*,
              COALESCE(o.order_count,0)::int AS order_count,
              COALESCE(o.total_revenue,0)::float8 AS total_revenue
       FROM suppliers s
       LEFT JOIN (
         SELECT supplier_id, count(*) AS order_count, sum(total_price) AS total_revenue
         FROM orders GROUP BY supplier_id
       ) o ON o.supplier_id = s.id
       WHERE s.id = $1`,
      [id],
    );
    if (res.rows.length === 0) return sendError(reply, 404, 'NOT_FOUND', `Supplier ${id} not found`);
    return res.rows[0];
  });
}
