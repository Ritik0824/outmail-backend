import {
  CAMPAIGN_ACTION,
  campaignTransition,
  CampaignTransitionError,
  recipientStatusForCampaignAction,
} from '../domain/campaignLifecycle.js';
import { buildRecipientJobs } from './campaignCreation.js';
import { removeRecipientJobs } from './queueJobControl.js';

const STOPPABLE_RECIPIENT_STATUSES = ['pending', 'queued', 'retrying', 'paused'];

function lifecycleSelect() {
  return {
    id: true,
    user_id: true,
    template_id: true,
    subject: true,
    body: true,
    status: true,
    scheduled_start: true,
    started_at: true,
    campaignResumes: { select: { resumeId: true } },
    recipients: {
      where: { status: { in: STOPPABLE_RECIPIENT_STATUSES } },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        email: true,
        payload: true,
        position: true,
        status: true,
        queue_job_id: true,
      },
    },
  };
}

async function requireLifecycleCampaign(prisma, campaignId, userId) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, user_id: userId, deleted_at: null },
    select: lifecycleSelect(),
  });
  if (!campaign) {
    throw new CampaignTransitionError(
      'CAMPAIGN_NOT_FOUND',
      'Campaign not found',
      { status: 404 },
    );
  }
  return campaign;
}

function transitionRecipientIds(campaign, action) {
  const allowed = action === CAMPAIGN_ACTION.RESUME
    ? new Set(['paused'])
    : new Set(STOPPABLE_RECIPIENT_STATUSES);
  return campaign.recipients
    .filter(({ status }) => allowed.has(status))
    .map(({ id }) => id);
}

function queueJobIds(campaign) {
  return campaign.recipients
    .map(({ queue_job_id: jobId }) => jobId)
    .filter(Boolean);
}

function buildResumeJobs(campaign, userId, now) {
  const pausedRecipients = campaign.recipients.filter(({ status }) => status === 'paused');
  if (!pausedRecipients.length) return [];
  const restartAt = new Date(Math.max(campaign.scheduled_start.getTime(), now));
  return buildRecipientJobs({
    campaign: { ...campaign, scheduled_start: restartAt },
    userId,
    recipients: pausedRecipients.map((recipient, position) => ({ ...recipient, position })),
    templateId: campaign.template_id,
    resumeIds: campaign.campaignResumes.map(({ resumeId }) => resumeId),
    subject: campaign.subject,
    body: campaign.body,
    now,
  });
}

async function persistTransition({ prisma, campaign, userId, action, transition, now }) {
  const recipientIds = transitionRecipientIds(campaign, action);
  const recipientStatus = recipientStatusForCampaignAction(action);

  return prisma.$transaction(async (transaction) => {
    const changedCampaign = await transaction.campaign.updateMany({
      where: { id: campaign.id, status: campaign.status },
      data: transition,
    });
    if (!changedCampaign.count) {
      throw new CampaignTransitionError(
        'CAMPAIGN_CHANGED',
        'Campaign status changed while the action was being applied',
      );
    }

    let changedRecipients = { count: 0 };
    if (recipientIds.length) {
      changedRecipients = await transaction.campaignRecipient.updateMany({
        where: {
          id: { in: recipientIds },
          status: {
            in: action === CAMPAIGN_ACTION.RESUME
              ? ['paused']
              : STOPPABLE_RECIPIENT_STATUSES,
          },
        },
        data: { status: recipientStatus },
      });
    }

    if (action === CAMPAIGN_ACTION.CANCEL && changedRecipients.count) {
      await transaction.campaign.update({
        where: { id: campaign.id },
        data: { cancelled_emails: { increment: changedRecipients.count } },
      });
    }

    await transaction.campaignEvent.create({
      data: {
        campaign_id: campaign.id,
        actor_user_id: userId,
        type: `campaign.${action}`,
        from_status: campaign.status,
        to_status: transition.status,
        metadata: {
          recipientStatus,
          affectedRecipients: changedRecipients.count,
          occurredAt: now.toISOString(),
        },
      },
    });

    return changedRecipients.count;
  });
}

async function recordQueueCleanup(prisma, campaignId, userId, action, cleanup) {
  try {
    await prisma.campaignEvent.create({
      data: {
        campaign_id: campaignId,
        actor_user_id: userId,
        type: 'campaign.queue_cleanup',
        metadata: {
          action,
          requested: cleanup.requested,
          removed: cleanup.removed,
          missing: cleanup.missing,
          active: cleanup.active,
          failed: cleanup.failed,
        },
      },
    });
  } catch (error) {
    console.error('CAMPAIGN QUEUE CLEANUP EVENT ERROR:', error);
  }
}

export async function applyCampaignAction({
  prisma,
  queue,
  campaignId,
  userId,
  action,
  now = new Date(),
}) {
  const campaign = await requireLifecycleCampaign(prisma, campaignId, userId);
  const transition = campaignTransition({
    status: campaign.status,
    action,
    startedAt: campaign.started_at,
    now,
  });

  let resumeJobs = [];
  if (action === CAMPAIGN_ACTION.RESUME) {
    resumeJobs = buildResumeJobs(campaign, userId, now.getTime());
    try {
      if (resumeJobs.length) await queue.addBulk(resumeJobs);
    } catch {
      throw new CampaignTransitionError(
        'CAMPAIGN_RESUME_QUEUE_FAILED',
        'The campaign remains paused because its jobs could not be queued',
        { status: 503 },
      );
    }
  }

  let affectedRecipients;
  try {
    affectedRecipients = await persistTransition({
      prisma,
      campaign,
      userId,
      action,
      transition,
      now,
    });
  } catch (error) {
    if (resumeJobs.length) {
      await removeRecipientJobs({
        queue,
        jobIds: resumeJobs.map(({ opts }) => opts.jobId),
      });
    }
    throw error;
  }

  let queueCleanup = null;
  if (action !== CAMPAIGN_ACTION.RESUME) {
    queueCleanup = await removeRecipientJobs({ queue, jobIds: queueJobIds(campaign) });
    await recordQueueCleanup(prisma, campaign.id, userId, action, queueCleanup);
  }

  return {
    campaignId: campaign.id,
    previousStatus: campaign.status,
    status: transition.status,
    affectedRecipients,
    queuedRecipients: resumeJobs.length,
    queueCleanup,
  };
}

function eventPagination(query = {}) {
  const page = Number(query.page || 1);
  const limit = Number(query.limit || 50);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CampaignTransitionError(
      'INVALID_EVENT_PAGINATION',
      'page and limit must be positive integers, with limit at most 100',
      { status: 400 },
    );
  }
  return { page, limit };
}

export async function listCampaignEvents({ prisma, campaignId, userId, query }) {
  await requireLifecycleCampaign(prisma, campaignId, userId);
  const { page, limit } = eventPagination(query);
  const where = { campaign_id: campaignId };
  const [total, events] = await prisma.$transaction([
    prisma.campaignEvent.count({ where }),
    prisma.campaignEvent.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        type: true,
        actor_user_id: true,
        from_status: true,
        to_status: true,
        metadata: true,
        created_at: true,
      },
    }),
  ]);
  return {
    events,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}
