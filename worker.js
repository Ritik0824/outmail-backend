import 'dotenv/config';
import { loadConfig } from './config/env.js';
import prisma from './prisma/prismaClient.js';
import { createEmailWorker } from './queue/emailWorker.js';

loadConfig();
const worker = createEmailWorker({ prisma });

async function shutdown(signal) {
  console.log(`[Worker] Received ${signal}; shutting down`);
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
