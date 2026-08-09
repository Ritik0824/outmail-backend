export const CAMPAIGN_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  QUEUE_FAILED: 'queue_failed',
  QUEUE_STATE_UNKNOWN: 'queue_state_unknown',
  RUNNING: 'running',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
});

export const CAMPAIGN_ACTION = Object.freeze({
  PAUSE: 'pause',
  RESUME: 'resume',
  CANCEL: 'cancel',
});

const PAUSABLE = new Set([
  CAMPAIGN_STATUS.SCHEDULED,
  CAMPAIGN_STATUS.RUNNING,
  CAMPAIGN_STATUS.QUEUE_FAILED,
  CAMPAIGN_STATUS.QUEUE_STATE_UNKNOWN,
]);

const CANCELLABLE = new Set([
  ...PAUSABLE,
  CAMPAIGN_STATUS.PAUSED,
]);

export class CampaignTransitionError extends Error {
  constructor(code, message, { status = 409, details = {} } = {}) {
    super(message);
    this.name = 'CampaignTransitionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function assertKnownAction(action) {
  if (!Object.values(CAMPAIGN_ACTION).includes(action)) {
    throw new CampaignTransitionError(
      'UNKNOWN_CAMPAIGN_ACTION',
      `Unknown campaign action: ${action}`,
      { status: 400, details: { action } },
    );
  }
}

export function isTerminalCampaignStatus(status) {
  return [CAMPAIGN_STATUS.CANCELLED, CAMPAIGN_STATUS.COMPLETED].includes(status);
}

export function assertCampaignActionAllowed(status, action) {
  assertKnownAction(action);

  if (action === CAMPAIGN_ACTION.PAUSE && PAUSABLE.has(status)) return;
  if (action === CAMPAIGN_ACTION.RESUME && status === CAMPAIGN_STATUS.PAUSED) return;
  if (action === CAMPAIGN_ACTION.CANCEL && CANCELLABLE.has(status)) return;

  throw new CampaignTransitionError(
    'CAMPAIGN_TRANSITION_NOT_ALLOWED',
    `Cannot ${action} a campaign with status ${status}`,
    { details: { action, status } },
  );
}

export function campaignTransition({ status, action, startedAt = null, now = new Date() }) {
  assertCampaignActionAllowed(status, action);

  if (action === CAMPAIGN_ACTION.PAUSE) {
    return {
      status: CAMPAIGN_STATUS.PAUSED,
      paused_at: now,
    };
  }

  if (action === CAMPAIGN_ACTION.RESUME) {
    return {
      status: startedAt ? CAMPAIGN_STATUS.RUNNING : CAMPAIGN_STATUS.SCHEDULED,
      paused_at: null,
    };
  }

  return {
    status: CAMPAIGN_STATUS.CANCELLED,
    cancelled_at: now,
    paused_at: null,
  };
}

export function campaignProgressStatus({
  totalEmails,
  sentEmails,
  failedEmails,
  cancelledEmails = 0,
  suppressedEmails = 0,
  currentStatus,
}) {
  if (isTerminalCampaignStatus(currentStatus)) return currentStatus;
  if (currentStatus === CAMPAIGN_STATUS.PAUSED) return CAMPAIGN_STATUS.PAUSED;

  const accountedFor = sentEmails + failedEmails + cancelledEmails + suppressedEmails;
  if (totalEmails > 0 && accountedFor >= totalEmails) {
    return CAMPAIGN_STATUS.COMPLETED;
  }
  if (sentEmails > 0 || failedEmails > 0) return CAMPAIGN_STATUS.RUNNING;
  return CAMPAIGN_STATUS.SCHEDULED;
}

export function recipientStatusForCampaignAction(action) {
  assertKnownAction(action);
  if (action === CAMPAIGN_ACTION.PAUSE) return 'paused';
  if (action === CAMPAIGN_ACTION.RESUME) return 'queued';
  return 'cancelled';
}
