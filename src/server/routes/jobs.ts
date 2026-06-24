import type { FastifyInstance } from 'fastify';
import { sendError } from '../lib/envelope.js';
import { redis, jobKey } from '../redis.js';

export async function jobsRoutes(app: FastifyInstance) {
  app.get('/api/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const hash = await redis.hgetall(jobKey(id));
    if (!hash || Object.keys(hash).length === 0) {
      return sendError(reply, 404, 'NOT_FOUND', `Job ${id} not found`);
    }
    // Redis returns hash values as strings; cast so the response types match the spec.
    return {
      status: hash.status,
      progress: {
        total: Number(hash.total || 0),
        completed: Number(hash.completed || 0),
        failed: Number(hash.failed || 0),
      },
    };
  });
}
