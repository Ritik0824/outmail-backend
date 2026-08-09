import { encrypt } from '../utils/encryption.js';
import prisma from '../prisma/prismaClient.js';
import { createAuthToken, setAuthCookie } from '../utils/authToken.js';

export const myDetails = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        google_id: true,
        email: true,
        display_name: true,
        created_at: true,
        last_login: true,
        isFirstTime: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
}


export const updateName = async (req, res) => {
  const name = req.body.name?.trim();
  if (!name || name.length > 100) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { display_name: name },
    });

    const { app_password_hash, ...userSafe } = user;
    setAuthCookie(res, createAuthToken(user));
    res.json({ user: userSafe });
  } catch (err) {
    console.error('Update name error:', err);
    res.status(500).json({ error: 'Failed to update name.' });
  }
};

/**
 * Stores the authenticated user's Gmail app password after OAuth sign-in.
 * The caller cannot select or create a different user through this endpoint.
 */
export const handleLogin = async (req, res) => {
  const displayName = req.body.display_name?.trim();
  const appPassword = req.body.app_password || req.body.app_password_hash;

  if (!appPassword || typeof appPassword !== 'string' || appPassword.length > 512) {
    return res.status(400).json({ error: 'App password is required' });
  }
  if (displayName && displayName.length > 100) {
    return res.status(400).json({ error: 'Display name is too long' });
  }

  try {
    const encryptedPassword = encrypt(appPassword);
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        app_password_hash: encryptedPassword,
        display_name: displayName || undefined,
        isFirstTime: false,
      },
    });

    const { app_password_hash: _, ...userSafe } = user;
    setAuthCookie(res, createAuthToken(user));
    res.status(200).json({ user: userSafe });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
