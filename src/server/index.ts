import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ordersRoutes } from './routes/orders.js';
import { suppliersRoutes } from './routes/suppliers.js';
import { productsRoutes } from './routes/products.js';
import { bulkRoutes } from './routes/bulk.js';
import { jobsRoutes } from './routes/jobs.js';
import { eventsRoutes } from './routes/events.js';
import { startWorker } from './bulk/worker.js';

const app = Fastify({ logger: false });

await app.register(cors, { origin: true });

// Uniform JSON error envelope { error, code } for all failures.
app.setNotFoundHandler((req, reply) => {
  reply.code(404).send({ error: `Route ${req.method} ${req.url} not found`, code: 'NOT_FOUND' });
});

app.setErrorHandler((err: any, _req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  // Malformed JSON bodies and the like surface as 400s, not 500s.
  const code = status === 400 ? 'BAD_REQUEST' : status === 500 ? 'INTERNAL_ERROR' : 'ERROR';
  reply.code(status).send({ error: err.message || 'Internal Server Error', code });
});

await app.register(eventsRoutes);
await app.register(bulkRoutes);
await app.register(jobsRoutes);
await app.register(suppliersRoutes);
await app.register(productsRoutes);
await app.register(ordersRoutes);

startWorker();

const port = Number(process.env.PORT || 3000);
// Bind dual-stack (IPv6 `::` with IPv4-mapped enabled) rather than IPv4-only `0.0.0.0`.
// On Windows, `localhost` resolves to BOTH ::1 (IPv6, tried first) and 127.0.0.1 (IPv4).
// If we listen only on 0.0.0.0, the client's first ::1 attempt has no listener, so HTTP
// clients (curl, undici/fetch) pay the ~200ms Happy-Eyeballs fallback before retrying IPv4 —
// which silently blew the 100ms p95 budget on GET /api/orders. Listening on `::` answers ::1
// immediately and still accepts 127.0.0.1, eliminating the connect stall.
app
  .listen({ port, host: '::' })
  .then(() => console.log(`API listening on http://localhost:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
