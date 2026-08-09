import express from 'express';
import { CampaignAnalyticsError } from '../domain/campaignAnalytics.js';
import { authenticateJWT } from '../middleware/auth.js';
import prisma from '../prisma/prismaClient.js';
import {
  AnalyticsServiceError,
  getAnalyticsOverview,
  getCampaignAnalytics,
  getDeliveryTrends,
} from '../services/analyticsService.js';

const router = express.Router();

function sendAnalyticsError(res, error, fallback) {
  if (error instanceof AnalyticsServiceError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  if (error instanceof CampaignAnalyticsError) {
    return res.status(400).json({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
}

router.get('/overview', authenticateJWT, async (req, res) => {
  try {
    const analytics = await getAnalyticsOverview({
      prisma,
      userId: req.user.id,
      query: req.query,
    });
    res.set('Cache-Control', 'private, max-age=30');
    res.json({ analytics });
  } catch (error) {
    sendAnalyticsError(res, error, 'Failed to build analytics overview');
  }
});

router.get('/trends', authenticateJWT, async (req, res) => {
  try {
    const trends = await getDeliveryTrends({
      prisma,
      userId: req.user.id,
      query: req.query,
    });
    res.set('Cache-Control', 'private, max-age=30');
    res.json({ trends });
  } catch (error) {
    sendAnalyticsError(res, error, 'Failed to build delivery trends');
  }
});

router.get('/campaigns/:campaignId', authenticateJWT, async (req, res) => {
  try {
    const analytics = await getCampaignAnalytics({
      prisma,
      campaignId: req.params.campaignId,
      userId: req.user.id,
      query: req.query,
    });
    res.set('Cache-Control', 'private, max-age=15');
    res.json({ analytics });
  } catch (error) {
    sendAnalyticsError(res, error, 'Failed to build campaign analytics');
  }
});

export default router;
