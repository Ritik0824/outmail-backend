import { sameEmailAddress } from '../domain/emailAddress.js';
import {
  maskEmailAddress,
  UnsubscribeTokenError,
  verifyUnsubscribeToken,
} from '../domain/unsubscribeToken.js';
import { addSuppression } from './suppressionService.js';
import { removeRecipientJobs } from './queueJobControl.js';

const TERMINAL_RECIPIENT_STATUSES = [
  'sent',
  'failed',
  'cancelled',
  'suppressed',
  'delivery_unknown',
];

export class UnsubscribeServiceError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'UnsubscribeServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function mapTokenError(error) {
  if (!(error instanceof UnsubscribeTokenError)) return error;
  const expired = error.code === 'UNSUBSCRIBE_TOKEN_EXPIRED';
  return new UnsubscribeServiceError(
    error.code,
    expired ? 'This unsubscribe link has expired' : 'This unsubscribe link is invalid',
    { status: expired ? 410 : 400 },
  );
}

function verifyToken(secret, token, now) {
  try {
    return verifyUnsubscribeToken({ secret, token, now });
  } catch (error) {
    throw mapTokenError(error);
  }
}

async function requireRecipient(prisma, payload) {
  const recipient = await prisma.campaignRecipient.findFirst({
    where: {
      id: payload.recipientId,
      campaign_id: payload.campaignId,
      campaign: { user_id: payload.userId },
    },
    select: {
      id: true,
      email: true,
      status: true,
      queue_job_id: true,
      campaign_id: true,
      suppression_reason: true,
    },
  });
  if (!recipient || !sameEmailAddress(recipient.email, payload.email)) {
    throw new UnsubscribeServiceError(
      'UNSUBSCRIBE_RECIPIENT_NOT_FOUND',
      'This unsubscribe link is no longer valid',
      { status: 404 },
    );
  }
  return recipient;
}

export async function previewUnsubscribe({ prisma, secret, token, now = new Date() }) {
  const payload = verifyToken(secret, token, now);
  const recipient = await requireRecipient(prisma, payload);
  const suppression = await prisma.suppressionEntry.findUnique({
    where: {
      user_id_email: { user_id: payload.userId, email: payload.email },
    },
    select: { reason: true, removed_at: true },
  });
  return {
    maskedEmail: maskEmailAddress(payload.email),
    campaignId: payload.campaignId,
    alreadyUnsubscribed: recipient.suppression_reason === 'unsubscribed'
      || Boolean(suppression && !suppression.removed_at && suppression.reason === 'unsubscribed'),
    expiresAt: new Date(payload.expiresAt * 1_000),
  };
}

async function recordRecipientSuppression({ prisma, recipient, payload, now }) {
  return prisma.$transaction(async (transaction) => {
    const transition = await transaction.campaignRecipient.updateMany({
      where: {
        id: recipient.id,
        status: { notIn: TERMINAL_RECIPIENT_STATUSES },
      },
      data: {
        status: 'suppressed',
        suppressed_at: now,
        suppression_reason: 'unsubscribed',
        failed_at: null,
        last_error: null,
      },
    });
    if (!transition.count) return false;

    const campaign = await transaction.campaign.update({
      where: { id: recipient.campaign_id },
      data: { suppressed_emails: { increment: 1 } },
      select: {
        total_emails: true,
        sent_emails: true,
        failed_emails: true,
        cancelled_emails: true,
        suppressed_emails: true,
        status: true,
      },
    });
    const terminalOutcomes = campaign.sent_emails
      + campaign.failed_emails
      + campaign.cancelled_emails
      + campaign.suppressed_emails;
    if (!['cancelled', 'completed'].includes(campaign.status)
      && terminalOutcomes >= campaign.total_emails) {
      await transaction.campaign.update({
        where: { id: recipient.campaign_id },
        data: { status: 'completed', completed_at: now },
      });
    }
    await transaction.campaignEvent.create({
      data: {
        campaign_id: recipient.campaign_id,
        actor_user_id: null,
        type: 'recipient.unsubscribed',
        to_status: 'suppressed',
        metadata: {
          recipientId: recipient.id,
          email: payload.email,
          source: 'public_unsubscribe',
        },
      },
    });
    return true;
  });
}

export async function confirmUnsubscribe({
  prisma,
  queue,
  secret,
  token,
  now = new Date(),
}) {
  const payload = verifyToken(secret, token, now);
  const recipient = await requireRecipient(prisma, payload);
  await addSuppression({
    prisma,
    userId: payload.userId,
    email: payload.email,
    reason: 'unsubscribed',
    source: 'public_unsubscribe',
    details: {
      campaignId: payload.campaignId,
      recipientId: payload.recipientId,
    },
  });
  const changed = await recordRecipientSuppression({
    prisma,
    recipient,
    payload,
    now,
  });
  const queueCleanup = recipient.queue_job_id
    ? await removeRecipientJobs({ queue, jobIds: [recipient.queue_job_id] })
    : { requested: 0, removed: 0, missing: 0, active: 0, failed: 0, results: [] };

  return {
    success: true,
    maskedEmail: maskEmailAddress(payload.email),
    alreadyUnsubscribed: !changed,
    queueCleanup: {
      removed: queueCleanup.removed,
      missing: queueCleanup.missing,
      active: queueCleanup.active,
      failed: queueCleanup.failed,
    },
  };
}
