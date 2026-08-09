import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTerminalDeliveryEvent,
  parseDeliveryEvent,
  signDeliveryWebhook,
  suppressionReasonForDeliveryEvent,
  verifyDeliveryWebhook,
} from '../../domain/deliveryWebhook.js';

const SECRET = 'delivery-webhook-secret-that-is-at-least-thirty-two-characters';
const NOW = new Date('2026-08-12T10:00:00.000Z');
const TIMESTAMP = Math.floor(NOW.getTime() / 1_000);
const BODY = Buffer.from('{"eventId":"event-1"}');

test('a valid delivery webhook signature verifies', () => {
  const signatureHeader = signDeliveryWebhook({
    secret: SECRET,
    timestamp: TIMESTAMP,
    rawBody: BODY,
  });
  assert.equal(verifyDeliveryWebhook({
    secret: SECRET,
    timestamp: String(TIMESTAMP),
    signatureHeader,
    rawBody: BODY,
    now: NOW,
  }), true);
});

test('signature verification accepts any valid v1 value during rotation', () => {
  const valid = signDeliveryWebhook({ secret: SECRET, timestamp: TIMESTAMP, rawBody: BODY });
  assert.equal(verifyDeliveryWebhook({
    secret: SECRET,
    timestamp: TIMESTAMP,
    signatureHeader: `v1=${'0'.repeat(64)}, ${valid}`,
    rawBody: BODY,
    now: NOW,
  }), true);
});

test('signature verification binds the exact raw body', () => {
  const signatureHeader = signDeliveryWebhook({
    secret: SECRET,
    timestamp: TIMESTAMP,
    rawBody: BODY,
  });
  assert.throws(
    () => verifyDeliveryWebhook({
      secret: SECRET,
      timestamp: TIMESTAMP,
      signatureHeader,
      rawBody: Buffer.from('{"eventId":"event-2"}'),
      now: NOW,
    }),
    (error) => error.code === 'INVALID_WEBHOOK_SIGNATURE' && error.status === 401,
  );
});

test('stale and future webhook timestamps are rejected', () => {
  for (const timestamp of [TIMESTAMP - 301, TIMESTAMP + 301]) {
    const signatureHeader = signDeliveryWebhook({ secret: SECRET, timestamp, rawBody: BODY });
    assert.throws(
      () => verifyDeliveryWebhook({
        secret: SECRET,
        timestamp,
        signatureHeader,
        rawBody: BODY,
        now: NOW,
        maxSkewSeconds: 300,
      }),
      (error) => error.code === 'STALE_WEBHOOK' && error.status === 401,
    );
  }
});

test('missing or malformed signatures are rejected', () => {
  for (const signatureHeader of [null, '', 'v2=abc', 'v1=not-hex']) {
    assert.throws(
      () => verifyDeliveryWebhook({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signatureHeader,
        rawBody: BODY,
        now: NOW,
      }),
      (error) => error.code === 'INVALID_WEBHOOK_SIGNATURE',
    );
  }
});

test('parseDeliveryEvent normalizes supported provider data', () => {
  assert.deepEqual(parseDeliveryEvent({
    eventId: ' event-1 ',
    type: 'hard_bounce',
    messageId: 'provider-message-1',
    email: 'ASHA@Example.com',
    occurredAt: '2026-08-12T09:59:00.000Z',
    metadata: { responseCode: 550 },
  }), {
    eventId: 'event-1',
    type: 'hard_bounce',
    messageId: 'provider-message-1',
    email: 'asha@example.com',
    occurredAt: new Date('2026-08-12T09:59:00.000Z'),
    metadata: { responseCode: 550 },
  });
});

test('parseDeliveryEvent rejects unknown types and malformed metadata', () => {
  const base = {
    eventId: 'event-1',
    messageId: 'message-1',
    email: 'asha@example.com',
    occurredAt: NOW.toISOString(),
  };
  assert.throws(
    () => parseDeliveryEvent({ ...base, type: 'opened' }),
    (error) => error.code === 'UNSUPPORTED_DELIVERY_EVENT',
  );
  assert.throws(
    () => parseDeliveryEvent({ ...base, type: 'delivered', metadata: [] }),
    (error) => error.code === 'INVALID_DELIVERY_EVENT'
      && error.details.field === 'metadata',
  );
});

test('hard bounces and complaints map to suppression reasons', () => {
  assert.equal(suppressionReasonForDeliveryEvent('hard_bounce'), 'hard_bounce');
  assert.equal(suppressionReasonForDeliveryEvent('complaint'), 'complaint');
  assert.equal(suppressionReasonForDeliveryEvent('soft_bounce'), null);
  assert.equal(suppressionReasonForDeliveryEvent('delivered'), null);
});

test('terminal provider events are classified explicitly', () => {
  assert.equal(isTerminalDeliveryEvent('delivered'), true);
  assert.equal(isTerminalDeliveryEvent('hard_bounce'), true);
  assert.equal(isTerminalDeliveryEvent('complaint'), true);
  assert.equal(isTerminalDeliveryEvent('soft_bounce'), false);
});
