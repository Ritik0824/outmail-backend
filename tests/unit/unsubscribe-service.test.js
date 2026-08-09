import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnsubscribeToken } from '../../domain/unsubscribeToken.js';
import {
  confirmUnsubscribe,
  previewUnsubscribe,
} from '../../services/unsubscribeService.js';

const SECRET = 'unsubscribe-secret-that-is-longer-than-thirty-two-characters';
const NOW = new Date('2026-08-12T10:00:00.000Z');

function signedToken(overrides = {}) {
  return createUnsubscribeToken({
    secret: SECRET,
    userId: 'user-1',
    campaignId: 'campaign-1',
    recipientId: 'recipient-1',
    email: 'asha@example.com',
    now: NOW,
    ttlDays: 30,
    ...overrides,
  });
}

function unsubscribeStore({ recipientStatus = 'queued', suppression = null } = {}) {
  const state = {
    recipient: {
      id: 'recipient-1',
      campaign_id: 'campaign-1',
      email: 'asha@example.com',
      status: recipientStatus,
      queue_job_id: 'campaign-recipient-recipient-1',
      suppression_reason: recipientStatus === 'suppressed' ? 'unsubscribed' : null,
    },
    campaign: {
      id: 'campaign-1',
      status: 'scheduled',
      total_emails: 1,
      sent_emails: 0,
      failed_emails: 0,
      cancelled_emails: 0,
      suppressed_emails: recipientStatus === 'suppressed' ? 1 : 0,
    },
    suppression,
    events: [],
  };
  const suppressionModel = {
    findUnique: async () => state.suppression,
    upsert: async ({ create, update }) => {
      state.suppression = state.suppression
        ? { ...state.suppression, ...update }
        : { id: 'suppression-1', ...create };
      return state.suppression;
    },
  };
  const transaction = {
    suppressionEntry: suppressionModel,
    campaignRecipient: {
      updateMany: async ({ data }) => {
        if (['sent', 'failed', 'cancelled', 'suppressed', 'delivery_unknown']
          .includes(state.recipient.status)) return { count: 0 };
        Object.assign(state.recipient, data);
        return { count: 1 };
      },
    },
    campaign: {
      update: async ({ data, select }) => {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            state.campaign[key] += value.increment;
          } else {
            state.campaign[key] = value;
          }
        }
        if (!select) return state.campaign;
        return Object.fromEntries(Object.keys(select).map((key) => [key, state.campaign[key]]));
      },
    },
    campaignEvent: {
      create: async ({ data }) => { state.events.push(data); return data; },
    },
  };
  const prisma = {
    campaignRecipient: { findFirst: async () => state.recipient },
    suppressionEntry: suppressionModel,
    $transaction: async (work) => work(transaction),
  };
  return { prisma, state };
}

function removableQueue(removed) {
  return {
    getJob: async (jobId) => ({
      getState: async () => 'delayed',
      remove: async () => { removed.push(jobId); },
    }),
  };
}

test('previewUnsubscribe returns masked identity without modifying state', async () => {
  const store = unsubscribeStore();
  const result = await previewUnsubscribe({
    prisma: store.prisma,
    secret: SECRET,
    token: signedToken(),
    now: NOW,
  });

  assert.equal(result.maskedEmail, 'as**@example.com');
  assert.equal(result.campaignId, 'campaign-1');
  assert.equal(result.alreadyUnsubscribed, false);
  assert.equal(store.state.recipient.status, 'queued');
});

test('previewUnsubscribe detects an existing unsubscribe', async () => {
  const store = unsubscribeStore({
    suppression: { reason: 'unsubscribed', removed_at: null },
  });
  const result = await previewUnsubscribe({
    prisma: store.prisma,
    secret: SECRET,
    token: signedToken(),
    now: NOW,
  });
  assert.equal(result.alreadyUnsubscribed, true);
});

test('previewUnsubscribe rejects a token for a different recipient email', async () => {
  const store = unsubscribeStore();
  await assert.rejects(
    previewUnsubscribe({
      prisma: store.prisma,
      secret: SECRET,
      token: signedToken({ email: 'other@example.com' }),
      now: NOW,
    }),
    (error) => error.code === 'UNSUBSCRIBE_RECIPIENT_NOT_FOUND' && error.status === 404,
  );
});

test('previewUnsubscribe maps expiration to HTTP 410 semantics', async () => {
  const store = unsubscribeStore();
  await assert.rejects(
    previewUnsubscribe({
      prisma: store.prisma,
      secret: SECRET,
      token: signedToken({ ttlDays: 1 }),
      now: new Date('2026-08-14T10:00:00.000Z'),
    }),
    (error) => error.code === 'UNSUBSCRIBE_TOKEN_EXPIRED' && error.status === 410,
  );
});

test('confirmUnsubscribe persists suppression, updates progress, and removes the job', async () => {
  const store = unsubscribeStore();
  const removed = [];
  const result = await confirmUnsubscribe({
    prisma: store.prisma,
    queue: removableQueue(removed),
    secret: SECRET,
    token: signedToken(),
    now: NOW,
  });

  assert.equal(result.success, true);
  assert.equal(result.alreadyUnsubscribed, false);
  assert.equal(store.state.suppression.reason, 'unsubscribed');
  assert.equal(store.state.suppression.source, 'public_unsubscribe');
  assert.equal(store.state.recipient.status, 'suppressed');
  assert.equal(store.state.campaign.suppressed_emails, 1);
  assert.equal(store.state.campaign.status, 'completed');
  assert.equal(store.state.events[0].type, 'recipient.unsubscribed');
  assert.deepEqual(removed, ['campaign-recipient-recipient-1']);
});

test('confirmUnsubscribe is idempotent for an already-suppressed recipient', async () => {
  const store = unsubscribeStore({
    recipientStatus: 'suppressed',
    suppression: {
      id: 'suppression-1',
      email: 'asha@example.com',
      reason: 'unsubscribed',
      source: 'public_unsubscribe',
      details: {},
      removed_at: null,
    },
  });
  const result = await confirmUnsubscribe({
    prisma: store.prisma,
    queue: { getJob: async () => null },
    secret: SECRET,
    token: signedToken(),
    now: NOW,
  });

  assert.equal(result.alreadyUnsubscribed, true);
  assert.equal(store.state.campaign.suppressed_emails, 1);
  assert.equal(store.state.events.length, 0);
});
