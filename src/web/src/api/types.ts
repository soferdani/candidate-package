export type OrderStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export const ORDER_STATUSES: OrderStatus[] = [
  'pending',
  'approved',
  'rejected',
  'shipped',
  'delivered',
  'cancelled',
];

export const BULK_ACTIONS = ['approve', 'reject', 'flag'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export interface Order {
  id: string;
  supplier_id: string | null;
  product_id: string | null;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
  status: OrderStatus;
  priority: string | null;
  created_at: string;
  updated_at: string;
  warehouse: string | null;
  notes: string | null;
  version: number;
  product_name?: string | null;
  supplier_name?: string | null;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Supplier {
  id: string;
  name: string;
  email: string | null;
  rating: number | null;
  country: string | null;
  active: boolean;
  created_at: string;
  order_count?: number;
  total_revenue?: number;
}

export interface Stats {
  total_orders: number;
  total_revenue: number;
  avg_order_value: number;
  by_status: Record<string, { count: number; total_value: number }>;
  by_month: { month: string; order_count: number; revenue: number }[];
  top_suppliers: { supplier_id: string; supplier_name: string; total_revenue: number }[];
  by_warehouse: { warehouse: string; count: number; total_value: number }[];
}

export interface SupplierPerformance {
  avg_delivery_days: number;
  rejection_rate: number;
  avg_order_value: number;
  monthly_trend: { month: string; order_count: number }[];
  price_consistency: number;
}

export interface Job {
  status: 'processing' | 'completed' | 'failed';
  progress: { total: number; completed: number; failed: number };
}
