import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emailDomain,
  EmailAddressError,
  normalizeEmailAddress,
  normalizeEmailList,
  sameEmailAddress,
} from '../../domain/emailAddress.js';
import {
  canRemoveSuppression,
  strongerSuppressionReason,
  suppressionDecision,
} from '../../domain/suppression.js';

test('normalizeEmailAddress trims and canonicalizes case', () => {
  assert.equal(normalizeEmailAddress('  Asha.Sharma@Example.COM '), 'asha.sharma@example.com');
});

test('normalizeEmailAddress converts international domains to ASCII', () => {
  assert.equal(normalizeEmailAddress('person@bücher.de'), 'person@xn--bcher-kva.de');
});

test('normalizeEmailAddress preserves meaningful local-part symbols', () => {
  assert.equal(normalizeEmailAddress('first+campaign@example.com'), 'first+campaign@example.com');
});

test('normalizeEmailAddress rejects malformed addresses', () => {
  for (const value of [null, '', 'missing-at.example.com', 'two@@example.com', '.start@example.com']) {
    assert.throws(
      () => normalizeEmailAddress(value),
      (error) => error instanceof EmailAddressError
        && ['EMAIL_REQUIRED', 'INVALID_EMAIL'].includes(error.code),
    );
  }
});

test('normalizeEmailAddress rejects invalid domain labels', () => {
  for (const value of ['user@localhost', 'user@-example.com', 'user@example-.com']) {
    assert.throws(() => normalizeEmailAddress(value), /invalid/i);
  }
});

test('emailDomain returns the canonical domain', () => {
  assert.equal(emailDomain('User@Example.COM'), 'example.com');
});

test('sameEmailAddress compares normalized values and handles invalid input', () => {
  assert.equal(sameEmailAddress('USER@example.com', 'user@EXAMPLE.com'), true);
  assert.equal(sameEmailAddress('user@example.com', 'other@example.com'), false);
  assert.equal(sameEmailAddress('invalid', 'invalid'), false);
});

test('normalizeEmailList preserves first-seen order and removes duplicates', () => {
  assert.deepEqual(normalizeEmailList([
    'A@example.com',
    'b@example.com',
    'a@EXAMPLE.com',
  ]), ['a@example.com', 'b@example.com']);
});

test('normalizeEmailList reports every invalid position', () => {
  assert.throws(
    () => normalizeEmailList(['valid@example.com', 'bad', 'also-bad']),
    (error) => error.code === 'INVALID_EMAIL_LIST'
      && error.details.invalid[0].index === 1
      && error.details.invalid[1].index === 2,
  );
});

test('normalizeEmailList enforces a batch maximum', () => {
  assert.throws(
    () => normalizeEmailList(['one@example.com', 'two@example.com'], { maximum: 1 }),
    (error) => error.code === 'TOO_MANY_EMAILS' && error.details.maximum === 1,
  );
});

test('stronger suppression reasons cannot be overwritten by weaker ones', () => {
  assert.equal(strongerSuppressionReason('hard_bounce', 'manual'), 'hard_bounce');
  assert.equal(strongerSuppressionReason('manual', 'complaint'), 'complaint');
  assert.equal(strongerSuppressionReason(null, 'unsubscribed'), 'unsubscribed');
});

test('only manual suppressions can be removed from the dashboard', () => {
  assert.equal(canRemoveSuppression('manual'), true);
  assert.equal(canRemoveSuppression('unsubscribed'), false);
  assert.equal(canRemoveSuppression('hard_bounce'), false);
});

test('suppressionDecision ignores removed records', () => {
  assert.deepEqual(suppressionDecision(null), {
    suppressed: false,
    reason: null,
    source: null,
  });
  assert.equal(suppressionDecision({
    reason: 'manual',
    source: 'dashboard',
    removed_at: new Date(),
  }).suppressed, false);
  assert.deepEqual(suppressionDecision({
    reason: 'complaint',
    source: 'provider_webhook',
    removed_at: null,
  }), {
    suppressed: true,
    reason: 'complaint',
    source: 'provider_webhook',
  });
});
