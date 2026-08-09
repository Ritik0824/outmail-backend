import assert from 'node:assert/strict';
import test from 'node:test';
import {
  booleanOption,
  counterDifferences,
  inspectCampaignIntegrity,
  recipientCounterSnapshot,
  repairCampaignIntegrity,
  ReconciliationError,
  summarizeQueueInspection,
} from '../../services/reconciliationService.js';

const campaign = {
  id: 'campaign-1',
  user_id: 'user-1',
  name: 'Launch',
  status: 'running',
  total_emails: 10,
  sent_emails: 5,
  failed_emails: 1,
  cancelled_emails: 0,
  suppressed_emails: 0,
  completed_at: null,
  recipients: [
    { id: 'recipient-1', status: 'queued', queue_job_id: 'job-1' },
    { id: 'recipient-2', status: 'pending', queue_job_id: null },
  ],
};

const groups = [
  { status: 'sent', _count: { _all: 5 } },
  { status: 'failed', _count: { _all: 1 } },
  { status: 'queued', _count: { _all: 2 } },
  { status: 'suppressed', _count: { _all: 1 } },
  { status: 'cancelled', _count: { _all: 1 } },
];

test('recipientCounterSnapshot derives canonical campaign counters', () => {
  assert.deepEqual(recipientCounterSnapshot(groups), {
    total_emails: 10,
    sent_emails: 5,
    failed_emails: 1,
    cancelled_emails: 1,
    suppressed_emails: 1,
    statusCounts: { sent: 5, failed: 1, queued: 2, suppressed: 1, cancelled: 1 },
  });
});

test('counterDifferences names every drifted field', () => {
  const differences = counterDifferences(campaign, recipientCounterSnapshot(groups));
  assert.deepEqual(differences, [
    { field: 'cancelled_emails', actual: 0, expected: 1 },
    { field: 'suppressed_emails', actual: 0, expected: 1 },
  ]);
});

test('booleanOption accepts explicit query encodings and rejects ambiguity', () => {
  assert.equal(booleanOption(undefined, true), true);
  assert.equal(booleanOption('false'), false);
  assert.equal(booleanOption('1'), true);
  assert.throws(
    () => booleanOption('yes'),
    (error) => error instanceof ReconciliationError && error.code === 'INVALID_BOOLEAN_OPTION',
  );
});

test('summarizeQueueInspection includes recipients without job identifiers', () => {
  const summary = summarizeQueueInspection(campaign.recipients, [{
    jobId: 'job-1',
    exists: true,
    state: 'delayed',
  }]);
  assert.equal(summary.existing, 1);
  assert.equal(summary.missing, 1);
  assert.deepEqual(summary.missingRecipients, ['recipient-2']);
  assert.deepEqual(summary.stateCounts, { delayed: 1, unassigned: 1 });
});

test('inspectCampaignIntegrity reports counter and queue drift', async () => {
  const prisma = {
    campaign: { findFirst: async () => campaign },
    campaignRecipient: { groupBy: async () => groups },
  };
  const queue = {
    getJob: async () => ({
      attemptsMade: 0,
      processedOn: null,
      finishedOn: null,
      failedReason: null,
      getState: async () => 'waiting',
    }),
  };
  const result = await inspectCampaignIntegrity({
    prisma,
    queue,
    campaignId: 'campaign-1',
    userId: 'user-1',
  });
  assert.equal(result.healthy, false);
  assert.equal(result.findings.counterDrift.length, 2);
  assert.deepEqual(result.findings.missingQueueJobs, ['recipient-2']);
  assert.equal(result.queueInspection.stateCounts.waiting, 1);
});

test('inspectCampaignIntegrity rejects an unowned campaign', async () => {
  const prisma = { campaign: { findFirst: async () => null } };
  await assert.rejects(
    inspectCampaignIntegrity({ prisma, queue: {}, campaignId: 'campaign-1', userId: 'other' }),
    (error) => error.code === 'CAMPAIGN_NOT_FOUND' && error.status === 404,
  );
});

test('repairCampaignIntegrity dry run does not write discrepancies', async () => {
  let writes = 0;
  const prisma = {
    campaign: {
      findFirst: async () => campaign,
      update: async () => { writes += 1; },
    },
    campaignRecipient: { groupBy: async () => groups },
    campaignEvent: { create: async () => { writes += 1; } },
    $transaction: async (promises) => Promise.all(promises),
  };
  const result = await repairCampaignIntegrity({
    prisma,
    queue: { getJob: async () => null },
    campaignId: 'campaign-1',
    userId: 'user-1',
    dryRun: true,
  });
  assert.equal(writes, 0);
  assert.equal(result.repaired, false);
  assert.equal(result.actions.updateCounters, true);
  assert.equal(result.actions.requeueRecipients, true);
});

test('repairCampaignIntegrity updates durable counters when queue work is intact', async () => {
  let updateData;
  let eventData;
  const intactCampaign = { ...campaign, recipients: [campaign.recipients[0]] };
  const prisma = {
    campaign: {
      findFirst: async () => intactCampaign,
      update: ({ data }) => { updateData = data; return Promise.resolve(); },
    },
    campaignRecipient: { groupBy: async () => groups },
    campaignEvent: {
      create: ({ data }) => { eventData = data; return Promise.resolve(); },
    },
    $transaction: async (promises) => Promise.all(promises),
  };
  const queue = {
    getJob: async () => ({
      attemptsMade: 0,
      getState: async () => 'waiting',
    }),
  };
  const result = await repairCampaignIntegrity({
    prisma,
    queue,
    campaignId: 'campaign-1',
    userId: 'user-1',
    dryRun: false,
    now: new Date('2026-08-09T12:00:00.000Z'),
  });
  assert.equal(updateData.cancelled_emails, 1);
  assert.equal(updateData.suppressed_emails, 1);
  assert.equal(eventData.type, 'campaign.reconciled');
  assert.equal(result.repaired, true);
  assert.equal(result.queueRepair, null);
});
