import assert from 'node:assert/strict';
import test from 'node:test';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { createEmailJobProcessor } from '../../services/emailDelivery.js';

function createDeliveryStore({
  recipientStatus = 'queued',
  campaignStatus = 'scheduled',
  user = {},
  failSuccessPersistence = false,
} = {}) {
  const state = {
    recipient: { id: 'recipient-1', status: recipientStatus, last_error: null },
    campaign: {
      id: 'campaign-1',
      status: campaignStatus,
      total_emails: 1,
      sent_emails: 0,
      failed_emails: 0,
      cancelled_emails: 0,
      suppressed_emails: 0,
      started_at: null,
      completed_at: null,
    },
    attempts: new Map(),
    logs: [],
    events: [],
  };

  const transaction = {
    deliveryAttempt: {
      upsert: async ({ create, update }) => {
        const existing = state.attempts.get(create.attempt_number);
        const next = existing ? { ...existing, ...update } : { ...create };
        state.attempts.set(create.attempt_number, next);
        return next;
      },
    },
    campaignRecipient: {
      updateMany: async ({ data }) => {
        if (['sent', 'failed'].includes(state.recipient.status)) return { count: 0 };
        Object.assign(state.recipient, data);
        return { count: 1 };
      },
    },
    campaign: {
      updateMany: async ({ data }) => {
        if (state.campaign.started_at) return { count: 0 };
        Object.assign(state.campaign, data);
        return { count: 1 };
      },
      update: async ({ data }) => {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            state.campaign[key] += value.increment;
          } else {
            state.campaign[key] = value;
          }
        }
        return { ...state.campaign };
      },
    },
    emailLog: {
      create: async ({ data }) => { state.logs.push(data); return data; },
    },
    campaignEvent: {
      create: async ({ data }) => { state.events.push(data); return data; },
    },
  };

  const prisma = {
    campaignRecipient: {
      findFirst: async () => ({
        id: state.recipient.id,
        status: state.recipient.status,
        campaign: { status: state.campaign.status },
      }),
      updateMany: async ({ data }) => {
        Object.assign(state.recipient, data);
        return { count: 1 };
      },
    },
    emailTemplate: { findFirst: async () => null },
    resume: { findMany: async () => [] },
    user: {
      findUnique: async () => (user === null ? null : {
        id: 'user-1',
        email: 'sender@example.com',
        ...user,
      }),
    },
    $transaction: async (work) => {
      if (failSuccessPersistence && state.attempts.get(1)?.status === 'processing') {
        throw new Error('database unavailable after send');
      }
      return work(transaction);
    },
  };

  return { prisma, state };
}

function createJob(overrides = {}) {
  return {
    id: 'job-1',
    attemptsMade: 0,
    opts: { attempts: 3 },
    token: 'worker-token',
    data: {
      campaignId: 'campaign-1',
      userId: 'user-1',
      recipientId: 'recipient-1',
      recipient: { email: 'asha@example.com', name: 'Asha' },
      templateId: null,
      resumeIds: [],
      subject: 'Hello Asha',
      body: 'Welcome Asha',
    },
    moveToDelayed: async () => {},
    ...overrides,
  };
}

function createProcessor(store, overrides = {}) {
  return createEmailJobProcessor({
    prisma: store.prisma,
    sendEmail: async () => ({ success: true, messageId: 'provider-1' }),
    checkRateLimit: async () => ({ allowed: true, delayMs: 0 }),
    recordEmailCount: async () => {},
    checkSuppression: async () => ({ suppressed: false, entry: null }),
    now: () => new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  });
}

test('a successful delivery records the attempt and advances campaign progress once', async () => {
  const store = createDeliveryStore();
  let usageCount = 0;
  const processor = createProcessor(store, {
    recordEmailCount: async () => { usageCount += 1; },
  });

  const result = await processor(createJob());

  assert.deepEqual(result, { success: true, messageId: 'provider-1' });
  assert.equal(store.state.recipient.status, 'sent');
  assert.equal(store.state.campaign.sent_emails, 1);
  assert.equal(store.state.campaign.status, 'completed');
  assert.equal(store.state.attempts.get(1).status, 'sent');
  assert.equal(store.state.attempts.get(1).provider_message_id, 'provider-1');
  assert.equal(store.state.logs.length, 1);
  assert.equal(usageCount, 1);
});

test('a retryable failure stores the error without incrementing final counters', async () => {
  const store = createDeliveryStore();
  const processor = createProcessor(store, {
    sendEmail: async () => ({ success: false, error: 'temporary SMTP error' }),
  });

  await assert.rejects(processor(createJob()), /temporary SMTP error/);

  assert.equal(store.state.recipient.status, 'retrying');
  assert.equal(store.state.recipient.last_error, 'temporary SMTP error');
  assert.equal(store.state.campaign.failed_emails, 0);
  assert.equal(store.state.attempts.get(1).status, 'failed');
  assert.equal(store.state.logs.length, 0);
});

