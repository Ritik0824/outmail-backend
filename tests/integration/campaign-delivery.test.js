import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { setTestEnv } from '../helpers/env.js';

setTestEnv({
  DATABASE_URL: process.env.TEST_DATABASE_URL
    || 'postgresql://outmail:outmail@localhost:5432/outmail?schema=outmail_test',
});

const prisma = (await import('../../prisma/prismaClient.js')).default;
const { createAndQueueCampaign } = await import('../../services/campaignCreation.js');
const { createEmailJobProcessor } = await import('../../services/emailDelivery.js');

async function clearDeliveryData() {
  await prisma.providerDeliveryEvent.deleteMany();
  await prisma.suppressionEntry.deleteMany();
  await prisma.deliveryAttempt.deleteMany();
  await prisma.campaignEvent.deleteMany();
  await prisma.campaignRecipient.deleteMany();
  await prisma.emailLog.deleteMany();
  await prisma.campaignResume.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.csvUpload.deleteMany();
  await prisma.emailTemplate.deleteMany();
  await prisma.resume.deleteMany();
  await prisma.user.deleteMany();
}

before(async () => {
  await prisma.$connect();
});

beforeEach(clearDeliveryData);

after(async () => {
  await clearDeliveryData();
  await prisma.$disconnect();
});

async function createQueuedCampaign() {
  const user = await prisma.user.create({
    data: {
      email: 'campaign-owner@example.com',
      display_name: 'Campaign Owner',
      app_password_hash: 'encrypted-placeholder',
    },
  });
  let jobs = [];
  const result = await createAndQueueCampaign({
    prisma,
    queue: { addBulk: async (queuedJobs) => { jobs = queuedJobs; } },
    uploadRecipientFile: async () => 'https://test-bucket.example/campaign.csv',
    deleteRecipientFile: async () => {},
    userId: user.id,
    file: {
      buffer: Buffer.from('email,name\nasha@example.com,Asha\nben@example.com,Ben\n'),
      originalname: 'campaign.csv',
      mimetype: 'text/csv',
    },
    input: {
      campaignName: 'Database-backed launch',
      timezone: 'Asia/Kolkata',
      startTime: '2026-08-10T10:00:00.000Z',
      subject: 'Hello {{name}}',
      body: 'This message is for {{email}}',
      attachmentIds: '[]',
    },
    now: new Date('2026-08-10T09:59:00.000Z').getTime(),
  });
  return { user, result, jobs };
}

test('campaign creation atomically persists content and idempotent recipient jobs', async () => {
  const { result, jobs } = await createQueuedCampaign();
  const campaign = await prisma.campaign.findUnique({
    where: { id: result.campaignId },
    include: { recipients: { orderBy: { position: 'asc' } } },
  });

  assert.equal(campaign.subject, 'Hello {{name}}');
  assert.equal(campaign.body, 'This message is for {{email}}');
  assert.equal(campaign.total_emails, 2);
  assert.deepEqual(campaign.recipients.map(({ status }) => status), ['queued', 'queued']);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].opts.jobId, campaign.recipients[0].queue_job_id);
  assert.equal(jobs[0].data.subject, 'Hello Asha');
  assert.equal(jobs[1].data.body, 'This message is for ben@example.com');
});

test('a worker success records one attempt and completes recipient progress', async () => {
  const { user, result, jobs } = await createQueuedCampaign();
  const processor = createEmailJobProcessor({
    prisma,
    sendEmail: async () => ({ success: true, messageId: 'smtp-message-1' }),
    checkRateLimit: async () => ({ allowed: true, delayMs: 0 }),
    recordEmailCount: async () => {},
    now: () => new Date('2026-08-10T10:01:00.000Z'),
  });
  const queued = jobs[0];

  await processor({
    id: queued.opts.jobId,
    data: queued.data,
    opts: queued.opts,
    attemptsMade: 0,
    token: 'integration-worker-token',
  });

  const recipient = await prisma.campaignRecipient.findUnique({
    where: { id: queued.data.recipientId },
    include: { deliveryAttempts: true },
  });
  const campaign = await prisma.campaign.findUnique({ where: { id: result.campaignId } });
  const log = await prisma.emailLog.findFirst({ where: { campaign_id: result.campaignId } });

  assert.equal(recipient.status, 'sent');
  assert.equal(recipient.deliveryAttempts.length, 1);
  assert.equal(recipient.deliveryAttempts[0].provider_message_id, 'smtp-message-1');
  assert.equal(campaign.sent_emails, 1);
  assert.equal(campaign.failed_emails, 0);
  assert.equal(campaign.status, 'running');
  assert.equal(log.status, 'sent');
  assert.equal(user.id, queued.data.userId);
});
