import { useEffect, useState } from 'react';

// Consumes the SSE stream at /api/events to show a live connection indicator and the most
// recent event. Demonstrates the real-time channel end-to-end without coupling it to any page.
export function LiveStatus() {
  const [connected, setConnected] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; data: { id?: string; jobId?: string } };
        setCount((c) => c + 1);
        if (msg.type === 'order_updated') setLast(`order ${msg.data.id} updated`);
        else if (msg.type === 'bulk_completed') setLast(`bulk job ${msg.data.jobId} done`);
      } catch {
        /* ignore keep-alive comments */
      }
    };
    return () => es.close();
  }, []);

  return (
    <div className="live" title={last ?? 'Listening for live order events'}>
      <span className={`dot ${connected ? 'on' : 'off'}`} />
      <span className="live-label">{connected ? 'Live' : 'Offline'}</span>
      {count > 0 && <span className="live-count">{count}</span>}
    </div>
  );
}
