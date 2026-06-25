import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Job } from '../api/types';

// Polls GET /api/jobs/:id until the job leaves 'processing', rendering a live progress bar.
// Calls onDone once when finished so the parent can refresh the table.
export function BulkProgress({
  jobId,
  action,
  onClose,
  onDone,
}: {
  jobId: string;
  action: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let firedDone = false;
    const tick = async () => {
      try {
        const j = await api.job(jobId);
        if (!alive) return;
        setJob(j);
        if (j.status === 'processing') {
          setTimeout(tick, 400);
        } else if (!firedDone) {
          firedDone = true;
          onDone();
        }
      } catch (e) {
        if (alive) setError(String((e as Error).message));
      }
    };
    tick();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const p = job?.progress;
  const done = p ? p.completed + p.failed : 0;
  const total = p?.total ?? 0;
  const pctDone = total ? Math.round((done / total) * 100) : 0;
  const finished = job && job.status !== 'processing';

  return (
    <div className="modal-backdrop" onClick={finished ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          Bulk <em>{action}</em>{' '}
          <span className={`badge badge-${job?.status === 'failed' ? 'rejected' : 'approved'}`}>
            {job?.status ?? 'starting…'}
          </span>
        </h3>
        <div className="muted job-id">job {jobId}</div>

        {error && <div className="state state-error">{error}</div>}

        <div className="progress">
          <div className="progress-bar" style={{ width: `${pctDone}%` }} />
        </div>
        <div className="job-stats">
          <span>
            <strong>{done}</strong> / {total} processed
          </span>
          <span className="ok">✓ {p?.completed ?? 0} completed</span>
          <span className="bad">✗ {p?.failed ?? 0} failed</span>
        </div>

        <div className="modal-actions">
          <button className="btn primary" disabled={!finished} onClick={onClose}>
            {finished ? 'Close' : 'Working…'}
          </button>
        </div>
      </div>
    </div>
  );
}
