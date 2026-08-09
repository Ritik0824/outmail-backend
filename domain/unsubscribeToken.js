import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeEmailAddress } from './emailAddress.js';

const TOKEN_VERSION = 1;
const SECONDS_PER_DAY = 86_400;
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4_096;

export class UnsubscribeTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UnsubscribeTokenError';
    this.code = code;
  }
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new UnsubscribeTokenError(
      'INVALID_UNSUBSCRIBE_SECRET',
      'Unsubscribe token secret must contain at least 32 characters',
    );
  }
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signatureFor(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function requiredIdentifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new UnsubscribeTokenError(
      'INVALID_UNSUBSCRIBE_PAYLOAD',
      `${name} is required in an unsubscribe token`,
    );
  }
  return value.trim();
}

function unixSeconds(date) {
  const value = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(value)) {
    throw new UnsubscribeTokenError('INVALID_UNSUBSCRIBE_TIME', 'Token time is invalid');
  }
  return Math.floor(value / 1_000);
}

export function createUnsubscribeToken({
  secret,
  userId,
  campaignId,
  recipientId,
  email,
  now = new Date(),
  ttlDays = 90,
}) {
  assertSecret(secret);
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
    throw new UnsubscribeTokenError(
      'INVALID_UNSUBSCRIBE_TTL',
      'Unsubscribe token lifetime must be between 1 and 365 days',
    );
  }
  const issuedAt = unixSeconds(now);
  const payload = encode(JSON.stringify({
    v: TOKEN_VERSION,
    u: requiredIdentifier(userId, 'userId'),
    c: requiredIdentifier(campaignId, 'campaignId'),
    r: requiredIdentifier(recipientId, 'recipientId'),
    e: normalizeEmailAddress(email),
    iat: issuedAt,
    exp: issuedAt + (ttlDays * SECONDS_PER_DAY),
  }));
  return `${payload}.${signatureFor(payload, secret)}`;
}

function parsePayload(encodedPayload) {
  try {
    const value = JSON.parse(decode(encodedPayload));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new UnsubscribeTokenError('MALFORMED_UNSUBSCRIBE_TOKEN', 'Unsubscribe token is malformed');
  }
}

function assertValidSignature(encodedPayload, suppliedSignature, secret) {
  const expected = Buffer.from(signatureFor(encodedPayload, secret));
  const supplied = Buffer.from(suppliedSignature || '');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new UnsubscribeTokenError('INVALID_UNSUBSCRIBE_SIGNATURE', 'Unsubscribe token is invalid');
  }
}

export function verifyUnsubscribeToken({ secret, token, now = new Date() }) {
  assertSecret(secret);
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) {
    throw new UnsubscribeTokenError('MALFORMED_UNSUBSCRIBE_TOKEN', 'Unsubscribe token is malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UnsubscribeTokenError('MALFORMED_UNSUBSCRIBE_TOKEN', 'Unsubscribe token is malformed');
  }
  const [encodedPayload, suppliedSignature] = parts;
  assertValidSignature(encodedPayload, suppliedSignature, secret);
  const payload = parsePayload(encodedPayload);
  if (payload.v !== TOKEN_VERSION) {
    throw new UnsubscribeTokenError('UNSUPPORTED_UNSUBSCRIBE_TOKEN', 'Unsubscribe token version is unsupported');
  }

  const verified = {
    userId: requiredIdentifier(payload.u, 'userId'),
    campaignId: requiredIdentifier(payload.c, 'campaignId'),
    recipientId: requiredIdentifier(payload.r, 'recipientId'),
    email: normalizeEmailAddress(payload.e),
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
  if (!Number.isInteger(verified.issuedAt) || !Number.isInteger(verified.expiresAt)) {
    throw new UnsubscribeTokenError('INVALID_UNSUBSCRIBE_PAYLOAD', 'Token timestamps are invalid');
  }
  if (verified.expiresAt <= verified.issuedAt
    || verified.expiresAt - verified.issuedAt > 365 * SECONDS_PER_DAY) {
    throw new UnsubscribeTokenError('INVALID_UNSUBSCRIBE_PAYLOAD', 'Token lifetime is invalid');
  }

  const currentTime = unixSeconds(now);
  if (verified.issuedAt > currentTime + CLOCK_TOLERANCE_SECONDS) {
    throw new UnsubscribeTokenError('UNSUBSCRIBE_TOKEN_NOT_ACTIVE', 'Unsubscribe token is not active yet');
  }
  if (verified.expiresAt < currentTime - CLOCK_TOLERANCE_SECONDS) {
    throw new UnsubscribeTokenError('UNSUBSCRIBE_TOKEN_EXPIRED', 'Unsubscribe token has expired');
  }
  return verified;
}

export function unsubscribeUrl({ publicApiUrl, token }) {
  if (typeof publicApiUrl !== 'string' || !/^https?:\/\//.test(publicApiUrl)) {
    throw new UnsubscribeTokenError('INVALID_PUBLIC_API_URL', 'Public API URL is invalid');
  }
  return `${publicApiUrl.replace(/\/$/, '')}/api/unsubscribe/${encodeURIComponent(token)}`;
}

export function maskEmailAddress(email) {
  const normalized = normalizeEmailAddress(email);
  const [localPart, domain] = normalized.split('@');
  const visible = localPart.length <= 2 ? localPart[0] : localPart.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, localPart.length - visible.length))}@${domain}`;
}
