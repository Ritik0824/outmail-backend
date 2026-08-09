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

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

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

export default router;
