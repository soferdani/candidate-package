import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { paginated } from '../lib/envelope.js';
import { parseListParams } from '../lib/validation.js';

export async function productsRoutes(app: FastifyInstance) {
  app.get('/api/products', async (req) => {
    const q = req.query as Record<string, any>;
    const p = parseListParams(q);
    const category = q.category as string | undefined;

    if (category) {
      // Recursive descent with cycle safety: UNION (not UNION ALL) dedups, so a cyclic
      // parent chain (A->B->A) terminates once every id is already in the set. (docs/01 Trap 3)
      const sql = `
        WITH RECURSIVE subcats AS (
          SELECT id FROM categories WHERE id = $1
          UNION
          SELECT c.id FROM categories c JOIN subcats s ON c.parent_id = s.id
        )
        SELECT *, count(*) OVER()::int AS __total
        FROM products
        WHERE category_id IN (SELECT id FROM subcats)
        ORDER BY id ASC LIMIT $2 OFFSET $3`;
      const res = await pool.query(sql, [category, p.limit, p.offset]);
      const total = res.rows.length ? res.rows[0].__total : 0;
      const data = res.rows.map(({ __total, ...rest }) => rest);
      return paginated(data, total, p.limit, p.offset);
    }

    const res = await pool.query(
      `SELECT *, count(*) OVER()::int AS __total
       FROM products ORDER BY id ASC LIMIT $1 OFFSET $2`,
      [p.limit, p.offset],
    );
    const total = res.rows.length ? res.rows[0].__total : 0;
    const data = res.rows.map(({ __total, ...rest }) => rest);
    return paginated(data, total, p.limit, p.offset);
  });
}
