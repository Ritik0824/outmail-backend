export const SUPPRESSION_REASON = Object.freeze({
  MANUAL: 'manual',
  UNSUBSCRIBED: 'unsubscribed',
  HARD_BOUNCE: 'hard_bounce',
  COMPLAINT: 'complaint',
});

export const SUPPRESSION_SOURCE = Object.freeze({
  DASHBOARD: 'dashboard',
  PUBLIC_UNSUBSCRIBE: 'public_unsubscribe',
  PROVIDER_WEBHOOK: 'provider_webhook',
  IMPORT: 'import',
});

const REASON_PRIORITY = Object.freeze({
  [SUPPRESSION_REASON.MANUAL]: 1,
  [SUPPRESSION_REASON.UNSUBSCRIBED]: 2,
  [SUPPRESSION_REASON.HARD_BOUNCE]: 3,
  [SUPPRESSION_REASON.COMPLAINT]: 4,
});

export class SuppressionRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SuppressionRuleError';
    this.code = code;
    this.details = details;
  }
}

export function assertSuppressionReason(reason) {
  if (!Object.values(SUPPRESSION_REASON).includes(reason)) {
    throw new SuppressionRuleError(
      'INVALID_SUPPRESSION_REASON',
      `Unknown suppression reason: ${reason}`,
      { reason },
    );
  }
  return reason;
}

export function assertSuppressionSource(source) {
  if (!Object.values(SUPPRESSION_SOURCE).includes(source)) {
    throw new SuppressionRuleError(
      'INVALID_SUPPRESSION_SOURCE',
      `Unknown suppression source: ${source}`,
      { source },
    );
  }
  return source;
}

export function strongerSuppressionReason(currentReason, incomingReason) {
  assertSuppressionReason(incomingReason);
  if (!currentReason) return incomingReason;
  assertSuppressionReason(currentReason);
  return REASON_PRIORITY[incomingReason] >= REASON_PRIORITY[currentReason]
    ? incomingReason
    : currentReason;
}

export function canRemoveSuppression(reason) {
  assertSuppressionReason(reason);
  return reason === SUPPRESSION_REASON.MANUAL;
}

export function suppressionDecision(record) {
  if (!record || record.removed_at) {
    return { suppressed: false, reason: null, source: null };
  }
  return {
    suppressed: true,
    reason: record.reason,
    source: record.source,
  };
}