test('the last failed attempt marks the recipient and completes campaign progress', async () => {
  const store = createDeliveryStore();
  const processor = createProcessor(store, {
    sendEmail: async () => { throw new Error('permanent SMTP error'); },
  });

  await assert.rejects(
    processor(createJob({ attemptsMade: 2 })),
    /permanent SMTP error/,
  );

  assert.equal(store.state.recipient.status, 'failed');
  assert.equal(store.state.campaign.failed_emails, 1);
  assert.equal(store.state.campaign.status, 'completed');
  assert.equal(store.state.attempts.get(3).status, 'failed');
  assert.equal(store.state.logs[0].status, 'failed');
});

test('an already-sent recipient is not sent or counted again', async () => {
  const store = createDeliveryStore({ recipientStatus: 'sent' });
  let sendCount = 0;
  const processor = createProcessor(store, {
    sendEmail: async () => { sendCount += 1; return { success: true }; },
  });

  const result = await processor(createJob());

  assert.deepEqual(result, { success: true, deduplicated: true, status: 'sent' });
  assert.equal(sendCount, 0);
  assert.equal(store.state.campaign.sent_emails, 0);
});

test('a rate-limited job moves back to delayed without creating an attempt', async () => {
  const store = createDeliveryStore();
  let delayed;
  const processor = createProcessor(store, {
    checkRateLimit: async () => ({ allowed: false, delayMs: 60_000 }),
  });
  const job = createJob({
    moveToDelayed: async (timestamp, token) => { delayed = { timestamp, token }; },
  });

  await assert.rejects(processor(job), DelayedError);

  assert.equal(delayed.token, 'worker-token');
  assert.ok(delayed.timestamp > Date.now());
  assert.equal(store.state.attempts.size, 0);
});

test('missing campaign resources are unrecoverable and become a final failure', async () => {
  const store = createDeliveryStore({ user: null });
  const processor = createProcessor(store);

  await assert.rejects(processor(createJob()), UnrecoverableError);

  assert.equal(store.state.recipient.status, 'failed');
  assert.equal(store.state.campaign.failed_emails, 1);
  assert.match(store.state.recipient.last_error, /resources are missing/);
});

test('a post-send persistence failure is not retried as another email', async () => {
  const store = createDeliveryStore({ failSuccessPersistence: true });
  const processor = createProcessor(store);

  await assert.rejects(processor(createJob()), UnrecoverableError);

  assert.equal(store.state.recipient.status, 'delivery_unknown');
  assert.match(store.state.recipient.last_error, /Provider accepted the email/);
  assert.equal(store.state.campaign.sent_emails, 0);
});

test('a paused campaign delays work without opening a delivery attempt', async () => {
  const store = createDeliveryStore({ campaignStatus: 'paused' });
  let delayed;
  const processor = createProcessor(store);
  const job = createJob({
    moveToDelayed: async (timestamp, token) => { delayed = { timestamp, token }; },
  });

  await assert.rejects(processor(job), DelayedError);

  assert.equal(delayed.token, 'worker-token');
  assert.ok(delayed.timestamp > Date.now());
  assert.equal(store.state.attempts.size, 0);
});

test('a cancelled campaign prevents sending and records the recipient outcome once', async () => {
  const store = createDeliveryStore({ campaignStatus: 'cancelled' });
  let sends = 0;
  const processor = createProcessor(store, {
    sendEmail: async () => { sends += 1; return { success: true }; },
  });

  const result = await processor(createJob());

  assert.deepEqual(result, { success: false, cancelled: true, status: 'cancelled' });
  assert.equal(sends, 0);
  assert.equal(store.state.recipient.status, 'cancelled');
  assert.equal(store.state.campaign.cancelled_emails, 1);
  assert.equal(store.state.events[0].type, 'recipient.cancelled');
  assert.equal(store.state.attempts.size, 0);
});

test('a suppressed address is never sent and completes recipient progress', async () => {
  const store = createDeliveryStore();
  let sends = 0;
  const processor = createProcessor(store, {
    sendEmail: async () => { sends += 1; return { success: true }; },
    checkSuppression: async () => ({
      suppressed: true,
      entry: { reason: 'complaint', source: 'provider_webhook' },
    }),
  });

  const result = await processor(createJob());

  assert.deepEqual(result, {
    success: false,
    suppressed: true,
    reason: 'complaint',
    status: 'suppressed',
  });
  assert.equal(sends, 0);
  assert.equal(store.state.recipient.status, 'suppressed');
  assert.equal(store.state.recipient.suppression_reason, 'complaint');
  assert.equal(store.state.campaign.suppressed_emails, 1);
  assert.equal(store.state.campaign.status, 'completed');
  assert.equal(store.state.events[0].type, 'recipient.suppressed');
  assert.equal(store.state.attempts.size, 0);
});
