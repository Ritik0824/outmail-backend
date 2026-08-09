import jwt from 'jsonwebtoken';

export const AUTH_COOKIE_NAME = 'outmail_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function createAuthToken(user) {
  return jwt.sign({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    google_id: user.google_id,
    isFirstTime: !user.app_password_hash,
  }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}
