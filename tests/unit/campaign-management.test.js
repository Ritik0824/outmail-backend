import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CampaignManagementError,
  getCampaignOverview,
  getRecipientAttempts,
  listCampaignRecipients,
  parseRecipientFilters,
  requeueCampaign,
} from '../../services/campaignManagement.js';

test('parseRecipientFilters applies defaults and validates input', () => {
  assert.deepEqual(parseRecipientFilters({}), {
    page: 1,
    limit: 50,
    status: null,
    search: null,
  });
  assert.deepEqual(parseRecipientFilters({ page: '2', limit: '25', status: 'failed' }), {
    page: 2,
    limit: 25,
    status: 'failed',
    search: null,
  });
  assert.throws(
    () => parseRecipientFilters({ limit: '101' }),
    (error) => error.code === 'INVALID_PAGINATION',
  );
  assert.throws(
    () => parseRecipientFilters({ status: 'mystery' }),
    (error) => error.code === 'INVALID_RECIPIENT_STATUS',
  );
});

test('getCampaignOverview returns attachment summaries and status counts', async () => {
  const prisma = {
    campaign: {
      findFirst: async () => ({
        id: 'campaign-1',
        name: 'Launch',
        campaignResumes: [{ resume: { id: 'resume-1', name: 'CV.pdf' } }],
      }),
    },
    campaignRecipient: {
      groupBy: async () => [
        { status: 'sent', _count: { _all: 4 } },
        { status: 'failed', _count: { _all: 1 } },
      ],
    },
  };

  const campaign = await getCampaignOverview({
    prisma,
    campaignId: 'campaign-1',
    userId: 'user-1',
  });

  assert.deepEqual(campaign.attachments, [{ id: 'resume-1', name: 'CV.pdf' }]);
  assert.deepEqual(campaign.recipientStatusCounts, { sent: 4, failed: 1 });
  assert.ok(!Object.hasOwn(campaign, 'campaignResumes'));
});

test('listCampaignRecipients applies owner scope, filters, and pagination', async () => {
  let findArguments;
  const prisma = {
    campaign: { findFirst: async () => ({ id: 'campaign-1' }) },
    campaignRecipient: {
      count: ({ where }) => Promise.resolve(where.status === 'failed' ? 3 : 0),
      findMany: (arguments_) => {
        findArguments = arguments_;
        return Promise.resolve([{ id: 'recipient-1', status: 'failed' }]);
      },
    },
    $transaction: async (operations) => Promise.all(operations),
  };

  const result = await listCampaignRecipients({
    prisma,
    campaignId: 'campaign-1',
    userId: 'user-1',
    query: { page: '2', limit: '2', status: 'failed', search: 'asha' },
  });

  assert.equal(findArguments.where.campaign_id, 'campaign-1');
  assert.equal(findArguments.where.status, 'failed');
  assert.deepEqual(findArguments.where.email, { contains: 'asha', mode: 'insensitive' });
  assert.equal(findArguments.skip, 2);
  assert.equal(findArguments.take, 2);
  assert.deepEqual(result.pagination, { page: 2, limit: 2, total: 3, pages: 2 });
});

test('getRecipientAttempts does not expose a recipient outside the campaign', async () => {
  const prisma = {
    campaign: { findFirst: async () => ({ id: 'campaign-1' }) },
    campaignRecipient: { findFirst: async () => null },
  };

  await assert.rejects(
    getRecipientAttempts({
      prisma,
      campaignId: 'campaign-1',
      recipientId: 'recipient-other',
      userId: 'user-1',
    }),
    (error) => error instanceof CampaignManagementError
      && error.code === 'RECIPIENT_NOT_FOUND'
      && error.status === 404,
  );
});

test('requeueCampaign recreates only pending jobs with stable IDs', async () => {
  const calls = [];
  const campaign = {
    id: 'campaign-1',
    user_id: 'user-1',
    template_id: null,
    subject: 'Hello {{name}}',
    body: 'Welcome {{name}}',
    status: 'queue_failed',
    scheduled_start: new Date('2026-08-10T09:00:00.000Z'),
    campaignResumes: [{ resumeId: 'resume-1' }],
    recipients: [{
      id: 'recipient-1',
      payload: { email: 'asha@example.com', name: 'Asha' },
      position: 12,
      queue_job_id: 'campaign-recipient-recipient-1',
    }],
  };
  const prisma = {
    campaign: {
      findFirst: async () => campaign,
      update: ({ data }) => { calls.push(`campaign-${data.status}`); return Promise.resolve(); },
    },
    campaignRecipient: {
      updateMany: ({ data }) => { calls.push(`recipients-${data.status}`); return Promise.resolve(); },
    },
    $transaction: async (operations) => Promise.all(operations),
  };
  let queuedJobs;
  const result = await requeueCampaign({
    prisma,
    queue: { addBulk: async (jobs) => { queuedJobs = jobs; } },
    campaignId: 'campaign-1',
    userId: 'user-1',
    now: new Date('2026-08-10T10:00:00.000Z').getTime(),
  });

  assert.equal(queuedJobs.length, 1);
  assert.equal(queuedJobs[0].opts.jobId, 'campaign-recipient-recipient-1');
  assert.equal(queuedJobs[0].opts.delay, 0);
  assert.equal(queuedJobs[0].data.subject, 'Hello Asha');
  assert.ok(calls.includes('recipients-queued'));
  assert.ok(calls.includes('campaign-scheduled'));
  assert.deepEqual(result, { campaignId: 'campaign-1', requeuedRecipients: 1 });
});

test('campaign management rejects resources not owned by the user', async () => {
  const prisma = { campaign: { findFirst: async () => null } };

  await assert.rejects(
    getCampaignOverview({ prisma, campaignId: 'campaign-1', userId: 'other-user' }),
    (error) => error.code === 'CAMPAIGN_NOT_FOUND' && error.status === 404,
  );
});

test('requeueCampaign reports a queue outage without discarding campaign data', async () => {
  const statuses = [];
  const prisma = {
    campaign: {
      findFirst: async () => ({
        id: 'campaign-1',
        user_id: 'user-1',
        template_id: null,
        subject: 'Subject',
        body: 'Body',
        status: 'queue_failed',
        scheduled_start: new Date(),
        campaignResumes: [],
        recipients: [{
          id: 'recipient-1',
          payload: { email: 'asha@example.com' },
          position: 0,
          queue_job_id: 'campaign-recipient-recipient-1',
        }],
      }),
      update: async ({ data }) => { statuses.push(data.status); },
    },
  };

  await assert.rejects(
    requeueCampaign({
      prisma,
      queue: { addBulk: async () => { throw new Error('redis unavailable'); } },
      campaignId: 'campaign-1',
      userId: 'user-1',
    }),
    (error) => error.code === 'QUEUE_FAILED' && error.status === 503,
  );
  assert.deepEqual(statuses, ['queue_failed']);
});
