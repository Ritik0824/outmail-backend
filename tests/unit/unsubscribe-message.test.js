import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendUnsubscribeFooter,
  prepareUnsubscribeMessage,
} from '../../services/unsubscribeMessage.js';

const SECRET = 'unsubscribe-secret-that-is-longer-than-thirty-two-characters';
const NOW = new Date('2026-08-12T10:00:00.000Z');

test('appendUnsubscribeFooter preserves content and adds a preference link', () => {
  const result = appendUnsubscribeFooter('Hello Asha\n', 'https://api.example.com/unsubscribe/token');

  assert.match(result, /^Hello Asha\n\n--- OutMail preferences ---/);
  assert.match(result, /https:\/\/api\.example\.com\/unsubscribe\/token$/);
});

test('appendUnsubscribeFooter does not duplicate an existing footer', () => {
  const once = appendUnsubscribeFooter('Message', 'https://api.example.com/first');
  const twice = appendUnsubscribeFooter(once, 'https://api.example.com/second');

  assert.equal(twice, once);
  assert.ok(!twice.includes('/second'));
});

test('prepareUnsubscribeMessage creates a recipient-bound public URL', () => {
  const result = prepareUnsubscribeMessage({
    secret: SECRET,
    publicApiUrl: 'https://api.example.com/',
    userId: 'user-1',
    campaignId: 'campaign-1',
    recipientId: 'recipient-1',
    email: 'asha@example.com',
    text: 'Welcome',
    ttlDays: 30,
    now: NOW,
  });

  assert.match(result.unsubscribeUrl, /^https:\/\/api\.example\.com\/api\/unsubscribe\//);
  assert.ok(result.text.includes(result.unsubscribeUrl));
  assert.equal(result.tokenExpiresAt.toISOString(), '2026-09-11T10:00:00.000Z');
});

test('prepareUnsubscribeMessage rejects invalid security configuration', () => {
  assert.throws(
    () => prepareUnsubscribeMessage({
      secret: 'short',
      publicApiUrl: 'https://api.example.com',
      userId: 'user-1',
      campaignId: 'campaign-1',
      recipientId: 'recipient-1',
      email: 'asha@example.com',
      text: 'Welcome',
      now: NOW,
    }),
    /secret/i,
  );
});
