import type { FastifyInstance } from 'fastify';
import { addClient, removeClient } from '../events.js';

export async function eventsRoutes(app: FastifyInstance) {
  app.get('/api/events', (req, reply) => {
    const { supplier_id } = req.query as { supplier_id?: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    reply.raw.write(': connected\n\n'); // comment line keeps the stream open

    const client = addClient(reply, supplier_id);
    reply.hijack(); // we own the socket; Fastify must not try to send a body

    const cleanup = () => removeClient(client);
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });
}
