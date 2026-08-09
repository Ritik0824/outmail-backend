import express from 'express';
import prisma from '../prisma/prismaClient.js';
import { authenticateJWT } from '../middleware/auth.js';

const router = express.Router();

// Create a new template
router.post('/', authenticateJWT, async (req, res) => {
  const { name, subject, html_content } = req.body;
  const user_id = req.user.id;
  if (!name || !subject || !html_content) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try { 
    const template = await prisma.emailTemplate.create({
      data: { name, subject, html_content, user_id },
    });
    res.json(template);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create template.' });
  }
});

// Get all templates for the logged-in user
router.get('/', authenticateJWT, async (req, res) => {
  const user_id = req.user.id;
  try {
    const templates = await prisma.emailTemplate.findMany({
      where: { user_id },
      orderBy: { created_at: 'desc' },
    });
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch templates.' });
  }
});

// Update a template
router.put('/:id', authenticateJWT, async (req, res) => {
  const { name, subject, html_content } = req.body;
  const { id } = req.params;
  const user_id = req.user.id;
  if (!name || !subject || !html_content) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const updated = await prisma.emailTemplate.updateMany({
      where: { id, user_id },
      data: { name, subject, html_content },
    });
    if (updated.count === 0) {
      return res.status(404).json({ error: 'Template not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update template.' });
  }
});

// Delete a template
router.delete('/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const user_id = req.user.id;
  try {
    const deleted = await prisma.emailTemplate.deleteMany({
      where: { id, user_id },
    });
    if (deleted.count === 0) {
      return res.status(404).json({ error: 'Template not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete template.' });
  }
});

export default router;
