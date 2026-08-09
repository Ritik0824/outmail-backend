import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireDeliveryQuota,
  DeliveryQuotaError,
  deliveryQuotaHeaders,
  inspectDeliveryQuota,
  normalizeQuotaOptions,
  parseAcquireReply,
  quotaKeys,
  quotaWindows,
  resetDeliveryQuota,
} from '../../services/deliveryQuota.js';

test('normalizeQuotaOptions applies bounded production defaults', () => {
  assert.deepEqual(normalizeQuotaOptions(), {
    minuteLimit: 20,
    dailyLimit: 500,
    timezoneOffsetMinutes: 330,
    keyPrefix: 'outmail:delivery-quota',
  });
  assert.throws(
    () => normalizeQuotaOptions({ dailyLimit: 0 }),
    (error) => error instanceof DeliveryQuotaError && error.code === 'INVALID_DELIVERY_QUOTA',
  );
});

test('quotaWindows aligns the daily reset to the configured timezone', () => {
  const windows = quotaWindows(new Date('2026-08-09T18:29:30.000Z'), 330);
  assert.equal(new Date(windows.minute.resetsAt).toISOString(), '2026-08-09T18:30:00.000Z');
  assert.equal(new Date(windows.day.resetsAt).toISOString(), '2026-08-09T18:30:00.000Z');

  const nextDay = quotaWindows(new Date('2026-08-09T18:30:30.000Z'), 330);
  assert.equal(new Date(nextDay.day.resetsAt).toISOString(), '2026-08-10T18:30:00.000Z');
});

test('quotaKeys isolate users and fixed windows', () => {
  const windows = quotaWindows(new Date('2026-08-09T10:00:00.000Z'), 0);
  const keys = quotaKeys({ userId: 'user/one', windows, keyPrefix: 'quota' });
  assert.match(keys.minute, /^quota:user%2Fone:minute:/);
  assert.match(keys.day, /^quota:user%2Fone:day:/);
});

test('parseAcquireReply exposes usage, limits, and reset timestamps', () => {
  const options = normalizeQuotaOptions({ minuteLimit: 3, dailyLimit: 20 });
  const windows = quotaWindows(new Date('2026-08-09T10:00:10.000Z'));
  const quota = parseAcquireReply([1, 0, 2, 8, 'none'], options, windows);
  assert.equal(quota.allowed, true);
  assert.deepEqual(quota.usage, { minute: 2, day: 8 });
  assert.equal(quota.limitedBy, null);
});

test('acquireDeliveryQuota executes one atomic Redis script', async () => {
  let invocation;
  const redis = {
    eval: async (...args) => {
      invocation = args;
      return [1, 0, 1, 4, 'none'];
    },
  };
  const quota = await acquireDeliveryQuota({
    redis,
    userId: 'user-1',
    now: new Date('2026-08-09T10:00:10.000Z'),
    options: { minuteLimit: 10, dailyLimit: 50 },
  });
  assert.equal(invocation[1], 2);
  assert.match(invocation[2], /user-1:minute/);
  assert.match(invocation[3], /user-1:day/);
  assert.equal(quota.usage.day, 4);
});

test('acquireDeliveryQuota reports a precise delay when the minute is full', async () => {
  const quota = await acquireDeliveryQuota({
    redis: { eval: async () => [0, 12_345, 20, 100, 'minute'] },
    userId: 'user-1',
  });
  assert.equal(quota.allowed, false);
  assert.equal(quota.delayMs, 12_345);
  assert.equal(quota.limitedBy, 'minute');
  assert.equal(deliveryQuotaHeaders(quota)['Retry-After'], '13');
});

test('acquireDeliveryQuota fails closed when Redis is unavailable', async () => {
  await assert.rejects(
    acquireDeliveryQuota({
      redis: { eval: async () => { throw new Error('connection refused'); } },
      userId: 'user-1',
    }),
    (error) => error.code === 'QUOTA_STORE_UNAVAILABLE'
      && error.status === 503
      && error.details.cause === 'connection refused',
  );
});

test('inspectDeliveryQuota calculates remaining capacity without consuming it', async () => {
  const redis = { mget: async () => ['4', '40'] };
  const quota = await inspectDeliveryQuota({
    redis,
    userId: 'user-1',
    options: { minuteLimit: 10, dailyLimit: 50 },
  });
  assert.deepEqual(quota.usage, { minute: 4, day: 40 });
  assert.deepEqual(quota.remaining, { minute: 6, day: 10 });
});

test('resetDeliveryQuota removes only the current user windows', async () => {
  let deletedKeys;
  const result = await resetDeliveryQuota({
    redis: { del: async (...keys) => { deletedKeys = keys; return 2; } },
    userId: 'user-1',
  });
  assert.equal(result.removed, 2);
  assert.equal(deletedKeys.length, 2);
  assert.ok(deletedKeys.every((key) => key.includes('user-1')));
});
