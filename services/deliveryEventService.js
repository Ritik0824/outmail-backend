import { sameEmailAddress } from '../domain/emailAddress.js';
import {
  DELIVERY_EVENT_TYPE,
  parseDeliveryEvent,
  suppressionReasonForDeliveryEvent,
} from '../domain/deliveryWebhook.js';
import { addSuppression } from './suppressionService.js';

export class DeliveryEventServiceError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'DeliveryEventServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isUniqueConflict(error) {
  return error?.code === 'P2002';
}

async function findDeliveryAttempt(prisma, messageId) {
  return prisma.deliveryAttempt.findFirst({
    where: { provider_message_id: messageId },
    orderBy: { finished_at: 'desc' },
    select: {
      id: true,
      status: true,
      recipient: {
        select: {
          id: true,
          email: true,
          status: true,
          campaign_id: true,
          campaign: { select: { user_id: true } },
        },
      },
    },
  });
}

async function createPendingEvent(prisma, event, attempt, rawPayload) {
  try {
    return await prisma.providerDeliveryEvent.create({
      data: {
        provider_event_id: event.eventId,
        provider_message_id: event.messageId,
        delivery_attempt_id: attempt?.id || null,
        recipient_id: attempt?.recipient.id || null,
        type: event.type,
        email: event.email,
        occurred_at: event.occurredAt,
        payload: rawPayload,
        outcome: 'pending',
      },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const existing = await prisma.providerDeliveryEvent.findUnique({
      where: { provider_event_id: event.eventId },
    });
    return { ...existing, duplicate: true };
  }
}

async function finishWithoutRecipient({ prisma, storedEvent, outcome, errorMessage, now }) {
  const updated = await prisma.providerDeliveryEvent.update({
    where: { id: storedEvent.id },
    data: {
      outcome,
      error_message: errorMessage,
      processed_at: now,
    },
  });
  return { duplicate: false, outcome, event: updated, recipientId: null };
}

async function recordInformationalEvent({ prisma, event, storedEvent, attempt, now }) {
  const attemptStatus = event.type === DELIVERY_EVENT_TYPE.DELIVERED
    ? 'delivered'
    : 'soft_bounce';
  await prisma.$transaction(async (transaction) => {
    await transaction.deliveryAttempt.update({
      where: { id: attempt.id },
      data: {
        status: attemptStatus,
        error_message: event.type === DELIVERY_EVENT_TYPE.SOFT_BOUNCE
          ? String(event.metadata.reason || 'Provider reported a soft bounce')
          : null,
      },
    });
    await transaction.providerDeliveryEvent.update({
      where: { id: storedEvent.id },
      data: { outcome: 'processed', processed_at: now, error_message: null },
    });
    await transaction.campaignEvent.create({
      data: {
        campaign_id: attempt.recipient.campaign_id,
        actor_user_id: null,
        type: `provider.${event.type}`,
        metadata: {
          providerEventId: event.eventId,
          providerMessageId: event.messageId,
          recipientId: attempt.recipient.id,
        },
      },
    });
  });
  return {
    duplicate: false,
    outcome: 'processed',
    eventId: event.eventId,
    recipientId: attempt.recipient.id,
  };
}

function campaignCounterAdjustment(previousStatus) {
  if (previousStatus === 'sent') {
    return {
      sent_emails: { decrement: 1 },
      suppressed_emails: { increment: 1 },
    };
  }
  if (previousStatus === 'failed') {
    return {
      failed_emails: { decrement: 1 },
      suppressed_emails: { increment: 1 },
    };
  }
  if (['cancelled', 'suppressed', 'delivery_unknown'].includes(previousStatus)) return null;
  return { suppressed_emails: { increment: 1 } };
}

async function recordSuppressingEvent({ prisma, event, storedEvent, attempt, reason, now }) {
  const previousStatus = attempt.recipient.status;
  await addSuppression({
    prisma,
    userId: attempt.recipient.campaign.user_id,
    email: event.email,
    reason,
    source: 'provider_webhook',
    details: {
      providerEventId: event.eventId,
      providerMessageId: event.messageId,
      ...event.metadata,
    },
  });

  let changed = false;
  await prisma.$transaction(async (transaction) => {
    const transition = await transaction.campaignRecipient.updateMany({
      where: {
        id: attempt.recipient.id,
        status: { notIn: ['cancelled', 'suppressed', 'delivery_unknown'] },
      },
      data: {
        status: 'suppressed',
        suppressed_at: now,
        suppression_reason: reason,
        last_error: String(event.metadata.reason || event.type),
      },
    });
    changed = transition.count > 0;
    const counters = changed ? campaignCounterAdjustment(previousStatus) : null;
    if (counters) {
      await transaction.campaign.update({
        where: { id: attempt.recipient.campaign_id },
        data: counters,
      });
    }
    await transaction.deliveryAttempt.update({
      where: { id: attempt.id },
      data: {
        status: event.type,
        error_message: String(event.metadata.reason || event.type),
      },
    });
    await transaction.providerDeliveryEvent.update({
      where: { id: storedEvent.id },
      data: { outcome: 'processed', processed_at: now, error_message: null },
    });
    await transaction.campaignEvent.create({
      data: {
        campaign_id: attempt.recipient.campaign_id,
        actor_user_id: null,
        type: `provider.${event.type}`,
        to_status: 'suppressed',
        metadata: {
          providerEventId: event.eventId,
          providerMessageId: event.messageId,
          recipientId: attempt.recipient.id,
          suppressionReason: reason,
          recipientChanged: changed,
        },
      },
    });
  });
  return {
    duplicate: false,
    outcome: 'processed',
    eventId: event.eventId,
    recipientId: attempt.recipient.id,
    recipientChanged: changed,
    suppressionReason: reason,
  };
}

export async function ingestDeliveryEvent({
  prisma,
  value,
  rawPayload = value,
  now = new Date(),
}) {
  const event = parseDeliveryEvent(value);
  const attempt = await findDeliveryAttempt(prisma, event.messageId);
  const storedEvent = await createPendingEvent(prisma, event, attempt, rawPayload);
  if (storedEvent.duplicate && storedEvent.outcome !== 'pending') {
    return {
      duplicate: true,
      outcome: storedEvent.outcome,
      eventId: event.eventId,
      recipientId: storedEvent.recipient_id,
    };
  }
  const claim = await prisma.providerDeliveryEvent.updateMany({
    where: { id: storedEvent.id, outcome: 'pending' },
    data: { outcome: 'processing', error_message: null },
  });
  if (!claim.count) {
    const current = await prisma.providerDeliveryEvent.findUnique({ where: { id: storedEvent.id } });
    return {
      duplicate: true,
      outcome: current?.outcome || 'processing',
      eventId: event.eventId,
      recipientId: current?.recipient_id || null,
    };
  }

  try {
    if (!attempt) {
      return await finishWithoutRecipient({
        prisma,
        storedEvent,
        outcome: 'unmatched',
        errorMessage: 'No delivery attempt matches the provider message ID',
        now,
      });
    }
    if (!sameEmailAddress(attempt.recipient.email, event.email)) {
      return await finishWithoutRecipient({
        prisma,
        storedEvent,
        outcome: 'rejected',
        errorMessage: 'Event email does not match the delivery recipient',
        now,
      });
    }

    const reason = suppressionReasonForDeliveryEvent(event.type);
    if (reason) {
      return await recordSuppressingEvent({ prisma, event, storedEvent, attempt, reason, now });
    }
    return await recordInformationalEvent({ prisma, event, storedEvent, attempt, now });
  } catch (error) {
    try {
      await prisma.providerDeliveryEvent.update({
        where: { id: storedEvent.id },
        data: {
          outcome: 'pending',
          error_message: error instanceof Error ? error.message : String(error),
        },
      });
    } catch (statusError) {
      console.error('DELIVERY EVENT STATUS ERROR:', statusError);
    }
    throw error;
  }
}
