import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSuppressionDecision } from './suppressionService.js';

const TERMINAL_RECIPIENT_STATUSES = [
  'sent',
  'failed',
  'cancelled',
  'suppressed',
  'delivery_unknown',
];
const PAUSED_RECHECK_MS = 30_000;

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'Unknown delivery error');
}

function attemptNumber(job) {
  return Number(job.attemptsMade || 0) + 1;
}

function maximumAttempts(job) {
  return Math.max(1, Number(job.opts?.attempts || 1));
}

async function updateCampaignProgress(transaction, campaignId, field, now) {
  const campaign = await transaction.campaign.update({
    where: { id: campaignId },
    data: { [field]: { increment: 1 } },
  });

  const terminalOutcomes = campaign.sent_emails
    + campaign.failed_emails
    + (campaign.cancelled_emails || 0)
    + (campaign.suppressed_emails || 0);
  if (terminalOutcomes >= campaign.total_emails) {
    await transaction.campaign.update({
      where: { id: campaignId },
      data: { status: 'completed', completed_at: now },
    });
  }
}

async function beginAttempt({ prisma, campaignId, recipientId, attempt, now }) {
  await prisma.$transaction(async (transaction) => {
    await transaction.deliveryAttempt.upsert({
      where: {
        recipient_id_attempt_number: {
          recipient_id: recipientId,
          attempt_number: attempt,
        },
      },
      create: {
        recipient_id: recipientId,
        attempt_number: attempt,
        status: 'processing',
        started_at: now,
      },
      update: {
        status: 'processing',
        error_message: null,
        finished_at: null,
      },
    });
    await transaction.campaignRecipient.updateMany({
      where: { id: recipientId, status: { notIn: TERMINAL_RECIPIENT_STATUSES } },
      data: { status: 'sending', last_error: null },
    });
    await transaction.campaign.updateMany({
      where: { id: campaignId, started_at: null },
      data: { status: 'running', started_at: now },
    });
  });
}

async function recordSuccess({
  prisma,
  campaignId,
  recipientId,
  attempt,
  result,
  previewHtml,
  now,
}) {
  return prisma.$transaction(async (transaction) => {
    await transaction.deliveryAttempt.upsert({
      where: {
        recipient_id_attempt_number: {
          recipient_id: recipientId,
          attempt_number: attempt,
        },
      },
      create: {
        recipient_id: recipientId,
        attempt_number: attempt,
        status: 'sent',
        provider_message_id: result.messageId || null,
        started_at: now,
        finished_at: now,
      },
      update: {
        status: 'sent',
        provider_message_id: result.messageId || null,
        error_message: null,
        finished_at: now,
      },
    });

    const transition = await transaction.campaignRecipient.updateMany({
      where: { id: recipientId, status: { notIn: TERMINAL_RECIPIENT_STATUSES } },
      data: {
        status: 'sent',
        sent_at: now,
        failed_at: null,
        last_error: null,
      },
    });
    if (!transition.count) return false;

    await transaction.emailLog.create({
      data: {
        campaign_id: campaignId,
        sent_at: now,
        status: 'sent',
        error_message: null,
        preview_html: previewHtml,
      },
    });
    await updateCampaignProgress(transaction, campaignId, 'sent_emails', now);
    return true;
  });
}

