interface Props {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}

export function Pagination({ total, limit, offset, onChange }: Props) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <div className="pagination">
      <span className="muted">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="pager">
        <button className="btn" disabled={offset === 0} onClick={() => onChange(0)}>
          « First
        </button>
        <button
          className="btn"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          ‹ Prev
        </button>
        <span className="muted">
          Page {page} / {pages}
        </span>
        <button
          className="btn"
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
