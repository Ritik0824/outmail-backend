import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeEmailAddress } from './emailAddress.js';

export const DELIVERY_EVENT_TYPE = Object.freeze({
  DELIVERED: 'delivered',
  SOFT_BOUNCE: 'soft_bounce',
  HARD_BOUNCE: 'hard_bounce',
  COMPLAINT: 'complaint',
});

export class DeliveryWebhookError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'DeliveryWebhookError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new DeliveryWebhookError(
      'INVALID_WEBHOOK_SECRET',
      'Delivery webhook secret must contain at least 32 characters',
      { status: 500 },
    );
  }
}

function timestampSeconds(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DeliveryWebhookError(
      'INVALID_WEBHOOK_TIMESTAMP',
      'Delivery webhook timestamp is invalid',
      { status: 401 },
    );
  }
  return parsed;
}

function bodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody);
  throw new DeliveryWebhookError('INVALID_WEBHOOK_BODY', 'Raw webhook body is required');
}

function signatureDigest({ secret, timestamp, rawBody }) {
  const prefix = Buffer.from(`${timestamp}.`);
  return createHmac('sha256', secret)
    .update(Buffer.concat([prefix, bodyBuffer(rawBody)]))
    .digest('hex');
}

export function signDeliveryWebhook({ secret, timestamp, rawBody }) {
  assertSecret(secret);
  const parsedTimestamp = timestampSeconds(timestamp);
  return `v1=${signatureDigest({ secret, timestamp: parsedTimestamp, rawBody })}`;
}

function suppliedDigests(signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.trim()) return [];
  return signatureHeader
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3))
    .filter((digest) => /^[a-f0-9]{64}$/i.test(digest));
}

export function verifyDeliveryWebhook({
  secret,
  timestamp,
  signatureHeader,
  rawBody,
  now = new Date(),
  maxSkewSeconds = 300,
}) {
  assertSecret(secret);
  const parsedTimestamp = timestampSeconds(timestamp);
  if (!Number.isInteger(maxSkewSeconds) || maxSkewSeconds < 1) {
    throw new DeliveryWebhookError(
      'INVALID_WEBHOOK_SKEW',
      'Webhook clock-skew allowance is invalid',
      { status: 500 },
    );
  }
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (Math.abs(nowSeconds - parsedTimestamp) > maxSkewSeconds) {
    throw new DeliveryWebhookError(
      'STALE_WEBHOOK',
      'Delivery webhook timestamp is outside the accepted window',
      { status: 401 },
    );
  }

  const expected = Buffer.from(signatureDigest({
    secret,
    timestamp: parsedTimestamp,
    rawBody,
  }));
  const matches = suppliedDigests(signatureHeader).some((digest) => {
    const supplied = Buffer.from(digest);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!matches) {
    throw new DeliveryWebhookError(
      'INVALID_WEBHOOK_SIGNATURE',
      'Delivery webhook signature is invalid',
      { status: 401 },
    );
  }
  return true;
}

function requiredString(value, field, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new DeliveryWebhookError(
      'INVALID_DELIVERY_EVENT',
      `${field} is required`,
      { details: { field } },
    );
  }
  return value.trim();
}

export function parseDeliveryEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeliveryWebhookError('INVALID_DELIVERY_EVENT', 'Delivery event must be an object');
  }
  const type = requiredString(value.type, 'type', 50);
  if (!Object.values(DELIVERY_EVENT_TYPE).includes(type)) {
    throw new DeliveryWebhookError(
      'UNSUPPORTED_DELIVERY_EVENT',
      `Unsupported delivery event type: ${type}`,
      { details: { type } },
    );
  }
  const occurredAt = new Date(value.occurredAt);
  if (!value.occurredAt || Number.isNaN(occurredAt.getTime())) {
    throw new DeliveryWebhookError(
      'INVALID_DELIVERY_EVENT',
      'occurredAt must be a valid timestamp',
      { details: { field: 'occurredAt' } },
    );
  }
  const metadata = value.metadata == null ? {} : value.metadata;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new DeliveryWebhookError(
      'INVALID_DELIVERY_EVENT',
      'metadata must be an object',
      { details: { field: 'metadata' } },
    );
  }
  return {
    eventId: requiredString(value.eventId, 'eventId', 200),
    type,
    messageId: requiredString(value.messageId, 'messageId'),
    email: normalizeEmailAddress(value.email),
    occurredAt,
    metadata,
  };
}

export function suppressionReasonForDeliveryEvent(type) {
  if (type === DELIVERY_EVENT_TYPE.HARD_BOUNCE) return 'hard_bounce';
  if (type === DELIVERY_EVENT_TYPE.COMPLAINT) return 'complaint';
  return null;
}

export function isTerminalDeliveryEvent(type) {
  return [
    DELIVERY_EVENT_TYPE.DELIVERED,
    DELIVERY_EVENT_TYPE.HARD_BOUNCE,
    DELIVERY_EVENT_TYPE.COMPLAINT,
  ].includes(type);
}
