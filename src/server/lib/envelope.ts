import type { FastifyReply } from 'fastify';

export function paginated<T>(data: T[], total: number, limit: number, offset: number) {
  return { data, total, limit, offset };
}

export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: message, code });
}
