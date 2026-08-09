import IORedis from 'ioredis';

export function createRedisConnection({ lazyConnect = false } = {}) {
  return new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    lazyConnect,
    maxRetriesPerRequest: null,
  });
}
