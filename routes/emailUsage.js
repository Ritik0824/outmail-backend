import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { emailQueue } from '../queue/emailQueue.js';
import {
  inspectDeliveryQuota,
  quotaOptionsFromEnv,
} from '../services/deliveryQuota.js';

const router = express.Router();

router.get('/email-usage', authenticateJWT, async (req, res) => {
  try {
    const redis = await emailQueue.client;
    const quota = await inspectDeliveryQuota({
      redis,
      userId: req.user.id,
      options: quotaOptionsFromEnv(),
    });
    res.set('Cache-Control', 'private, no-store');
    res.json(quota);
  } catch (error) {
    console.error('EMAIL QUOTA ERROR:', error);
    res.status(503).json({
      error: 'Delivery quota is temporarily unavailable',
      code: error.code ?? 'DELIVERY_QUOTA_UNAVAILABLE',
    });
  }
});

export default router;
