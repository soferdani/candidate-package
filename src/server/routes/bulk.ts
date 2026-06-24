import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { sendError } from '../lib/envelope.js';
import { BULK_ACTIONS } from '../lib/validation.js';
import { redis, QUEUE_KEY, jobKey, jobPayloadKey, JOB_TTL_SECONDS } from '../redis.js';

const MAX_BATCH = 10000;

export async function bulkRoutes(app: FastifyInstance) {
  // The test suite hits this under 3 path/field conventions (docs/01 Trap 1).
  // One handler, all three paths; accepts orderIds OR order_ids; returns BOTH key casings.
  const handler = async (req: any, reply: any) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const orderIds: unknown = body.orderIds ?? body.order_ids;
    const action: unknown = body.action;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return sendError(reply, 400, 'INVALID_ORDER_IDS', 'orderIds must be a non-empty array');
    }
    if (orderIds.length > MAX_BATCH) {
      return sendError(reply, 400, 'BATCH_TOO_LARGE', `Batch exceeds ${MAX_BATCH} orders`);
    }
    if (typeof action !== 'string' || !BULK_ACTIONS.includes(action as any)) {
      return sendError(reply, 400, 'INVALID_ACTION', `action must be one of ${BULK_ACTIONS.join(', ')}`);
    }

    const jobId = `job_${nanoid()}`;
    await redis.hset(jobKey(jobId), {
      total: orderIds.length,
      completed: 0,
      failed: 0,
      status: 'processing',
    });
    await redis.expire(jobKey(jobId), JOB_TTL_SECONDS);
    await redis.set(jobPayloadKey(jobId), JSON.stringify({ orderIds, action }), 'EX', JOB_TTL_SECONDS);
    await redis.rpush(QUEUE_KEY, jobId); // hand off to the background worker

    // Both casings so every test file's destructuring works.
    return reply.code(202).send({ jobId, job_id: jobId });
  };

  app.post('/api/orders/bulk', handler);
  app.post('/api/orders/bulk-action', handler);
  app.post('/api/orders/bulk-actions', handler);
}
