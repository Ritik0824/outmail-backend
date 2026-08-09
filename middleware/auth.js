import jwt from 'jsonwebtoken';
import { AUTH_COOKIE_NAME } from '../utils/authToken.js';

export function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : null;
  const token = bearerToken || req.cookies?.[AUTH_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.user = user;
    next();
  });
}

export function requireQueueAdmin(req, res, next) {
  const allowedEmails = (process.env.QUEUE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (!req.user?.email || !allowedEmails.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ error: 'Queue administrator access required' });
  }

  next();
}
