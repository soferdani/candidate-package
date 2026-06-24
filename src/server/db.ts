import { Pool, types, type QueryResultRow } from 'pg';

// NUMERIC (OID 1700) defaults to string in node-postgres. Parse to float so prices/ratings
// are JSON numbers — vitest's toBeGreaterThanOrEqual throws on string operands. Tolerances in
// the agg tests mean float precision is fine here.
types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/order_ops';

export const pool = new Pool({ connectionString, max: 20 });

export async function query<T extends QueryResultRow = any>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params as any[]);
}
