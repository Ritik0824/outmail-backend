import 'dotenv/config';
import { createApp } from './app.js';
import { closeDB, connectDB } from './config/db.js';
import { loadConfig } from './config/env.js';
import prisma from './prisma/prismaClient.js';
import { closeEmailQueue } from './queue/emailQueue.js';

const config = loadConfig();

await connectDB();
const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`OutMail API listening on http://localhost:${config.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  server.close(async () => {
    await Promise.allSettled([
      closeEmailQueue(),
      closeDB(),
      prisma.$disconnect(),
    ]);
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
