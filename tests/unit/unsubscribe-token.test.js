import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUnsubscribeToken,
  maskEmailAddress,
  unsubscribeUrl,
  UnsubscribeTokenError,
  verifyUnsubscribeToken,
} from '../../domain/unsubscribeToken.js';

const SECRET = 'unsubscribe-secret-that-is-longer-than-thirty-two-characters';
const NOW = new Date('2026-08-12T10:00:00.000Z');

function token(overrides = {}) {
  return createUnsubscribeToken({
    secret: SECRET,
    userId: 'user-1',
    campaignId: 'campaign-1',
    recipientId: 'recipient-1',
    email: 'Asha@Example.com',
    now: NOW,
    ttlDays: 30,
    ...overrides,
  });
}

test('createUnsubscribeToken round-trips signed recipient identity', () => {
  const verified = verifyUnsubscribeToken({ secret: SECRET, token: token(), now: NOW });

  assert.equal(verified.userId, 'user-1');
  assert.equal(verified.campaignId, 'campaign-1');
  assert.equal(verified.recipientId, 'recipient-1');
  assert.equal(verified.email, 'asha@example.com');
  assert.equal(verified.expiresAt - verified.issuedAt, 30 * 86_400);
});

test('the same inputs produce a stable token for one issuance time', () => {
  assert.equal(token(), token());
});

test('a one-character payload change invalidates the signature', () => {
  const value = token();
  const replacement = value[0] === 'a' ? 'b' : 'a';
  const tampered = `${replacement}${value.slice(1)}`;

  assert.throws(
    () => verifyUnsubscribeToken({ secret: SECRET, token: tampered, now: NOW }),
    (error) => error.code === 'INVALID_UNSUBSCRIBE_SIGNATURE',
  );
});

test('a token cannot be verified with a different secret', () => {
  assert.throws(
    () => verifyUnsubscribeToken({
      secret: 'different-secret-that-is-also-longer-than-thirty-two-characters',
      token: token(),
      now: NOW,
    }),
    /invalid/i,
  );
});

test('expired tokens are rejected outside the clock tolerance', () => {
  assert.throws(
    () => verifyUnsubscribeToken({
      secret: SECRET,
      token: token({ ttlDays: 1 }),
      now: new Date('2026-08-13T10:01:01.000Z'),
    }),
    (error) => error.code === 'UNSUBSCRIBE_TOKEN_EXPIRED',
  );
});

test('tokens issued too far in the future are rejected', () => {
  assert.throws(
    () => verifyUnsubscribeToken({
      secret: SECRET,
      token: token({ now: new Date('2026-08-12T10:02:00.000Z') }),
      now: NOW,
    }),
    (error) => error.code === 'UNSUBSCRIBE_TOKEN_NOT_ACTIVE',
  );
});

test('malformed and oversized tokens are rejected before parsing', () => {
  for (const value of [null, '', 'one-part', 'a.b.c', 'a'.repeat(4_097)]) {
    assert.throws(
      () => verifyUnsubscribeToken({ secret: SECRET, token: value, now: NOW }),
      (error) => error instanceof UnsubscribeTokenError
        && error.code === 'MALFORMED_UNSUBSCRIBE_TOKEN',
    );
  }
});

test('token creation validates secret length and token lifetime', () => {
  assert.throws(
    () => token({ secret: 'short' }),
    (error) => error.code === 'INVALID_UNSUBSCRIBE_SECRET',
  );
  for (const ttlDays of [0, 366, 1.5]) {
    assert.throws(
      () => token({ ttlDays }),
      (error) => error.code === 'INVALID_UNSUBSCRIBE_TTL',
    );
  }
});

test('unsubscribeUrl encodes the token and normalizes the API origin', () => {
  assert.equal(
    unsubscribeUrl({ publicApiUrl: 'https://api.example.com/', token: 'payload.signature' }),
    'https://api.example.com/api/unsubscribe/payload.signature',
  );
  assert.throws(
    () => unsubscribeUrl({ publicApiUrl: 'javascript:alert(1)', token: 'value' }),
    (error) => error.code === 'INVALID_PUBLIC_API_URL',
  );
});

test('maskEmailAddress hides most of the local part', () => {
  assert.equal(maskEmailAddress('asha@example.com'), 'as**@example.com');
  assert.equal(maskEmailAddress('a@example.com'), 'a*@example.com');
});
