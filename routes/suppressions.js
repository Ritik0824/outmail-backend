import express from 'express';
import prisma from '../prisma/prismaClient.js';
import { authenticateJWT } from '../middleware/auth.js';
import {
  addSuppression,
  addSuppressionBatch,
  getSuppressionDecision,
  listSuppressions,
  removeSuppression,
  suppressionSummary,
  SuppressionServiceError,
} from '../services/suppressionService.js';

const router = express.Router();

function sendSuppressionError(res, error, fallback) {
  if (error instanceof SuppressionServiceError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
}

router.get('/', authenticateJWT, async (req, res) => {
  try {
    const result = await listSuppressions({
      prisma,
      userId: req.user.id,
      query: req.query,
    });
    res.json(result);
  } catch (error) {
    sendSuppressionError(res, error, 'Failed to fetch suppression list');
  }
});

router.get('/summary', authenticateJWT, async (req, res) => {
  try {
    const summary = await suppressionSummary({ prisma, userId: req.user.id });
    res.json({ summary });
  } catch (error) {
    sendSuppressionError(res, error, 'Failed to summarize suppression list');
  }
});

router.get('/check', authenticateJWT, async (req, res) => {
  try {
    const result = await getSuppressionDecision({
      prisma,
      userId: req.user.id,
      email: req.query.email,
    });
    res.json(result);
  } catch (error) {
    sendSuppressionError(res, error, 'Failed to check suppression status');
  }
});

router.post('/', authenticateJWT, async (req, res) => {
  try {
    const entry = await addSuppression({
      prisma,
      userId: req.user.id,
      email: req.body.email,
      reason: req.body.reason,
      source: req.body.source,
      details: req.body.details,
    });
    res.status(201).json({ entry });
  } catch (error) {
    sendSuppressionError(res, error, 'Failed to add suppression entry');
  }
});

router.post('/batch', authenticateJWT, async (req, res) => {
  try {
    const result = await addSuppressionBatch({
      prisma,
      userId: req.user.id,
      emails: req.body.emails,
      reason: req.body.reason,
      source: req.body.source,
      details: req.body.details,
    });
    res.status(201).json(result);
  } catch (error) {
    sendSuppressionError(res, error, 'Failed to import suppression entries');
  }
});

router.delete('/:email', authenticateJWT, async (req, res) => {
  try {
    const entry = await removeSuppression({
      prisma,
      userId: req.user.id,
      email: req.params.email,
    });
    res.json({ success: true, entry });
  } catch (error) {
    sendSuppressionError(res, error, 'Failed to remove suppression entry');
  }
});

export default router;
