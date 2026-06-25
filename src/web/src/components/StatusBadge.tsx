import type { OrderStatus } from '../api/types';

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}
