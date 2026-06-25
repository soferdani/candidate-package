import type { BulkAction, Job, Order, Paginated, Stats, Supplier, SupplierPerformance } from './types';

// Relative URLs hit the Vite dev proxy (/api -> :3000) in dev and same-origin in a static build.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.code ?? 'ERROR', body?.error ?? res.statusText);
  }
  return body as T;
}

export interface OrderQuery {
  status?: string;
  priority?: string;
  supplier_id?: string;
  warehouse?: string;
  date_from?: string;
  date_to?: string;
  min_total?: string;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

function toQuery(q: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  orders: (q: OrderQuery = {}) =>
    request<Paginated<Order>>(`/orders${toQuery(q as Record<string, unknown>)}`),
  order: (id: string) => request<Order>(`/orders/${id}`),
  stats: () => request<Stats>('/orders/stats'),
  suppliers: (limit = 20, offset = 0) =>
    request<Paginated<Supplier>>(`/suppliers${toQuery({ limit, offset })}`),
  supplier: (id: string) => request<Supplier>(`/suppliers/${id}`),
  supplierPerformance: (id: string) => request<SupplierPerformance>(`/suppliers/${id}/performance`),
  bulkAction: (orderIds: string[], action: BulkAction) =>
    request<{ jobId: string }>('/orders/bulk-action', {
      method: 'POST',
      body: JSON.stringify({ orderIds, action }),
    }),
  job: (id: string) => request<Job>(`/jobs/${id}`),
};
