import express from 'express';
import multer from 'multer';
import prisma from '../prisma/prismaClient.js';
import { authenticateJWT } from '../middleware/auth.js';
import { emailQueue } from '../queue/emailQueue.js';
import { deleteCsvFromS3, uploadCsvToS3 } from '../utils/s3.js';
import {
  CampaignCreationError,
  createAndQueueCampaign,
} from '../services/campaignCreation.js';
import {
  CampaignManagementError,
  getCampaignOverview,
  getRecipientAttempts,
  listCampaignRecipients,
  requeueCampaign,
} from '../services/campaignManagement.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function sendManagementError(res, error, fallbackMessage) {
  if (error instanceof CampaignManagementError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ error: fallbackMessage });
}

router.get('/mine', authenticateJWT, async (req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { user_id: req.user.id },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        created_at: true,
        started_at: true,
        completed_at: true,
        total_emails: true,
        sent_emails: true,
        failed_emails: true,
        cancelled_emails: true,
      },
    });
    res.json({ campaigns });
  } catch {
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

router.post('/start', authenticateJWT, upload.single('csv'), async (req, res) => {
  try {
    const result = await createAndQueueCampaign({
      prisma,
      queue: emailQueue,
      uploadRecipientFile: uploadCsvToS3,
      deleteRecipientFile: deleteCsvFromS3,
      userId: req.user.id,
      file: req.file,
      input: req.body,
    });

    res.status(202).json({ success: true, ...result });
  } catch (error) {
    console.error('CAMPAIGN START ERROR:', error);
    if (error instanceof CampaignCreationError) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...error.details,
      });
    }
    res.status(500).json({ error: 'Failed to start campaign.' });
  }
});

router.get('/:campaignId', authenticateJWT, async (req, res) => {
  try {
    const campaign = await getCampaignOverview({
      prisma,
      campaignId: req.params.campaignId,
      userId: req.user.id,
    });
    res.json({ campaign });
  } catch (error) {
    sendManagementError(res, error, 'Failed to fetch campaign');
  }
});

router.get('/:campaignId/recipients', authenticateJWT, async (req, res) => {
  try {
    const result = await listCampaignRecipients({
      prisma,
      campaignId: req.params.campaignId,
      userId: req.user.id,
      query: req.query,
    });
    res.json(result);
  } catch (error) {
    sendManagementError(res, error, 'Failed to fetch campaign recipients');
  }
});

router.get('/:campaignId/recipients/:recipientId/attempts', authenticateJWT, async (req, res) => {
  try {
    const recipient = await getRecipientAttempts({
      prisma,
      campaignId: req.params.campaignId,
      recipientId: req.params.recipientId,
      userId: req.user.id,
    });
    res.json({ recipient });
  } catch (error) {
    sendManagementError(res, error, 'Failed to fetch delivery attempts');
  }
});

router.post('/:campaignId/requeue', authenticateJWT, async (req, res) => {
  try {
    const result = await requeueCampaign({
      prisma,
      queue: emailQueue,
      campaignId: req.params.campaignId,
      userId: req.user.id,
    });
    res.status(202).json({ success: true, ...result });
  } catch (error) {
    sendManagementError(res, error, 'Failed to requeue campaign');
  }
});

export default router;
