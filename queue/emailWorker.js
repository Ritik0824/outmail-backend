import { Worker } from 'bullmq';
import sendEmailWithGmail from '../utils/sendEmailWithGmail.js';
import { acquireDeliveryQuota, quotaOptionsFromEnv } from '../services/deliveryQuota.js';
import { createEmailJobProcessor } from '../services/emailDelivery.js';
import { createRedisConnection } from './redisConnection.js';

export function createEmailWorker({
  prisma,
  connection = createRedisConnection(),
  sendEmail = sendEmailWithGmail,
  checkRateLimit,
  recordEmailCount = async () => {},
  checkSuppression,
  prepareMessage,
} = {}) {
  if (!prisma) {
    throw new Error('createEmailWorker requires a Prisma client');
  }

  const quotaOptions = quotaOptionsFromEnv();
  const quotaCheck = checkRateLimit ?? ((userId) => acquireDeliveryQuota({
    redis: connection,
    userId,
    options: quotaOptions,
  }));
  const processor = createEmailJobProcessor({
    prisma,
    sendEmail,
    checkRateLimit: quotaCheck,
    recordEmailCount,
    checkSuppression,
    prepareMessage,
  });
  const worker = new Worker('emailQueue', processor, { connection });

  worker.on('ready', () => {
    console.log('[Worker] Email worker is ready');
  });
  worker.on('completed', (job, result) => {
    console.log(`[Worker] Job ${job.id} completed`, result);
  });
  worker.on('failed', (job, error) => {
    console.error(`[Worker] Job ${job?.id ?? 'unknown'} failed:`, error);
  });

  return worker;
}
