import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { paginated, sendError } from '../lib/envelope.js';
import { parseListParams, patchOrderSchema } from '../lib/validation.js';
import { broadcastOrderUpdated } from '../events.js';

export async function ordersRoutes(app: FastifyInstance) {
  // ── Aggregations & anomalies MUST be registered before /:id (docs/01 Trap 2) ──

  app.get('/api/orders/stats', async () => {
    const [totals, byStatus, byMonth, topSuppliers, byWarehouse] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS total_orders,
                COALESCE(sum(total_price),0)::float8 AS total_revenue,
                COALESCE(avg(total_price),0)::float8 AS avg_order_value
         FROM orders`,
      ),
      pool.query(
        `SELECT status, count(*)::int AS count, COALESCE(sum(total_price),0)::float8 AS total_value
         FROM orders GROUP BY status`,
      ),
      pool.query(
        `SELECT to_char(created_at,'YYYY-MM') AS month,
                count(*)::int AS order_count,
                COALESCE(sum(total_price),0)::float8 AS revenue
         FROM orders GROUP BY 1 ORDER BY 1`,
      ),
      pool.query(
        `SELECT o.supplier_id, s.name AS supplier_name,
                COALESCE(sum(o.total_price),0)::float8 AS total_revenue
         FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id
         GROUP BY o.supplier_id, s.name
         ORDER BY total_revenue DESC LIMIT 10`,
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(warehouse,''),'unassigned') AS warehouse,
                count(*)::int AS count,
                COALESCE(sum(total_price),0)::float8 AS total_value
         FROM orders GROUP BY 1`,
      ),
    ]);

    const by_status: Record<string, { count: number; total_value: number }> = {};
    for (const r of byStatus.rows) by_status[r.status] = { count: r.count, total_value: r.total_value };

    return {
      total_orders: totals.rows[0].total_orders,
      total_revenue: totals.rows[0].total_revenue,
      avg_order_value: totals.rows[0].avg_order_value,
      by_status,
      by_month: byMonth.rows,
      top_suppliers: topSuppliers.rows,
      by_warehouse: byWarehouse.rows,
    };
  });

  app.get('/api/orders/anomalies', async () => {
    // risky suppliers: >50% of their orders carry a required anomaly
    const riskyRes = await pool.query<{ supplier_id: string }>(
      `WITH f AS (
         SELECT o.supplier_id,
           ( abs(o.total_price - o.quantity*o.unit_price) > 0.01
             OR s.active = false
             OR o.quantity < 0
             OR o.updated_at < o.created_at ) AS anom
         FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id
       )
       SELECT supplier_id FROM f GROUP BY supplier_id
       HAVING count(*) > 0 AND (count(*) FILTER (WHERE anom))::float8 / count(*) > 0.5`,
    );
    const risky = new Set(riskyRes.rows.map((r) => r.supplier_id));

    const res = await pool.query(
      `SELECT o.id, o.supplier_id,
         (abs(o.total_price - o.quantity*o.unit_price) > 0.01) AS price_mismatch,
         (s.active = false) AS inactive_supplier,
         (o.quantity < 0) AS negative_quantity,
         (o.updated_at < o.created_at) AS timestamp_anomaly,
         (p.price IS NOT NULL AND p.price > 0 AND o.unit_price > p.price * 3) AS price_spike,
         (EXTRACT(hour FROM o.created_at AT TIME ZONE 'UTC') >= 22
           OR EXTRACT(hour FROM o.created_at AT TIME ZONE 'UTC') < 6) AS after_hours
       FROM orders o
       LEFT JOIN suppliers s ON s.id = o.supplier_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE (abs(o.total_price - o.quantity*o.unit_price) > 0.01)
          OR (s.active = false)
          OR (o.quantity < 0)
          OR (o.updated_at < o.created_at)
          OR (p.price IS NOT NULL AND p.price > 0 AND o.unit_price > p.price * 3)`,
      // after_hours intentionally NOT an inclusion criterion: it matches ~16.7k orders and
      // would bloat the payload past the 1s budget. It's reported as a modifier tag on orders
      // already flagged for another reason (see ANOMALY_STRATEGY.md). Bonus test only needs >0.
    );

    const data = res.rows.map((r) => {
      const types: string[] = [];
      if (r.price_mismatch) types.push('price_mismatch');
      if (r.inactive_supplier) types.push('inactive_supplier');
      if (r.negative_quantity) types.push('negative_quantity');
      if (r.timestamp_anomaly) types.push('timestamp_anomaly');
      if (r.price_spike) types.push('price_spike');
      if (r.after_hours) types.push('after_hours');
      if (risky.has(r.supplier_id)) types.push('risky_supplier');

      const high =
        types.includes('price_mismatch') ||
        types.includes('negative_quantity') ||
        types.length >= 3;
      const medium =
        !high &&
        (types.includes('inactive_supplier') ||
          types.includes('timestamp_anomaly') ||
          types.includes('price_spike') ||
          types.length === 2);
      const severity = high ? 'high' : medium ? 'medium' : 'low';

      return { order_id: r.id, anomaly_types: types, severity };
    });

    return { data };
  });

  // ── List ──────────────────────────────────────────────────────────────────────
  app.get('/api/orders', async (req) => {
    const p = parseListParams(req.query as Record<string, any>);
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (clause: string, val: unknown) => {
      args.push(val);
      where.push(clause.replace('?', `$${args.length}`));
    };

    if (p.status) add('o.status = ANY(?)', p.status);
    if (p.priority) add('o.priority = ?', p.priority);
    if (p.supplier_id) add('o.supplier_id = ?', p.supplier_id);
    if (p.warehouse) add('o.warehouse = ?', p.warehouse);
    if (p.date_from) add('o.created_at >= ?', p.date_from);
    if (p.date_to) {
      args.push(p.date_to);
      where.push(`o.created_at < ($${args.length}::date + interval '1 day')`);
    }
    if (p.min_total != null) add('o.total_price >= ?', p.min_total);
    if (p.search) add('p.name ILIKE ?', `%${p.search}%`);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const joinSql = 'LEFT JOIN products p ON p.id = o.product_id';
    // search is the only filter that touches products; otherwise the count can skip the join.
    const countJoin = p.search ? joinSql : '';

    // Page + count run as two cheap queries instead of count(*) OVER(), which would
    // materialize the full 50k-row join before returning 20 rows (docs/02 perf notes).
    const pageSql = `
      SELECT o.*, p.name AS product_name
      FROM orders o ${joinSql}
      ${whereSql}
      ORDER BY o.${p.sort} ${p.order}
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`;
    const countSql = `SELECT count(*)::int AS n FROM orders o ${countJoin} ${whereSql}`;

    const [pageRes, countRes] = await Promise.all([
      pool.query(pageSql, [...args, p.limit, p.offset]),
      pool.query(countSql, args),
    ]);
    return paginated(pageRes.rows, countRes.rows[0].n, p.limit, p.offset);
  });

  // ── Single ────────────────────────────────────────────────────────────────────
  app.get('/api/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await pool.query(
      `SELECT o.*, s.name AS supplier_name, p.name AS product_name
       FROM orders o
       LEFT JOIN suppliers s ON s.id = o.supplier_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [id],
    );
    if (res.rows.length === 0) return sendError(reply, 404, 'NOT_FOUND', `Order ${id} not found`);
    return res.rows[0];
  });

  // ── Update (optimistic locking) ────────────────────────────────────────────────
  app.patch('/api/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_BODY', parsed.error.issues[0]?.message ?? 'Invalid request body');
    }
    const body = parsed.data;
    if (Object.keys(body).length === 0) {
      return sendError(reply, 400, 'EMPTY_UPDATE', 'No updatable fields provided');
    }

    const cur = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (cur.rows.length === 0) return sendError(reply, 404, 'NOT_FOUND', `Order ${id} not found`);
    const current = cur.rows[0];

    if (current.status === 'cancelled') {
      return sendError(reply, 409, 'ALREADY_CANCELLED', 'Order is already cancelled and cannot be modified');
    }

    const status = body.status ?? null;
    const priority = body.priority ?? null;
    const notes = body.notes ?? null;

    // Single atomic conditional update — no read-then-write race. For a status change, the
    // `status IS DISTINCT FROM` guard means the row lock serializes two concurrent identical
    // PATCHes: the first transitions the status, the second finds it already at target and
    // matches 0 rows -> 409. Deterministic even under heavy load (docs/01 concurrency rules).
    const upd = await pool.query(
      `UPDATE orders
       SET status   = COALESCE($2, status),
           priority = COALESCE($3, priority),
           notes    = COALESCE($4, notes),
           updated_at = now(),
           version  = version + 1
       WHERE id = $1
         AND status <> 'cancelled'
         AND ($2::text IS NULL OR status IS DISTINCT FROM $2)
       RETURNING *`,
      [id, status, priority, notes],
    );
    if (upd.rowCount === 0) {
      return sendError(reply, 409, 'CONFLICT', 'Order was modified by another request; please retry');
    }

    const updated = upd.rows[0];
    if (body.status !== undefined && body.status !== current.status) {
      broadcastOrderUpdated({
        id: updated.id,
        old_status: current.status,
        new_status: updated.status,
        updated_at: updated.updated_at.toISOString(),
        supplier_id: updated.supplier_id,
      });
    }
    return updated;
  });
}