async function recordFailure({
  prisma,
  campaignId,
  recipientId,
  attempt,
  error,
  previewHtml,
  finalAttempt,
  now,
}) {
  const message = errorMessage(error);
  return prisma.$transaction(async (transaction) => {
    await transaction.deliveryAttempt.upsert({
      where: {
        recipient_id_attempt_number: {
          recipient_id: recipientId,
          attempt_number: attempt,
        },
      },
      create: {
        recipient_id: recipientId,
        attempt_number: attempt,
        status: 'failed',
        error_message: message,
        started_at: now,
        finished_at: now,
      },
      update: {
        status: 'failed',
        error_message: message,
        finished_at: now,
      },
    });

    if (!finalAttempt) {
      await transaction.campaignRecipient.updateMany({
        where: { id: recipientId, status: { notIn: TERMINAL_RECIPIENT_STATUSES } },
        data: { status: 'retrying', last_error: message },
      });
      return false;
    }

    const transition = await transaction.campaignRecipient.updateMany({
      where: { id: recipientId, status: { notIn: TERMINAL_RECIPIENT_STATUSES } },
      data: {
        status: 'failed',
        failed_at: now,
        last_error: message,
      },
    });
    if (!transition.count) return false;

    await transaction.emailLog.create({
      data: {
        campaign_id: campaignId,
        sent_at: null,
        status: 'failed',
        error_message: message,
        preview_html: previewHtml,
      },
    });
    await updateCampaignProgress(transaction, campaignId, 'failed_emails', now);
    return true;
  });
}

async function loadDeliveryResources({ prisma, userId, templateId, resumeIds }) {
  const [template, resumes, user] = await Promise.all([
    templateId
      ? prisma.emailTemplate.findFirst({ where: { id: templateId, user_id: userId } })
      : null,
    resumeIds.length
      ? prisma.resume.findMany({ where: { id: { in: resumeIds }, user_id: userId } })
      : [],
    prisma.user.findUnique({ where: { id: userId } }),
  ]);

  if (!user || (templateId && !template) || resumes.length !== resumeIds.length) {
    throw new UnrecoverableError(
      'Campaign resources are missing or are not owned by the campaign user',
    );
  }
  return { template, resumes, user };
}

async function markDeliveryUnknown({ prisma, recipientId, error }) {
  const message = `Provider accepted the email, but delivery status could not be saved: ${errorMessage(error)}`;
  try {
    await prisma.campaignRecipient.updateMany({
      where: { id: recipientId, status: { notIn: TERMINAL_RECIPIENT_STATUSES } },
      data: { status: 'delivery_unknown', last_error: message },
    });
  } catch (statusError) {
    console.error(`[Worker] Failed to mark recipient ${recipientId} as delivery_unknown:`, statusError);
  }
  return message;
}

async function recordCampaignCancellation({ prisma, campaignId, recipientId, now }) {
  return prisma.$transaction(async (transaction) => {
    const transition = await transaction.campaignRecipient.updateMany({
      where: { id: recipientId, status: { notIn: TERMINAL_RECIPIENT_STATUSES } },
      data: { status: 'cancelled', failed_at: null, last_error: null },
    });
    if (!transition.count) return false;

    await transaction.campaign.update({
      where: { id: campaignId },
      data: { cancelled_emails: { increment: 1 } },
    });
    await transaction.campaignEvent.create({
      data: {
        campaign_id: campaignId,
        actor_user_id: null,
        type: 'recipient.cancelled',
        to_status: 'cancelled',
        metadata: { recipientId, source: 'worker_campaign_guard' },
      },
    });
    return true;
  });
}

async function recordSuppressedOutcome({ prisma, campaignId, recipientId, decision, now }) {
  return prisma.$transaction(async (transaction) => {
    const transition = await transaction.campaignRecipient.updateMany({
      where: { id: recipientId, status: { notIn: TERMINAL_RECIPIENT_STATUSES } },
      data: {
        status: 'suppressed',
        suppressed_at: now,
        suppression_reason: decision.entry.reason,
        failed_at: null,
        last_error: null,
      },
    });
    if (!transition.count) return false;

    await transaction.campaignEvent.create({
      data: {
        campaign_id: campaignId,
        actor_user_id: null,
        type: 'recipient.suppressed',
        to_status: 'suppressed',
        metadata: {
          recipientId,
          reason: decision.entry.reason,
          source: decision.entry.source,
        },
      },
    });
    await updateCampaignProgress(transaction, campaignId, 'suppressed_emails', now);
    return true;
  });
}

