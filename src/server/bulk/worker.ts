/**
 * Background bulk worker. Drains the Redis job queue, processes each order with a
 * per-order SET-NX dedup lock (exactly-once across overlapping jobs), updates progress
 * in the job hash, and emits a bulk_completed event when done. See docs/03 §3 (Place A).
 */
import { pool } from '../db.js';
import {
  redis,
  blockingRedis,
  QUEUE_KEY,
  jobKey,
  jobPayloadKey,
  orderLockKey,
  JOB_TTL_SECONDS,
  LOCK_TTL_SECONDS,
} from '../redis.js';
import { broadcastBulkCompleted, broadcastOrderUpdated } from '../events.js';

const ACTION_TO_STATUS: Record<string, string | null> = {
  approve: 'approved',
  reject: 'rejected',
  flag: null, // 'flag' marks for review without forcing an invalid status
};

interface JobPayload {
  orderIds: string[];
  action: string;
}

async function processOrder(orderId: string, action: string): Promise<'completed' | 'failed'> {
  // Dedup: only one job may claim an order. NX => atomic "set if absent"; EX auto-releases
  // if a worker crashes. A collision means another job already owns it -> count as completed
  // (the order is being driven to the same action; we never double-apply).
  const locked = await redis.set(orderLockKey(orderId), action, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (locked !== 'OK') return 'completed';

  const { rows } = await pool.query(
    'SELECT status, supplier_id FROM orders WHERE id = $1',
    [orderId],
  );
  if (rows.length === 0) return 'failed'; // non-existent id
  const current = rows[0];
  if (current.status === 'cancelled') return 'failed'; // already-cancelled cannot be actioned

  const newStatus = ACTION_TO_STATUS[action];
  if (newStatus === null) {
    // flag: no status change, but bump version/updated_at so it's recorded as processed
    await pool.query('UPDATE orders SET updated_at = now(), version = version + 1 WHERE id = $1', [
      orderId,
    ]);
    return 'completed';
  }

  const upd = await pool.query(
    'UPDATE orders SET status = $1, updated_at = now(), version = version + 1 WHERE id = $2 RETURNING updated_at',
    [newStatus, orderId],
  );
  broadcastOrderUpdated({
    id: orderId,
    old_status: current.status,
    new_status: newStatus,
    updated_at: upd.rows[0].updated_at.toISOString(),
    supplier_id: current.supplier_id,
  });
  return 'completed';
}

async function runJob(jobId: string) {
  const raw = await redis.get(jobPayloadKey(jobId));
  if (!raw) return;
  const { orderIds, action } = JSON.parse(raw) as JobPayload;

  for (const orderId of orderIds) {
    let outcome: 'completed' | 'failed';
    try {
      outcome = await processOrder(orderId, action);
    } catch (err) {
      console.error(`order ${orderId} failed in job ${jobId}:`, err);
      outcome = 'failed';
    }
    await redis.hincrby(jobKey(jobId), outcome, 1);
  }

  const hash = await redis.hgetall(jobKey(jobId));
  const completed = Number(hash.completed || 0);
  const total = Number(hash.total || 0);
  const status = completed === 0 && total > 0 ? 'failed' : 'completed';
  await redis.hset(jobKey(jobId), 'status', status);
  await redis.expire(jobKey(jobId), JOB_TTL_SECONDS);
  await redis.del(jobPayloadKey(jobId));

  broadcastBulkCompleted(jobId);
}

let running = false;
export function startWorker() {
  if (running) return;
  running = true;
  void loop();
}

async function loop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const popped = await blockingRedis.brpop(QUEUE_KEY, 0);
      if (!popped) continue;
      const [, jobId] = popped;
      await runJob(jobId);
    } catch (err) {
      console.error('worker loop error:', err);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
