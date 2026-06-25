export const money = (n: number | null | undefined) =>
  n == null
    ? '—'
    : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const num = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString();

export const pct = (n: number | null | undefined) =>
  n == null ? '—' : `${(n * 100).toFixed(1)}%`;

export const date = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
