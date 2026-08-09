import {
  CAMPAIGN_STATUS,
  campaignProgressStatus,
  isTerminalCampaignStatus,
} from '../domain/campaignLifecycle.js';
import { inspectRecipientJobs } from './queueJobControl.js';
import { requeueCampaign } from './campaignManagement.js';

const QUEUE_TRACKED_STATUSES = new Set(['pending', 'queued', 'retrying']);
const REPAIRABLE_CAMPAIGN_STATUSES = new Set([
  CAMPAIGN_STATUS.SCHEDULED,
  CAMPAIGN_STATUS.RUNNING,
  CAMPAIGN_STATUS.QUEUE_FAILED,
  CAMPAIGN_STATUS.QUEUE_STATE_UNKNOWN,
]);

export class ReconciliationError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function boundedLimit(value, fallback = 25, maximum = 100) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ReconciliationError(
      'INVALID_RECONCILIATION_LIMIT',
      `limit must be an integer between 1 and ${maximum}`,
    );
  }
  return parsed;
}

export function booleanOption(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new ReconciliationError('INVALID_BOOLEAN_OPTION', 'Boolean option must be true or false');
}

export function recipientCounterSnapshot(groups) {
  const counts = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    total_emails: total,
    sent_emails: counts.sent ?? 0,
    failed_emails: counts.failed ?? 0,
    cancelled_emails: counts.cancelled ?? 0,
    suppressed_emails: counts.suppressed ?? 0,
    statusCounts: counts,
  };
}

export function counterDifferences(campaign, expected) {
  const fields = [
    'total_emails',
    'sent_emails',
    'failed_emails',
    'cancelled_emails',
    'suppressed_emails',
  ];
  return fields
    .filter((field) => campaign[field] !== expected[field])
    .map((field) => ({ field, actual: campaign[field], expected: expected[field] }));
}

export function expectedCampaignStatus(campaign, counters) {
  return campaignProgressStatus({
    totalEmails: counters.total_emails,
    sentEmails: counters.sent_emails,
    failedEmails: counters.failed_emails,
    cancelledEmails: counters.cancelled_emails,
    suppressedEmails: counters.suppressed_emails,
    currentStatus: campaign.status,
  });
}

export function summarizeQueueInspection(recipients, inspections) {
  const recipientByJobId = new Map(
    recipients.filter(({ queue_job_id: jobId }) => jobId).map((recipient) => [recipient.queue_job_id, recipient]),
  );
  const summary = {
    inspected: inspections.length,
    existing: 0,
    missing: 0,
    unknown: 0,
    stateCounts: {},
    missingRecipients: [],
    unknownRecipients: [],
  };

  for (const inspection of inspections) {
    const recipient = recipientByJobId.get(inspection.jobId);
    const state = inspection.state ?? 'unknown';
    summary.stateCounts[state] = (summary.stateCounts[state] ?? 0) + 1;
    if (inspection.exists === true) summary.existing += 1;
    if (inspection.exists === false) {
      summary.missing += 1;
      if (recipient) summary.missingRecipients.push(recipient.id);
    }
    if (inspection.exists == null) {
      summary.unknown += 1;
      if (recipient) summary.unknownRecipients.push(recipient.id);
    }
  }

  const withoutJobId = recipients.filter(({ queue_job_id: jobId }) => !jobId).map(({ id }) => id);
  summary.missing += withoutJobId.length;
  summary.missingRecipients.push(...withoutJobId);
  if (withoutJobId.length) {
    summary.stateCounts.unassigned = withoutJobId.length;
  }
  return summary;
}

function campaignReconciliationSelect() {
  return {
    id: true,
    user_id: true,
    name: true,
    status: true,
    total_emails: true,
    sent_emails: true,
    failed_emails: true,
    cancelled_emails: true,
    suppressed_emails: true,
    completed_at: true,
    deleted_at: true,
    recipients: {
      where: { status: { in: [...QUEUE_TRACKED_STATUSES] } },
      select: { id: true, status: true, queue_job_id: true },
      orderBy: { position: 'asc' },
    },
  };
}

async function requireOwnedCampaign(prisma, campaignId, userId) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, user_id: userId, deleted_at: null },
    select: campaignReconciliationSelect(),
  });
  if (!campaign) {
    throw new ReconciliationError('CAMPAIGN_NOT_FOUND', 'Campaign not found', 404);
  }
  return campaign;
}

