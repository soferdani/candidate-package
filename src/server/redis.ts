import Redis from 'ioredis';

const url = process.env.REDIS_URL || 'redis://localhost:6379';

// Normal client for commands. A connection parked in BRPOP can't run other commands,
// so the worker uses its own blocking client (see docs/03 §5).
export const redis = new Redis(url, { maxRetriesPerRequest: null });
export const blockingRedis = new Redis(url, { maxRetriesPerRequest: null });

export const QUEUE_KEY = 'jobqueue';
export const jobKey = (id: string) => `job:${id}`;
export const jobPayloadKey = (id: string) => `job:${id}:payload`;
export const orderLockKey = (orderId: string) => `lock:order:${orderId}`;

export const JOB_TTL_SECONDS = 3600;
export const LOCK_TTL_SECONDS = 300;
