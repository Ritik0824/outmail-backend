import 'dotenv/config';
import prisma from './prisma/prismaClient.js';
import { createEmailWorker } from './queue/emailWorker.js';

const worker = createEmailWorker({ prisma });

async function shutdown(signal) {
  console.log(`[Worker] Received ${signal}; shutting down`);
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
