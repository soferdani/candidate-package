import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api/client';
import { useFetch } from '../hooks/useFetch';
import { Loading, ErrorState } from '../components/States';
import { money, num } from '../lib/format';

const STATUS_COLORS: Record<string, string> = {
  pending: '#f59e0b',
  approved: '#3b82f6',
  rejected: '#ef4444',
  shipped: '#8b5cf6',
  delivered: '#10b981',
  cancelled: '#6b7280',
};

export default function DashboardPage() {
  const { data: stats, loading, error, reload } = useFetch(() => api.stats(), []);

  if (loading) return <Loading label="Crunching 50,000 orders…" />;
  if (error || !stats) return <ErrorState message={error ?? 'No data'} onRetry={reload} />;

  const byStatus = Object.entries(stats.by_status).map(([status, v]) => ({
    status,
    count: v.count,
    total_value: v.total_value,
  }));
  const months = stats.by_month.map((m) => ({ ...m, label: m.month.slice(2) }));
  const topSuppliers = stats.top_suppliers.map((s) => ({
    name: s.supplier_name?.length > 22 ? s.supplier_name.slice(0, 20) + '…' : s.supplier_name,
    revenue: s.total_revenue,
    id: s.supplier_id,
  }));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Analytics</h1>
      </div>

      {/* ── KPI cards ───────────────────────────────────────── */}
      <div className="kpi-row">
        <div className="card kpi">
          <span className="kpi-label">Total orders</span>
          <span className="kpi-value">{num(stats.total_orders)}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">Total revenue</span>
          <span className="kpi-value">{money(stats.total_revenue)}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">Avg order value</span>
          <span className="kpi-value">{money(stats.avg_order_value)}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">Warehouses</span>
          <span className="kpi-value">{stats.by_warehouse.length}</span>
        </div>
      </div>

      <div className="chart-grid">
        {/* ── Status distribution ───────────────────────────── */}
        <div className="card chart">
          <h3>Status distribution</h3>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={byStatus}
                dataKey="count"
                nameKey="status"
                cx="50%"
                cy="50%"
                outerRadius={90}
                label={(e) => e.status}
              >
                {byStatus.map((s) => (
                  <Cell key={s.status} fill={STATUS_COLORS[s.status] ?? '#999'} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number) => num(v)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* ── Top suppliers ─────────────────────────────────── */}
        <div className="card chart">
          <h3>Top suppliers by revenue</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={topSuppliers} layout="vertical" margin={{ left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickFormatter={(v) => `$${(v / 1e6).toFixed(0)}M`} />
              <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => money(v)} />
              <Bar dataKey="revenue" fill="#3b82f6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* ── Monthly volume ────────────────────────────────── */}
        <div className="card chart wide">
          <h3>Monthly order volume (2023–2024)</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={months}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => num(v)} />
              <Line type="monotone" dataKey="order_count" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
