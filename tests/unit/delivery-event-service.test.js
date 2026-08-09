import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestDeliveryEvent } from '../../services/deliveryEventService.js';

const NOW = new Date('2026-08-12T10:00:00.000Z');

function event(overrides = {}) {
  return {
    eventId: 'provider-event-1',
    type: 'delivered',
    messageId: 'provider-message-1',
    email: 'asha@example.com',
    occurredAt: '2026-08-12T09:59:00.000Z',
    metadata: {},
    ...overrides,
  };
}

function deliveryStore({ matched = true, recipientStatus = 'sent', existingEvent = null } = {}) {
  const state = {
    attempt: matched ? {
      id: 'attempt-1',
      status: 'sent',
      recipient: {
        id: 'recipient-1',
        email: 'asha@example.com',
        status: recipientStatus,
        campaign_id: 'campaign-1',
        campaign: { user_id: 'user-1' },
      },
    } : null,
    campaign: { sent_emails: 1, failed_emails: 0, suppressed_emails: 0 },
    providerEvent: existingEvent,
    suppression: null,
    campaignEvents: [],
  };
  const providerModel = {
    create: async ({ data }) => {
      if (state.providerEvent) {
        const error = new Error('unique');
        error.code = 'P2002';
        throw error;
      }
      state.providerEvent = { id: 'stored-event-1', ...data };
      return state.providerEvent;
    },
    findUnique: async () => state.providerEvent,
    update: async ({ data }) => {
      Object.assign(state.providerEvent, data);
      return state.providerEvent;
    },
    updateMany: async ({ where, data }) => {
      if (!state.providerEvent
        || state.providerEvent.id !== where.id
        || state.providerEvent.outcome !== where.outcome) return { count: 0 };
      Object.assign(state.providerEvent, data);
      return { count: 1 };
    },
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
    deliveryAttempt: {
      update: async ({ data }) => { Object.assign(state.attempt, data); return state.attempt; },
    },
    campaignRecipient: {
      updateMany: async ({ data }) => {
        if (['cancelled', 'suppressed', 'delivery_unknown'].includes(state.attempt.recipient.status)) {
          return { count: 0 };
        }
        Object.assign(state.attempt.recipient, data);
        return { count: 1 };
      },
    },
    campaign: {
      update: async ({ data }) => {
        for (const [key, value] of Object.entries(data)) {
          if (value.increment) state.campaign[key] += value.increment;
          if (value.decrement) state.campaign[key] -= value.decrement;
        }
        return state.campaign;
      },
    },
    providerDeliveryEvent: providerModel,
    campaignEvent: {
      create: async ({ data }) => { state.campaignEvents.push(data); return data; },
    },
  };
  const prisma = {
    deliveryAttempt: { findFirst: async () => state.attempt },
    providerDeliveryEvent: providerModel,
    suppressionEntry: suppressionModel,
    $transaction: async (work) => work(transaction),
  };
  return { prisma, state };
}

test('delivered events update the attempt and append an audit event', async () => {
  const store = deliveryStore();
  const result = await ingestDeliveryEvent({ prisma: store.prisma, value: event(), now: NOW });

  assert.equal(result.outcome, 'processed');
  assert.equal(store.state.attempt.status, 'delivered');
  assert.equal(store.state.providerEvent.outcome, 'processed');
  assert.equal(store.state.campaignEvents[0].type, 'provider.delivered');
});

test('soft bounces preserve the recipient but record provider diagnostics', async () => {
  const store = deliveryStore();
  await ingestDeliveryEvent({
    prisma: store.prisma,
    value: event({ type: 'soft_bounce', metadata: { reason: 'mailbox full' } }),
    now: NOW,
  });

  assert.equal(store.state.attempt.status, 'soft_bounce');
  assert.equal(store.state.attempt.error_message, 'mailbox full');
  assert.equal(store.state.attempt.recipient.status, 'sent');
  assert.equal(store.state.suppression, null);
});

test('hard bounces suppress the address and revise sent counters once', async () => {
  const store = deliveryStore();
  const result = await ingestDeliveryEvent({
    prisma: store.prisma,
    value: event({ type: 'hard_bounce', metadata: { reason: 'user unknown' } }),
    now: NOW,
  });

  assert.equal(result.suppressionReason, 'hard_bounce');
  assert.equal(result.recipientChanged, true);
  assert.equal(store.state.suppression.reason, 'hard_bounce');
  assert.equal(store.state.attempt.recipient.status, 'suppressed');
  assert.equal(store.state.campaign.sent_emails, 0);
  assert.equal(store.state.campaign.suppressed_emails, 1);
});

test('complaints create the strongest suppression reason', async () => {
  const store = deliveryStore();
  await ingestDeliveryEvent({
    prisma: store.prisma,
    value: event({ type: 'complaint' }),
    now: NOW,
  });
  assert.equal(store.state.suppression.reason, 'complaint');
  assert.equal(store.state.attempt.status, 'complaint');
});

test('duplicate provider event IDs are idempotent', async () => {
  const existingEvent = {
    id: 'stored-event-1',
    provider_event_id: 'provider-event-1',
    recipient_id: 'recipient-1',
    outcome: 'processed',
  };
  const store = deliveryStore({ existingEvent });
  const result = await ingestDeliveryEvent({ prisma: store.prisma, value: event(), now: NOW });

  assert.deepEqual(result, {
    duplicate: true,
    outcome: 'processed',
    eventId: 'provider-event-1',
    recipientId: 'recipient-1',
  });
  assert.equal(store.state.campaignEvents.length, 0);
});

test('unmatched message IDs remain stored for reconciliation', async () => {
  const store = deliveryStore({ matched: false });
  const result = await ingestDeliveryEvent({ prisma: store.prisma, value: event(), now: NOW });

  assert.equal(result.outcome, 'unmatched');
  assert.equal(store.state.providerEvent.outcome, 'unmatched');
  assert.match(store.state.providerEvent.error_message, /No delivery attempt/);
});

test('recipient email mismatches are rejected and never suppress an address', async () => {
  const store = deliveryStore();
  const result = await ingestDeliveryEvent({
    prisma: store.prisma,
    value: event({ email: 'other@example.com', type: 'complaint' }),
    now: NOW,
  });

  assert.equal(result.outcome, 'rejected');
  assert.equal(store.state.suppression, null);
  assert.equal(store.state.attempt.recipient.status, 'sent');
});

test('an already-suppressed recipient does not change counters twice', async () => {
  const store = deliveryStore({ recipientStatus: 'suppressed' });
  store.state.campaign.sent_emails = 0;
  store.state.campaign.suppressed_emails = 1;
  const result = await ingestDeliveryEvent({
    prisma: store.prisma,
    value: event({ type: 'complaint' }),
    now: NOW,
  });

  assert.equal(result.recipientChanged, false);
  assert.equal(store.state.campaign.sent_emails, 0);
  assert.equal(store.state.campaign.suppressed_emails, 1);
});
