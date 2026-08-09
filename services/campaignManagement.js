import { buildRecipientJobs } from './campaignCreation.js';

const RECIPIENT_STATUSES = new Set([
  'pending',
  'queued',
  'sending',
  'retrying',
  'sent',
  'failed',
  'delivery_unknown',
]);
const REQUEUEABLE_STATUSES = ['pending', 'queued'];

export class CampaignManagementError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CampaignManagementError';
    this.code = code;
    this.status = status;
  }
}

function positiveInteger(value, fallback, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new CampaignManagementError(
      'INVALID_PAGINATION',
      `Pagination values must be integers between 1 and ${maximum}`,
    );
  }
  return parsed;
}

export function parseRecipientFilters(query = {}) {
  const page = positiveInteger(query.page, 1, 1_000_000);
  const limit = positiveInteger(query.limit, 50, 100);
  const status = typeof query.status === 'string' ? query.status.trim() : '';
  if (status && !RECIPIENT_STATUSES.has(status)) {
    throw new CampaignManagementError(
      'INVALID_RECIPIENT_STATUS',
      `Unknown recipient status: ${status}`,
    );
  }

  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 254) : '';
  return { page, limit, status: status || null, search: search || null };
}

async function requireOwnedCampaign(prisma, campaignId, userId, select = { id: true }) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, user_id: userId, deleted_at: null },
    select,
  });
  if (!campaign) {
    throw new CampaignManagementError('CAMPAIGN_NOT_FOUND', 'Campaign not found', 404);
  }
  return campaign;
}

export async function getCampaignOverview({ prisma, campaignId, userId }) {
  const campaign = await requireOwnedCampaign(prisma, campaignId, userId, {
    id: true,
    name: true,
    subject: true,
    status: true,
    timezone: true,
    scheduled_start: true,
    total_emails: true,
    sent_emails: true,
    failed_emails: true,
    cancelled_emails: true,
    suppressed_emails: true,
    created_at: true,
    started_at: true,
    completed_at: true,
    paused_at: true,
    cancelled_at: true,
    template_id: true,
    campaignResumes: {
      select: { resume: { select: { id: true, name: true } } },
    },
  });
  const groupedStatuses = await prisma.campaignRecipient.groupBy({
    by: ['status'],
    where: { campaign_id: campaign.id },
    _count: { _all: true },
  });
  const { campaignResumes, ...summary } = campaign;

  return {
    ...summary,
    attachments: campaignResumes.map(({ resume }) => resume),
    recipientStatusCounts: Object.fromEntries(
      groupedStatuses.map((group) => [group.status, group._count._all]),
    ),
  };
}

export async function listCampaignRecipients({ prisma, campaignId, userId, query }) {
  const campaign = await requireOwnedCampaign(prisma, campaignId, userId);
  const filters = parseRecipientFilters(query);
  const where = {
    campaign_id: campaign.id,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search ? {
      email: { contains: filters.search, mode: 'insensitive' },
    } : {}),
  };
  const [total, recipients] = await prisma.$transaction([
    prisma.campaignRecipient.count({ where }),
    prisma.campaignRecipient.findMany({
      where,
      orderBy: { position: 'asc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      select: {
        id: true,
        email: true,
        payload: true,
        position: true,
        status: true,
        sent_at: true,
        failed_at: true,
        suppressed_at: true,
        suppression_reason: true,
        last_error: true,
        created_at: true,
        updated_at: true,
      },
    }),
  ]);

  return {
    recipients,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit),
    },
  };
}

export async function getRecipientAttempts({ prisma, campaignId, recipientId, userId }) {
  await requireOwnedCampaign(prisma, campaignId, userId);
  const recipient = await prisma.campaignRecipient.findFirst({
    where: { id: recipientId, campaign_id: campaignId },
    select: {
      id: true,
      email: true,
      status: true,
      sent_at: true,
      failed_at: true,
      suppressed_at: true,
      suppression_reason: true,
      last_error: true,
      deliveryAttempts: {
        orderBy: { attempt_number: 'asc' },
        select: {
          id: true,
          attempt_number: true,
          status: true,
          provider_message_id: true,
          error_message: true,
          started_at: true,
          finished_at: true,
        },
      },
    },
  });
  if (!recipient) {
    throw new CampaignManagementError('RECIPIENT_NOT_FOUND', 'Campaign recipient not found', 404);
  }
  return recipient;
}

export async function requeueCampaign({ prisma, queue, campaignId, userId, now = Date.now() }) {
  const campaign = await requireOwnedCampaign(prisma, campaignId, userId, {
    id: true,
    user_id: true,
    template_id: true,
    subject: true,
    body: true,
    status: true,
    scheduled_start: true,
    campaignResumes: { select: { resumeId: true } },
    recipients: {
      where: { status: { in: REQUEUEABLE_STATUSES } },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        payload: true,
        position: true,
        queue_job_id: true,
      },
    },
  });

  if (!campaign.recipients.length) {
    return { campaignId: campaign.id, requeuedRecipients: 0 };
  }

  const resumeIds = campaign.campaignResumes.map(({ resumeId }) => resumeId);
  const restartAt = new Date(Math.max(campaign.scheduled_start.getTime(), now));
  const jobs = buildRecipientJobs({
    campaign: { ...campaign, scheduled_start: restartAt },
    userId,
    recipients: campaign.recipients.map((recipient, position) => ({
      ...recipient,
      position,
    })),
    templateId: campaign.template_id,
    resumeIds,
    subject: campaign.subject,
    body: campaign.body,
    now,
  });

  try {
    await queue.addBulk(jobs);
  } catch {
    try {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'queue_failed' },
      });
    } catch (statusError) {
      console.error('CAMPAIGN REQUEUE STATUS ERROR:', statusError);
    }
    throw new CampaignManagementError(
      'QUEUE_FAILED',
      'Campaign delivery jobs could not be queued',
      503,
    );
  }

  try {
    await prisma.$transaction([
      prisma.campaignRecipient.updateMany({
        where: { id: { in: campaign.recipients.map(({ id }) => id) } },
        data: { status: 'queued' },
      }),
      ...(['queue_failed', 'queue_state_unknown'].includes(campaign.status)
        ? [prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: 'scheduled' },
          })]
        : []),
    ]);
  } catch {
    try {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'queue_state_unknown' },
      });
    } catch (statusError) {
      console.error('CAMPAIGN REQUEUE STATUS ERROR:', statusError);
    }
    throw new CampaignManagementError(
      'QUEUE_STATE_FAILED',
      'Delivery jobs were queued, but their database status could not be updated',
      503,
    );
  }

  return {
    campaignId: campaign.id,
    requeuedRecipients: campaign.recipients.length,
  };
}