export function createEmailJobProcessor({
  prisma,
  sendEmail,
  checkRateLimit,
  recordEmailCount,
  checkSuppression = getSuppressionDecision,
  now = () => new Date(),
}) {
  return async function processEmailJob(job) {
    const {
      campaignId,
      userId,
      recipientId,
      recipient,
      templateId = null,
      resumeIds = [],
      subject,
      body,
    } = job.data;

    if (!campaignId || !userId || !recipientId || !recipient?.email) {
      throw new UnrecoverableError('Email job is missing required campaign or recipient data');
    }

    const persistedRecipient = await prisma.campaignRecipient.findFirst({
      where: {
        id: recipientId,
        campaign_id: campaignId,
        campaign: { user_id: userId },
      },
      select: {
        id: true,
        status: true,
        campaign: { select: { status: true } },
      },
    });
    if (!persistedRecipient) {
      throw new UnrecoverableError('Campaign recipient was not found');
    }
    if (TERMINAL_RECIPIENT_STATUSES.includes(persistedRecipient.status)) {
      return {
        success: persistedRecipient.status === 'sent',
        deduplicated: true,
        status: persistedRecipient.status,
      };
    }
    if (persistedRecipient.campaign.status === 'cancelled') {
      await recordCampaignCancellation({
        prisma,
        campaignId,
        recipientId,
        now: now(),
      });
      return { success: false, cancelled: true, status: 'cancelled' };
    }
    if (persistedRecipient.campaign.status === 'paused') {
      await job.moveToDelayed(Date.now() + PAUSED_RECHECK_MS, job.token);
      throw new DelayedError();
    }

    const suppression = await checkSuppression({ prisma, userId, email: recipient.email });
    if (suppression.suppressed) {
      await recordSuppressedOutcome({
        prisma,
        campaignId,
        recipientId,
        decision: suppression,
        now: now(),
      });
      return {
        success: false,
        suppressed: true,
        reason: suppression.entry.reason,
        status: 'suppressed',
      };
    }

    const { allowed, delayMs } = await checkRateLimit(userId);
    if (!allowed) {
      await job.moveToDelayed(Date.now() + Math.max(1, delayMs), job.token);
      throw new DelayedError();
    }

    const attempt = attemptNumber(job);
    const attemptedAt = now();
    await beginAttempt({ prisma, campaignId, recipientId, attempt, now: attemptedAt });

    let resources;
    try {
      resources = await loadDeliveryResources({ prisma, userId, templateId, resumeIds });
    } catch (error) {
      await recordFailure({
        prisma,
        campaignId,
        recipientId,
        attempt,
        error,
        previewHtml: body || '',
        finalAttempt: true,
        now: now(),
      });
      throw error;
    }

    let result;
    try {
      result = await sendEmail({
        user: resources.user,
        recipient,
        subject: subject || resources.template?.subject,
        text: body || resources.template?.html_content,
        attachments: resources.resumes.map((resume) => ({
          filename: resume.name,
          path: resume.s3_path,
        })),
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Email provider rejected the message');
      }
    } catch (error) {
      await recordFailure({
        prisma,
        campaignId,
        recipientId,
        attempt,
        error,
        previewHtml: body || resources.template?.html_content || '',
        finalAttempt: attempt >= maximumAttempts(job),
        now: now(),
      });
      throw error;
    }

    let counted;
    try {
      counted = await recordSuccess({
        prisma,
        campaignId,
        recipientId,
        attempt,
        result,
        previewHtml: body || resources.template?.html_content || '',
        now: now(),
      });
    } catch (error) {
      const message = await markDeliveryUnknown({ prisma, recipientId, error });
      throw new UnrecoverableError(message);
    }

    if (counted) {
      try {
        await recordEmailCount(userId);
      } catch (error) {
        console.error(`[Worker] Failed to record rate-limit usage for user ${userId}:`, error);
      }
    }
    return { success: true, messageId: result.messageId || null };
  };
}
