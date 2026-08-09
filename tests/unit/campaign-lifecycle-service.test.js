import assert from 'node:assert/strict';
import test from 'node:test';
import { CAMPAIGN_ACTION } from '../../domain/campaignLifecycle.js';
import {
  applyCampaignAction,
  listCampaignEvents,
} from '../../services/campaignLifecycleService.js';

function campaignFixture(overrides = {}) {
  return {
    id: 'campaign-1',
    user_id: 'user-1',
    template_id: null,
    subject: 'Hello {{name}}',
    body: 'Welcome {{name}}',
    status: 'scheduled',
    scheduled_start: new Date('2026-08-11T10:00:00.000Z'),
    started_at: null,
    campaignResumes: [],
    recipients: [
      {
        id: 'recipient-1',
        email: 'asha@example.com',
        payload: { email: 'asha@example.com', name: 'Asha' },
        position: 0,
        status: 'queued',
        queue_job_id: 'campaign-recipient-recipient-1',
      },
      {
        id: 'recipient-2',
        email: 'ben@example.com',
        payload: { email: 'ben@example.com', name: 'Ben' },
        position: 1,
        status: 'queued',
        queue_job_id: 'campaign-recipient-recipient-2',
      },
    ],
    ...overrides,
  };
}

function lifecycleStore(campaign = campaignFixture()) {
  const calls = [];
  const events = [];
  const transaction = {
    campaign: {
      updateMany: async ({ data }) => {
        calls.push(['campaign-transition', data]);
        Object.assign(campaign, data);
        return { count: 1 };
      },
      update: async ({ data }) => {
        calls.push(['campaign-update', data]);
        if (data.cancelled_emails?.increment) {
          campaign.cancelled_emails = (campaign.cancelled_emails || 0)
            + data.cancelled_emails.increment;
        }
        return campaign;
      },
    },
    campaignRecipient: {
      updateMany: async ({ where, data }) => {
        const ids = new Set(where.id.in);
        let count = 0;
        for (const recipient of campaign.recipients) {
          if (ids.has(recipient.id)) {
            recipient.status = data.status;
            count += 1;
          }
        }
        calls.push(['recipient-transition', data.status, count]);
        return { count };
      },
    },
    campaignEvent: {
      create: async ({ data }) => { events.push(data); return data; },
    },
  };
  const prisma = {
    campaign: { findFirst: async () => campaign },
    campaignEvent: {
      create: async ({ data }) => { events.push(data); return data; },
      count: async () => events.length,
      findMany: async () => events,
    },
    $transaction: async (work) => Array.isArray(work)
      ? Promise.all(work)
      : work(transaction),
  };
  return { prisma, campaign, calls, events };
}

function removableQueue(removed, { failAdd = false } = {}) {
  return {
    addBulk: async () => {
      if (failAdd) throw new Error('redis unavailable');
    },
    getJob: async (jobId) => ({
      getState: async () => 'delayed',
      remove: async () => { removed.push(jobId); },
    }),
  };
}

test('pausing changes durable state before removing queued jobs', async () => {
  const store = lifecycleStore();
  const removed = [];
  const result = await applyCampaignAction({
    prisma: store.prisma,
    queue: removableQueue(removed),
    campaignId: 'campaign-1',
    userId: 'user-1',
    action: CAMPAIGN_ACTION.PAUSE,
    now: new Date('2026-08-11T09:00:00.000Z'),
  });

  assert.equal(store.campaign.status, 'paused');
  assert.deepEqual(store.campaign.recipients.map(({ status }) => status), ['paused', 'paused']);
  assert.deepEqual(removed.sort(), [
    'campaign-recipient-recipient-1',
    'campaign-recipient-recipient-2',
  ]);
  assert.equal(result.affectedRecipients, 2);
  assert.equal(result.queueCleanup.removed, 2);
  assert.equal(store.events[0].type, 'campaign.pause');
  assert.equal(store.events[1].type, 'campaign.queue_cleanup');
});

