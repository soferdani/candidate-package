/**
 * Flush all Redis state (job hashes, queue, per-order dedup locks).
 * Used by `npm run reset` before re-seeding Postgres so a re-run starts from a clean slate:
 * the dedup lock (lock:order:<id>) has a 300s TTL and a collision is treated as already-done,
 * so locks left over from a previous test run would silently no-op the next run's bulk actions.
 * See docs/03 (Redis usage) and docs/how to test.md.
 */
import Redis from 'ioredis';

const url = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(url, { maxRetriesPerRequest: null });

await redis.flushall();
console.log('Redis FLUSHALL done (jobs, queue, order locks cleared).');
await redis.quit();
