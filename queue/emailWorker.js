import { Worker } from 'bullmq';
import sendEmailWithGmail from '../utils/sendEmailWithGmail.js';
import { canSendEmail, incrementEmailCount } from '../utils/rateLimit.js';
import { createEmailJobProcessor } from '../services/emailDelivery.js';
import { createRedisConnection } from './redisConnection.js';

export function createEmailWorker({
  prisma,
  connection = createRedisConnection(),
  sendEmail = sendEmailWithGmail,
  checkRateLimit = canSendEmail,
  recordEmailCount = incrementEmailCount,
  checkSuppression,
  prepareMessage,
} = {}) {
  if (!prisma) {
    throw new Error('createEmailWorker requires a Prisma client');
  }

  const processor = createEmailJobProcessor({
    prisma,
    sendEmail,
    checkRateLimit,
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
