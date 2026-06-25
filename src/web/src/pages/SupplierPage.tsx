import { Link, useParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api/client';
import { useFetch } from '../hooks/useFetch';
import { Loading, ErrorState, Empty } from '../components/States';
import { StatusBadge } from '../components/StatusBadge';
import { money, num, pct, date } from '../lib/format';

export default function SupplierPage() {
  const { id = '' } = useParams();

  const supplier = useFetch(() => api.supplier(id), [id]);
  const perf = useFetch(() => api.supplierPerformance(id), [id]);
  const orders = useFetch(() => api.orders({ supplier_id: id, limit: 10, sort: 'created_at', order: 'desc' }), [id]);

  if (supplier.loading) return <Loading label="Loading supplier…" />;
  if (supplier.error || !supplier.data)
    return <ErrorState message={supplier.error ?? 'Not found'} onRetry={supplier.reload} />;

  const s = supplier.data;
  const trend = perf.data?.monthly_trend.map((m) => ({ ...m, label: m.month.slice(2) })) ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/orders" className="link">
            ‹ Orders
          </Link>
          <h1>
            {s.name} {!s.active && <span className="badge badge-cancelled">inactive</span>}
          </h1>
          <span className="muted mono">{s.id}</span>
        </div>
      </div>

      {/* ── Supplier facts + computed KPIs ──────────────────── */}
      <div className="kpi-row">
        <div className="card kpi">
          <span className="kpi-label">Orders</span>
          <span className="kpi-value">{num(s.order_count)}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">Total revenue</span>
          <span className="kpi-value">{money(s.total_revenue)}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">Rating</span>
          <span className="kpi-value">{s.rating ?? '—'}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">Country</span>
          <span className="kpi-value">{s.country ?? '—'}</span>
        </div>
      </div>

      {/* ── Performance ─────────────────────────────────────── */}
      <div className="card">
        <h3>Performance</h3>
        {perf.loading && <Loading />}
        {perf.error && <ErrorState message={perf.error} onRetry={perf.reload} />}
        {perf.data && (
          <>
            <div className="perf-grid">
              <Metric label="Avg delivery" value={`${perf.data.avg_delivery_days.toFixed(1)} days`} />
              <Metric label="Rejection rate" value={pct(perf.data.rejection_rate)} />
              <Metric label="Avg order value" value={money(perf.data.avg_order_value)} />
              <Metric label="Price consistency" value={pct(perf.data.price_consistency)} />
            </div>
            <h4 className="muted">Monthly order volume</h4>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => num(v)} />
                <Bar dataKey="order_count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </div>

      {/* ── Recent orders ───────────────────────────────────── */}
      <div className="card">
        <h3>Recent orders</h3>
        {orders.loading && <Loading />}
        {orders.error && <ErrorState message={orders.error} onRetry={orders.reload} />}
        {orders.data && orders.data.data.length === 0 && <Empty message="No orders for this supplier." />}
        {orders.data && orders.data.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Product</th>
                <th>Qty</th>
                <th>Total</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.data.data.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.id}</td>
                  <td className="truncate">{o.product_name ?? '—'}</td>
                  <td>{num(o.quantity)}</td>
                  <td>{money(o.total_price)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="muted">{date(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}
