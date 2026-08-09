import express from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../prisma/prismaClient.js';
import { emailQueue } from '../queue/emailQueue.js';
import {
  confirmUnsubscribe,
  previewUnsubscribe,
  UnsubscribeServiceError,
} from '../services/unsubscribeService.js';

const router = express.Router();
const unsubscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many unsubscribe requests. Please try again later.',
    code: 'UNSUBSCRIBE_RATE_LIMITED',
  },
});

router.use(unsubscribeLimiter);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  next();
});

function sendUnsubscribeError(res, error) {
  if (error instanceof UnsubscribeServiceError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error('UNSUBSCRIBE ERROR:', error);
  return res.status(500).json({
    error: 'The unsubscribe request could not be completed',
    code: 'UNSUBSCRIBE_FAILED',
  });
}

router.get('/:token', async (req, res) => {
  try {
    const result = await previewUnsubscribe({
      prisma,
      secret: process.env.UNSUBSCRIBE_SECRET,
      token: req.params.token,
    });
    res.json(result);
  } catch (error) {
    sendUnsubscribeError(res, error);
  }
});

router.post('/:token', async (req, res) => {
  try {
    const result = await confirmUnsubscribe({
      prisma,
      queue: emailQueue,
      secret: process.env.UNSUBSCRIBE_SECRET,
      token: req.params.token,
    });
    res.json(result);
  } catch (error) {
    sendUnsubscribeError(res, error);
  }
});

export default router;
