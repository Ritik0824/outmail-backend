import express from 'express';
import Joi from 'joi';
import rateLimit from 'express-rate-limit';
import prisma from '../prisma/prismaClient.js';

const router = express.Router();

const contactSchema = Joi.object({
  email: Joi.string().email().required(),
  message: Joi.string().min(10).required(),
});

// 3 requests per hour per IP
const hourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { error: 'Too many contact requests from this IP, please try again after an hour.' },
});

// 10 requests per day per IP
const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10,
  message: { error: 'Too many contact requests from this IP, please try again after 24 hours.' },
});

router.post('/contact', hourlyLimiter, dailyLimiter, async (req, res) => {
  const { error } = contactSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const { email, message } = req.body;

  try {
    const savedMessage = await prisma.contactMessage.create({
      data: { email, message },
    });

    // 📨 Future: enqueue for email delivery:not implementing in memory queue now as we will go serverless

    res.json({ success: true, message: 'Message received!', data: savedMessage });
  } catch (err) {
    console.error('Failed to save contact message:', err);
    res.status(500).json({ error: 'Failed to save your message. Please try again later.' });
  }
});

export default router;
