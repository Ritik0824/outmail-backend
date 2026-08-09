import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecipientJobs,
  CampaignCreationError,
  createAndQueueCampaign,
  parseAttachmentIds,
  parseScheduledStart,
  recipientJobId,
} from '../../services/campaignCreation.js';

test('parseAttachmentIds accepts JSON, removes duplicates, and validates IDs', () => {
  assert.deepEqual(parseAttachmentIds('["resume-1", "resume-1", "resume-2"]'), [
    'resume-1',
    'resume-2',
  ]);
  assert.throws(
    () => parseAttachmentIds('{"resume":true}'),
    (error) => error instanceof CampaignCreationError
      && error.code === 'INVALID_ATTACHMENTS',
  );
});

test('parseScheduledStart rejects missing and invalid timestamps', () => {
  assert.equal(
    parseScheduledStart('2026-08-10T10:00:00.000Z').toISOString(),
    '2026-08-10T10:00:00.000Z',
  );
  assert.throws(
    () => parseScheduledStart('tomorrow-ish'),
    (error) => error.code === 'INVALID_START_TIME',
  );
});

test('buildRecipientJobs creates stable IDs, personalized content, and ordered delays', () => {
  const jobs = buildRecipientJobs({
    campaign: {
      id: 'campaign-1',
      scheduled_start: new Date('2026-08-10T10:00:10.000Z'),
    },
    userId: 'user-1',
    recipients: [
      {
        id: 'recipient-1',
        queue_job_id: recipientJobId('recipient-1'),
        position: 0,
        payload: { email: 'asha@example.com', name: 'Asha' },
      },
      {
        id: 'recipient-2',
        queue_job_id: recipientJobId('recipient-2'),
        position: 1,
        payload: { email: 'ben@example.com', name: 'Ben' },
      },
    ],
    templateId: 'template-1',
    resumeIds: ['resume-1'],
    subject: 'Hello {{ name }}',
    body: 'To {{email}}',
    now: new Date('2026-08-10T10:00:00.000Z').getTime(),
    intervalMs: 5_000,
  });

  assert.equal(jobs[0].opts.jobId, 'campaign-recipient-recipient-1');
  assert.equal(jobs[0].opts.delay, 10_000);
  assert.equal(jobs[1].opts.delay, 15_000);
  assert.equal(jobs[0].data.subject, 'Hello Asha');
  assert.equal(jobs[1].data.body, 'To ben@example.com');
  assert.equal(jobs[0].opts.attempts, 3);
});

function createDependencies({
  failPersistence = false,
  failQueue = false,
  failQueueStatus = false,
} = {}) {
  const calls = [];
  const stored = { campaign: null, recipients: [] };
  const transaction = {
    csvUpload: {
      create: async ({ data }) => { calls.push('persist-upload'); return data; },
    },
    campaign: {
      create: async ({ data }) => {
        calls.push('persist-campaign');
        if (failPersistence) throw new Error('database unavailable');
        stored.campaign = data;
        return data;
      },
    },
    campaignResume: {
      createMany: async () => { calls.push('persist-resumes'); },
    },
    campaignRecipient: {
      createMany: async ({ data }) => {
        calls.push('persist-recipients');
        stored.recipients = data;
      },
    },
  };
  const prisma = {
    emailTemplate: { findFirst: async () => null },
    resume: { findMany: async () => [] },
    $transaction: async (work) => work(transaction),
    campaignRecipient: {
      updateMany: async () => {
        calls.push('mark-queued');
        if (failQueueStatus) throw new Error('database unavailable');
      },
    },
    campaign: {
      update: async ({ data }) => { calls.push(`campaign-${data.status}`); },
    },
  };
  const queue = {
    addBulk: async (jobs) => {
      calls.push('enqueue');
      if (failQueue) throw new Error('redis unavailable');
      stored.jobs = jobs;
    },
  };

  return {
    calls,
    stored,
    prisma,
    queue,
    uploadRecipientFile: async () => { calls.push('upload-file'); return 'https://s3.test/file.csv'; },
    deleteRecipientFile: async () => { calls.push('delete-file'); },
  };
}

function campaignRequest(dependencies) {
  let nextId = 0;
  return createAndQueueCampaign({
    ...dependencies,
    userId: 'user-1',
    file: {
      buffer: Buffer.from('email,name\nasha@example.com,Asha\n'),
      originalname: 'recipients.csv',
      mimetype: 'text/csv',
    },
    input: {
      campaignName: 'Launch',
      timezone: 'Asia/Kolkata',
      startTime: '2026-08-10T10:00:00.000Z',
      subject: 'Hello {{name}}',
      body: 'Welcome {{name}}',
      attachmentIds: '[]',
    },
    idFactory: () => `id-${++nextId}`,
    now: new Date('2026-08-10T09:59:00.000Z').getTime(),
  });
}

test('createAndQueueCampaign persists recipients before adding idempotent jobs', async () => {
  const dependencies = createDependencies();
  const result = await campaignRequest(dependencies);

  assert.deepEqual(result, {
    campaignId: 'id-2',
    status: 'scheduled',
    totalRecipients: 1,
  });
  assert.ok(dependencies.calls.indexOf('persist-recipients') < dependencies.calls.indexOf('enqueue'));
  assert.equal(dependencies.stored.recipients[0].queue_job_id, 'campaign-recipient-id-3');
  assert.equal(dependencies.stored.jobs[0].opts.jobId, 'campaign-recipient-id-3');
  assert.equal(dependencies.stored.jobs[0].data.recipientId, 'id-3');
  assert.equal(dependencies.stored.campaign.subject, 'Hello {{name}}');
  assert.equal(dependencies.stored.campaign.body, 'Welcome {{name}}');
  assert.ok(dependencies.calls.includes('mark-queued'));
});

test('createAndQueueCampaign removes an uploaded file when persistence fails', async () => {
  const dependencies = createDependencies({ failPersistence: true });

  await assert.rejects(campaignRequest(dependencies), /database unavailable/);
  assert.deepEqual(dependencies.calls, [
    'upload-file',
    'persist-upload',
    'persist-campaign',
    'delete-file',
  ]);
});

test('createAndQueueCampaign preserves persisted data and marks queue failures', async () => {
  const dependencies = createDependencies({ failQueue: true });

  await assert.rejects(
    campaignRequest(dependencies),
    (error) => error.code === 'QUEUE_FAILED'
      && error.status === 503
      && error.details.campaignId === 'id-2',
  );
  assert.ok(dependencies.calls.includes('campaign-queue_failed'));
  assert.ok(!dependencies.calls.includes('delete-file'));
});

test('createAndQueueCampaign reports when jobs exist but queue status cannot be saved', async () => {
  const dependencies = createDependencies({ failQueueStatus: true });

  await assert.rejects(
    campaignRequest(dependencies),
    (error) => error.code === 'QUEUE_STATE_FAILED'
      && error.status === 503
      && error.details.campaignId === 'id-2',
  );
  assert.ok(dependencies.calls.includes('enqueue'));
  assert.ok(dependencies.calls.includes('campaign-queue_state_unknown'));
});
