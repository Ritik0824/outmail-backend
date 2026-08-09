import express from 'express';
import { authenticateJWT, requireQueueAdmin } from '../middleware/auth.js';
import prisma from '../prisma/prismaClient.js';
import { emailQueue } from '../queue/emailQueue.js';
import {
  buildHealthReport,
  publicHealthReport,
} from '../services/healthService.js';

const router = express.Router();

function readinessStatus(report) {
  return report.ready ? 200 : 503;
}

router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.get('/ready', async (_req, res) => {
  try {
    const report = await buildHealthReport({
      prisma,
      queue: emailQueue,
      timeoutMs: 2_000,
      includeRuntime: false,
    });
    res.set('Cache-Control', 'no-store');
    res.status(readinessStatus(report)).json(publicHealthReport(report));
  } catch (error) {
    console.error('READINESS CHECK ERROR:', error);
    res.status(503).json({ status: 'unhealthy', ready: false });
  }
});

router.get('/details', authenticateJWT, requireQueueAdmin, async (_req, res) => {
  try {
    const report = await buildHealthReport({
      prisma,
      queue: emailQueue,
      timeoutMs: 3_000,
      includeRuntime: true,
    });
    res.set('Cache-Control', 'no-store');
    res.status(readinessStatus(report)).json(report);
  } catch (error) {
    console.error('DETAILED HEALTH CHECK ERROR:', error);
    res.status(503).json({ status: 'unhealthy', ready: false });
  }
});

export default router;