export async function inspectCampaignIntegrity({ prisma, queue, campaignId, userId }) {
  const campaign = await requireOwnedCampaign(prisma, campaignId, userId);
  const groups = await prisma.campaignRecipient.groupBy({
    by: ['status'],
    where: { campaign_id: campaign.id },
    _count: { _all: true },
  });
  const expectedCounters = recipientCounterSnapshot(groups);
  const counterDrift = counterDifferences(campaign, expectedCounters);
  const calculatedStatus = expectedCampaignStatus(campaign, expectedCounters);
  const statusDrift = calculatedStatus !== campaign.status
    ? { actual: campaign.status, expected: calculatedStatus }
    : null;

  let queueInspection = {
    inspected: 0,
    existing: 0,
    missing: 0,
    unknown: 0,
    stateCounts: {},
    missingRecipients: [],
    unknownRecipients: [],
  };
  if (REPAIRABLE_CAMPAIGN_STATUSES.has(campaign.status) && campaign.recipients.length) {
    const inspections = await inspectRecipientJobs({
      queue,
      jobIds: campaign.recipients.map(({ queue_job_id: jobId }) => jobId).filter(Boolean),
    });
    queueInspection = summarizeQueueInspection(campaign.recipients, inspections);
  }

  const findings = {
    counterDrift,
    statusDrift,
    missingQueueJobs: queueInspection.missingRecipients,
    unknownQueueJobs: queueInspection.unknownRecipients,
  };
  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
    },
    expectedCounters,
    queueInspection,
    findings,
    healthy: counterDrift.length === 0
      && !statusDrift
      && queueInspection.missing === 0
      && queueInspection.unknown === 0,
  };
}

function counterUpdate(expectedCounters) {
  return {
    total_emails: expectedCounters.total_emails,
    sent_emails: expectedCounters.sent_emails,
    failed_emails: expectedCounters.failed_emails,
    cancelled_emails: expectedCounters.cancelled_emails,
    suppressed_emails: expectedCounters.suppressed_emails,
  };
}

export async function repairCampaignIntegrity({
  prisma,
  queue,
  campaignId,
  userId,
  dryRun = true,
  now = new Date(),
}) {
  const inspection = await inspectCampaignIntegrity({ prisma, queue, campaignId, userId });
  const shouldRepairCounters = inspection.findings.counterDrift.length > 0;
  const shouldRepairStatus = Boolean(inspection.findings.statusDrift)
    && !isTerminalCampaignStatus(inspection.campaign.status);
  const shouldRequeue = inspection.queueInspection.missing > 0
    && REPAIRABLE_CAMPAIGN_STATUSES.has(inspection.campaign.status);
  const actions = {
    updateCounters: shouldRepairCounters,
    updateStatus: shouldRepairStatus,
    requeueRecipients: shouldRequeue,
  };

  if (dryRun || (!shouldRepairCounters && !shouldRepairStatus && !shouldRequeue)) {
    return { dryRun, repaired: false, actions, inspection };
  }

  if (shouldRepairCounters || shouldRepairStatus) {
    const data = {
      ...(shouldRepairCounters ? counterUpdate(inspection.expectedCounters) : {}),
      ...(shouldRepairStatus ? { status: inspection.findings.statusDrift.expected } : {}),
    };
    if (shouldRepairStatus && inspection.findings.statusDrift.expected === CAMPAIGN_STATUS.COMPLETED) {
      data.completed_at = now;
    }
    await prisma.$transaction([
      prisma.campaign.update({ where: { id: campaignId }, data }),
      prisma.campaignEvent.create({
        data: {
          campaign_id: campaignId,
          actor_user_id: userId,
          type: 'campaign.reconciled',
          from_status: inspection.campaign.status,
          to_status: data.status ?? inspection.campaign.status,
          metadata: {
            counterDrift: inspection.findings.counterDrift,
            missingQueueJobs: inspection.queueInspection.missing,
            occurredAt: now.toISOString(),
          },
        },
      }),
    ]);
  }

  let queueRepair = null;
  if (shouldRequeue) {
    queueRepair = await requeueCampaign({ prisma, queue, campaignId, userId, now: now.getTime() });
  }
  return { dryRun: false, repaired: true, actions, inspection, queueRepair };
}

export async function reconcileCampaignBatch({
  prisma,
  queue,
  userId,
  query = {},
  now = new Date(),
}) {
  const limit = boundedLimit(query.limit);
  const dryRun = booleanOption(query.dryRun, true);
  const campaigns = await prisma.campaign.findMany({
    where: {
      user_id: userId,
      deleted_at: null,
      status: { notIn: [CAMPAIGN_STATUS.CANCELLED] },
    },
    select: { id: true },
    orderBy: { created_at: 'asc' },
    take: limit,
  });
  const results = [];
  for (const campaign of campaigns) {
    try {
      results.push(await repairCampaignIntegrity({
        prisma,
        queue,
        campaignId: campaign.id,
        userId,
        dryRun,
        now,
      }));
    } catch (error) {
      results.push({
        campaignId: campaign.id,
        repaired: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    dryRun,
    inspected: results.length,
    healthy: results.filter((result) => result.inspection?.healthy).length,
    repaired: results.filter((result) => result.repaired).length,
    failed: results.filter((result) => result.error).length,
    results,
  };
}
