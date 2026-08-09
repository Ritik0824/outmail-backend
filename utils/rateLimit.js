import { createRedisConnection } from '../queue/redisConnection.js';
import { acquireDeliveryQuota, quotaOptionsFromEnv } from '../services/deliveryQuota.js';

let compatibilityConnection;

function redisConnection() {
  compatibilityConnection ??= createRedisConnection({ lazyConnect: true });
  return compatibilityConnection;
}

export async function canSendEmail(userId) {
  return acquireDeliveryQuota({
    redis: redisConnection(),
    userId,
    options: quotaOptionsFromEnv(),
  });
}

// Quota acquisition is now atomic, so legacy callers do not increment twice.
export async function incrementEmailCount() {}

export async function closeRateLimitConnection() {
  if (!compatibilityConnection) return;
  await compatibilityConnection.quit();
  compatibilityConnection = undefined;
}
