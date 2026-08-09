import { Queue } from 'bullmq';
import { createRedisConnection } from './redisConnection.js';

const connection = createRedisConnection({ lazyConnect: true });

export const emailQueue = new Queue('emailQueue', { connection });

export async function closeEmailQueue() {
  await emailQueue.close();
  await connection.quit();
}
