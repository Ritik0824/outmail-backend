import express from 'express';
import { authenticateJWT, requireQueueAdmin } from '../middleware/auth.js';
import prisma from '../prisma/prismaClient.js';
import { emailQueue } from '../queue/emailQueue.js';
import {
  booleanOption,
  inspectCampaignIntegrity,
  reconcileCampaignBatch,
  ReconciliationError,
  repairCampaignIntegrity,
} from '../services/reconciliationService.js';

const router = express.Router();

router.use(authenticateJWT, requireQueueAdmin);

function sendOperationsError(res, error, fallback) {
  if (error instanceof ReconciliationError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
}

router.get('/campaigns/:campaignId/integrity', async (req, res) => {
  try {
    const inspection = await inspectCampaignIntegrity({
      prisma,
      queue: emailQueue,
      campaignId: req.params.campaignId,
      userId: req.user.id,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ inspection });
  } catch (error) {
    sendOperationsError(res, error, 'Failed to inspect campaign integrity');
  }
});

router.post('/campaigns/:campaignId/reconcile', async (req, res) => {
  try {
    const result = await repairCampaignIntegrity({
      prisma,
      queue: emailQueue,
      campaignId: req.params.campaignId,
      userId: req.user.id,
      dryRun: booleanOption(req.body?.dryRun, true),
    });
    res.set('Cache-Control', 'no-store');
    res.status(result.dryRun ? 200 : 202).json(result);
  } catch (error) {
    sendOperationsError(res, error, 'Failed to reconcile campaign integrity');
  }
});

router.post('/campaigns/reconcile', async (req, res) => {
  try {
    const result = await reconcileCampaignBatch({
      prisma,
      queue: emailQueue,
      userId: req.user.id,
      query: { ...req.query, ...req.body },
    });
    res.set('Cache-Control', 'no-store');
    res.status(result.dryRun ? 200 : 202).json(result);
  } catch (error) {
    sendOperationsError(res, error, 'Failed to reconcile campaign batch');
  }
});

export default router;
