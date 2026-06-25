import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type OrderQuery } from '../api/client';
import { ORDER_STATUSES, type BulkAction, type Order } from '../api/types';
import { useFetch } from '../hooks/useFetch';
import { Loading, ErrorState, Empty } from '../components/States';
import { StatusBadge } from '../components/StatusBadge';
import { Pagination } from '../components/Pagination';
import { BulkProgress } from '../components/BulkProgress';
import { money, num, date } from '../lib/format';

const LIMIT = 20;
const SORTABLE: { key: string; label: string }[] = [
  { key: 'id', label: 'Order' },
  { key: 'supplier_id', label: 'Supplier' },
  { key: 'quantity', label: 'Qty' },
  { key: 'total_price', label: 'Total' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'created_at', label: 'Created' },
];

interface Filters {
  status: string;
  priority: string;
  supplier_id: string;
  warehouse: string;
  date_from: string;
  date_to: string;
  min_total: string;
  search: string;
}

const EMPTY_FILTERS: Filters = {
  status: '',
  priority: '',
  supplier_id: '',
  warehouse: '',
  date_from: '',
  date_to: '',
  min_total: '',
  search: '',
};

export default function OrdersPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState('created_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<{ id: string; action: BulkAction } | null>(null);

  const query: OrderQuery = useMemo(
    () => ({ ...applied, sort, order, limit: LIMIT, offset }),
    [applied, sort, order, offset],
  );
  const { data, loading, error, reload } = useFetch(() => api.orders(query), [query]);

  const apply = () => {
    setApplied(filters);
    setOffset(0);
    setSelected(new Set());
  };
  const clearAll = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setOffset(0);
    setSelected(new Set());
  };

  const toggleSort = (key: string) => {
    if (sort === key) setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(key);
      setOrder('asc');
    }
    setOffset(0);
  };

  const rows: Order[] = data?.data ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) rows.forEach((r) => next.delete(r.id));
    else rows.forEach((r) => next.add(r.id));
    setSelected(next);
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const runBulk = async (action: BulkAction) => {
    if (selected.size === 0) return;
    try {
      const { jobId } = await api.bulkAction([...selected], action);
      setJob({ id: jobId, action });
    } catch (e) {
      alert(`Bulk action failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Orders</h1>
        {data && <span className="muted">{data.total.toLocaleString()} total</span>}
      </div>

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="card filters">
        <div className="filter-grid">
          <label>
            Search
            <input
              placeholder="product name…"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
            />
          </label>
          <label>
            Status
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">All</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select
              value={filters.priority}
              onChange={(e) => setFilters({ ...filters, priority: e.target.value })}
            >
              <option value="">All</option>
              {['low', 'medium', 'high', 'critical'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Supplier ID
            <input
              placeholder="sup_042"
              value={filters.supplier_id}
              onChange={(e) => setFilters({ ...filters, supplier_id: e.target.value })}
            />
          </label>
          <label>
            Warehouse
            <select
              value={filters.warehouse}
              onChange={(e) => setFilters({ ...filters, warehouse: e.target.value })}
            >
              <option value="">All</option>
              {['warehouse_north', 'warehouse_south', 'warehouse_east', 'warehouse_west', 'warehouse_central'].map(
                (w) => (
                  <option key={w} value={w}>
                    {w.replace('warehouse_', '')}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Min total
            <input
              type="number"
              placeholder="1000"
              value={filters.min_total}
              onChange={(e) => setFilters({ ...filters, min_total: e.target.value })}
            />
          </label>
          <label>
            From
            <input
              type="date"
              value={filters.date_from}
              onChange={(e) => setFilters({ ...filters, date_from: e.target.value })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={filters.date_to}
              onChange={(e) => setFilters({ ...filters, date_to: e.target.value })}
            />
          </label>
        </div>
        <div className="filter-actions">
          <button className="btn primary" onClick={apply}>
            Apply filters
          </button>
          <button className="btn" onClick={clearAll}>
            Clear
          </button>
        </div>
      </div>

      {/* ── Bulk bar ────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>
            <strong>{selected.size}</strong> selected
          </span>
          <div className="bulk-actions">
            <button className="btn ok" onClick={() => runBulk('approve')}>
              Approve
            </button>
            <button className="btn bad" onClick={() => runBulk('reject')}>
              Reject
            </button>
            <button className="btn" onClick={() => runBulk('flag')}>
              Flag
            </button>
            <button className="btn ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────── */}
      <div className="card">
        {loading && <Loading label="Loading orders…" />}
        {error && !loading && <ErrorState message={error} onRetry={reload} />}
        {!loading && !error && rows.length === 0 && (
          <Empty message="No orders match these filters." />
        )}
        {!loading && !error && rows.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th className="check">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                </th>
                {SORTABLE.map((c) => (
                  <th key={c.key} className="sortable" onClick={() => toggleSort(c.key)}>
                    {c.label}
                    {sort === c.key && <span className="arrow">{order === 'asc' ? ' ▲' : ' ▼'}</span>}
                  </th>
                ))}
                <th>Product</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className={selected.has(o.id) ? 'row-selected' : ''}>
                  <td className="check">
                    <input
                      type="checkbox"
                      checked={selected.has(o.id)}
                      onChange={() => toggleOne(o.id)}
                    />
                  </td>
                  <td className="mono">{o.id}</td>
                  <td>
                    {o.supplier_id ? (
                      <Link to={`/suppliers/${o.supplier_id}`} className="link">
                        {o.supplier_id}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={(o.quantity ?? 0) < 0 ? 'bad' : ''}>{num(o.quantity)}</td>
                  <td>{money(o.total_price)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td>{o.priority ?? '—'}</td>
                  <td className="muted">{date(o.created_at)}</td>
                  <td className="truncate">{o.product_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.total > 0 && (
        <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
      )}

      {job && (
        <BulkProgress
          jobId={job.id}
          action={job.action}
          onClose={() => {
            setJob(null);
            setSelected(new Set());
            reload();
          }}
          onDone={reload}
        />
      )}
    </div>
  );
}