test('cancelling records recipient outcomes and increments the cancellation counter', async () => {
  const store = lifecycleStore();
  const result = await applyCampaignAction({
    prisma: store.prisma,
    queue: removableQueue([]),
    campaignId: 'campaign-1',
    userId: 'user-1',
    action: CAMPAIGN_ACTION.CANCEL,
  });

  assert.equal(store.campaign.status, 'cancelled');
  assert.equal(store.campaign.cancelled_emails, 2);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.affectedRecipients, 2);
});

test('resuming queues personalized jobs before reopening the campaign', async () => {
  const campaign = campaignFixture({
    status: 'paused',
    recipients: campaignFixture().recipients.map((recipient) => ({
      ...recipient,
      status: 'paused',
    })),
  });
  const store = lifecycleStore(campaign);
  let jobs;
  const result = await applyCampaignAction({
    prisma: store.prisma,
    queue: {
      addBulk: async (value) => { jobs = value; },
      getJob: async () => null,
    },
    campaignId: campaign.id,
    userId: campaign.user_id,
    action: CAMPAIGN_ACTION.RESUME,
    now: new Date('2026-08-11T11:00:00.000Z'),
  });

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].data.subject, 'Hello Asha');
  assert.equal(jobs[0].opts.delay, 0);
  assert.equal(store.campaign.status, 'scheduled');
  assert.deepEqual(store.campaign.recipients.map(({ status }) => status), ['queued', 'queued']);
  assert.equal(result.queuedRecipients, 2);
  assert.equal(result.queueCleanup, null);
});

test('resume leaves a campaign paused when queueing fails', async () => {
  const campaign = campaignFixture({
    status: 'paused',
    recipients: campaignFixture().recipients.map((recipient) => ({
      ...recipient,
      status: 'paused',
    })),
  });
  const store = lifecycleStore(campaign);

  await assert.rejects(
    applyCampaignAction({
      prisma: store.prisma,
      queue: removableQueue([], { failAdd: true }),
      campaignId: campaign.id,
      userId: campaign.user_id,
      action: CAMPAIGN_ACTION.RESUME,
    }),
    (error) => error.code === 'CAMPAIGN_RESUME_QUEUE_FAILED' && error.status === 503,
  );
  assert.equal(store.campaign.status, 'paused');
  assert.deepEqual(store.events, []);
});

test('optimistic transition failure prevents an event from being recorded', async () => {
  const store = lifecycleStore();
  store.prisma.$transaction = async (work) => work({
    ...store.prisma,
    campaign: { updateMany: async () => ({ count: 0 }) },
  });

  await assert.rejects(
    applyCampaignAction({
      prisma: store.prisma,
      queue: removableQueue([]),
      campaignId: 'campaign-1',
      userId: 'user-1',
      action: CAMPAIGN_ACTION.PAUSE,
    }),
    (error) => error.code === 'CAMPAIGN_CHANGED',
  );
  assert.deepEqual(store.events, []);
});

test('listCampaignEvents validates ownership and returns pagination', async () => {
  const store = lifecycleStore();
  store.events.push({ id: 'event-1', type: 'campaign.pause' });

  const result = await listCampaignEvents({
    prisma: store.prisma,
    campaignId: 'campaign-1',
    userId: 'user-1',
    query: { page: '1', limit: '20' },
  });

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.pagination, { page: 1, limit: 20, total: 1, pages: 1 });
});

test('listCampaignEvents rejects invalid pagination', async () => {
  const store = lifecycleStore();
  await assert.rejects(
    listCampaignEvents({
      prisma: store.prisma,
      campaignId: 'campaign-1',
      userId: 'user-1',
      query: { limit: '500' },
    }),
    (error) => error.code === 'INVALID_EVENT_PAGINATION' && error.status === 400,
  );
});
