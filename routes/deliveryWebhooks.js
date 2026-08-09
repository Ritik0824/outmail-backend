import express from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../prisma/prismaClient.js';
import {
  DeliveryWebhookError,
  verifyDeliveryWebhook,
} from '../domain/deliveryWebhook.js';
import {
  DeliveryEventServiceError,
  ingestDeliveryEvent,
} from '../services/deliveryEventService.js';

const router = express.Router();
const webhookLimiter = rateLimit({
  windowMs: 60 * 1_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Webhook rate limit exceeded', code: 'WEBHOOK_RATE_LIMITED' },
});

router.use(webhookLimiter);

function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new DeliveryWebhookError('INVALID_WEBHOOK_JSON', 'Webhook body must be valid JSON');
  }
}

function sendWebhookError(res, error) {
  if (error instanceof DeliveryWebhookError || error instanceof DeliveryEventServiceError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  console.error('DELIVERY WEBHOOK ERROR:', error);
  return res.status(500).json({ error: 'Delivery webhook failed', code: 'WEBHOOK_FAILED' });
}

router.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    verifyDeliveryWebhook({
      secret: process.env.DELIVERY_WEBHOOK_SECRET,
      timestamp: req.get('x-outmail-timestamp'),
      signatureHeader: req.get('x-outmail-signature'),
      rawBody: req.body,
      maxSkewSeconds: Number(process.env.DELIVERY_WEBHOOK_MAX_SKEW_SECONDS || 300),
    });
    const value = parseJsonBody(req.body);
    const result = await ingestDeliveryEvent({
      prisma,
      value,
      rawPayload: value,
    });
    res.status(202).json({ received: true, ...result });
  } catch (error) {
    sendWebhookError(res, error);
  }
});

export default router;
