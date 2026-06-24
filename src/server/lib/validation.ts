import { z } from 'zod';

export const ORDER_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'shipped',
  'delivered',
  'cancelled',
] as const;

export const BULK_ACTIONS = ['approve', 'reject', 'flag'] as const;

export const statusSchema = z.enum(ORDER_STATUSES);

// PATCH body: any subset of these. Unknown status (incl. SQL-injection strings) fails the enum -> 400.
export const patchOrderSchema = z
  .object({
    status: statusSchema.optional(),
    priority: z.string().max(50).optional(),
    notes: z.string().optional(), // XSS payloads stored raw; escaped at render time
  })
  .strict();

// Sortable columns are whitelisted so user input never reaches ORDER BY directly.
export const SORTABLE = new Set([
  'id',
  'supplier_id',
  'product_id',
  'quantity',
  'unit_price',
  'total_price',
  'status',
  'priority',
  'created_at',
  'updated_at',
  'warehouse',
]);

export interface ListParams {
  limit: number;
  offset: number;
  status?: string[];
  priority?: string;
  supplier_id?: string;
  warehouse?: string;
  date_from?: string;
  date_to?: string;
  min_total?: number;
  search?: string;
  sort: string;
  order: 'asc' | 'desc';
}

export function parseListParams(q: Record<string, any>): ListParams {
  // limit: negative/invalid -> default 20; capped at 10000 (bulk setup pulls up to 1000 rows).
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  limit = Math.min(limit, 10000);

  let offset = Number.parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const status = typeof q.status === 'string' && q.status.length
    ? q.status.split(',').map((s: string) => s.trim()).filter(Boolean)
    : undefined;

  const min_total = q.min_total != null ? Number(q.min_total) : undefined;

  const sort = SORTABLE.has(q.sort) ? q.sort : 'id';
  const order = q.order === 'desc' ? 'desc' : 'asc';

  return {
    limit,
    offset,
    status,
    priority: q.priority || undefined,
    supplier_id: q.supplier_id || undefined,
    warehouse: q.warehouse || undefined,
    date_from: q.date_from || undefined,
    date_to: q.date_to || undefined,
    min_total: Number.isFinite(min_total) ? min_total : undefined,
    search: q.search || undefined,
    sort,
    order,
  };
}
