import express from 'express';
import passport from '../config/passport.js';
import { handleLogin } from '../controllers/authController.js';
import { updateName } from '../controllers/authController.js';
import { myDetails } from '../controllers/authController.js';
import prisma from '../prisma/prismaClient.js';
import { authenticateJWT } from '../middleware/auth.js';
import { clearAuthCookie, createAuthToken, setAuthCookie } from '../utils/authToken.js';

const router = express.Router();

router.post('/login', authenticateJWT, handleLogin);

router.post('/update-name', authenticateJWT, updateName);

router.get('/me', authenticateJWT, myDetails);

router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

// Start Google OAuth
router.get(
  '/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    prompt: 'select_account consent',
  }),
);

// Google OAuth callback
router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/login',
    session: false,
  }),
  async (req, res) => {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { last_login: new Date() }
    });
    setAuthCookie(res, createAuthToken(user));
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:8080'}/dashboard`);
  }
);

export default router;
