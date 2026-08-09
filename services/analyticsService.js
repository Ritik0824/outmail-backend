import {
  aggregateOutcomeSeries,
  campaignHealth,
  campaignOutcomeMetrics,
  compareMetricPeriods,
  denseDailySeries,
  estimateCampaignCompletion,
  normalizeAnalyticsRange,
  rankFailureReasons,
} from '../domain/campaignAnalytics.js';

const TERMINAL_RECIPIENT_STATUSES = new Set(['sent', 'failed', 'cancelled', 'suppressed']);

export class AnalyticsServiceError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'AnalyticsServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function dateForRecipientOutcome(recipient) {
  if (recipient.status === 'sent') return recipient.sent_at ?? recipient.updated_at;
  if (recipient.status === 'failed') return recipient.failed_at ?? recipient.updated_at;
  if (recipient.status === 'suppressed') return recipient.suppressed_at ?? recipient.updated_at;
  return recipient.updated_at;
}

function serializeRecipientOutcomes(recipients) {
  return recipients
    .filter((recipient) => TERMINAL_RECIPIENT_STATUSES.has(recipient.status))
    .map((recipient) => ({
      status: recipient.status,
      timestamp: dateForRecipientOutcome(recipient),
    }))
    .filter((outcome) => outcome.timestamp);
}

function normalizeStatusGroups(groups) {
  return Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
}

function normalizeProviderGroups(groups) {
  return Object.fromEntries(groups.map((group) => [group.type, group._count._all]));
}

function summarizeCampaign(campaign) {
  const metrics = campaignOutcomeMetrics(campaign);
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    scheduledStart: campaign.scheduled_start,
    createdAt: campaign.created_at,
    startedAt: campaign.started_at,
    completedAt: campaign.completed_at,
    metrics,
    health: campaignHealth(metrics),
  };
}

function sumCampaignCounters(campaigns) {
  return campaigns.reduce((totals, campaign) => {
    totals.total += campaign.total_emails;
    totals.sent += campaign.sent_emails;
    totals.failed += campaign.failed_emails;
    totals.cancelled += campaign.cancelled_emails;
    totals.suppressed += campaign.suppressed_emails;
    return totals;
  }, { total: 0, sent: 0, failed: 0, cancelled: 0, suppressed: 0 });
}

function campaignCounterSelect() {
  return {
    id: true,
    name: true,
    status: true,
    scheduled_start: true,
    created_at: true,
    started_at: true,
    completed_at: true,
    total_emails: true,
    sent_emails: true,
    failed_emails: true,
    cancelled_emails: true,
    suppressed_emails: true,
  };
}

async function requireOwnedCampaign(prisma, campaignId, userId) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, user_id: userId, deleted_at: null },
    select: campaignCounterSelect(),
  });
  if (!campaign) {
    throw new AnalyticsServiceError('CAMPAIGN_NOT_FOUND', 'Campaign not found', 404);
  }
  return campaign;
}

export function previousRange(range) {
  const duration = range.to.getTime() - range.from.getTime() + 1;
  const to = new Date(range.from.getTime() - 1);
  const from = new Date(to.getTime() - duration + 1);
  return { from, to };
}

export function campaignVelocity(campaign, metrics, now = new Date()) {
  const activeSince = campaign.started_at ?? campaign.scheduled_start ?? campaign.created_at;
  if (!activeSince || metrics.processed === 0) {
    return { processedPerMinute: 0, estimatedCompletionAt: null };
  }

  const elapsedMinutes = Math.max(1 / 60, (now.getTime() - activeSince.getTime()) / 60_000);
  const processedPerMinute = Number((metrics.processed / elapsedMinutes).toFixed(2));
  return {
    processedPerMinute,
    estimatedCompletionAt: estimateCampaignCompletion({
      pending: metrics.pending,
      intervalMs: 60_000 / processedPerMinute,
      now,
    }).estimatedCompletionAt,
  };
}

export async function getAnalyticsOverview({ prisma, userId, query = {}, now = new Date() }) {
  const range = normalizeAnalyticsRange({ ...query, now });
  const comparisonRange = previousRange(range);
  const commonWhere = { user_id: userId, deleted_at: null };
  const [campaigns, previousCampaigns, statusGroups, activeSuppressions, recentFailures] =
    await prisma.$transaction([
      prisma.campaign.findMany({
        where: { ...commonWhere, created_at: { gte: range.from, lte: range.to } },
        orderBy: { created_at: 'desc' },
        select: campaignCounterSelect(),
      }),
      prisma.campaign.findMany({
        where: {
          ...commonWhere,
          created_at: { gte: comparisonRange.from, lte: comparisonRange.to },
        },
        select: campaignCounterSelect(),
      }),
      prisma.campaign.groupBy({
        by: ['status'],
        where: commonWhere,
        _count: { _all: true },
      }),
      prisma.suppressionEntry.count({ where: { user_id: userId, removed_at: null } }),
      prisma.campaignRecipient.findMany({
        where: {
          campaign: commonWhere,
          status: 'failed',
          failed_at: { gte: range.from, lte: range.to },
        },
        select: { last_error: true },
        take: 10_000,
      }),
    ]);

  const current = sumCampaignCounters(campaigns);
  const previous = sumCampaignCounters(previousCampaigns);
  return {
    range,
    campaignCount: campaigns.length,
    statusCounts: normalizeStatusGroups(statusGroups),
    activeSuppressions,
    totals: current,
    comparisons: compareMetricPeriods(
      { campaigns: campaigns.length, recipients: current.total, sent: current.sent, failed: current.failed },
      {
        campaigns: previousCampaigns.length,
        recipients: previous.total,
        sent: previous.sent,
        failed: previous.failed,
      },
    ),
    failureReasons: rankFailureReasons(
      recentFailures.map(({ last_error }) => ({ reason: last_error, count: 1 })),
    ),
    recentCampaigns: campaigns.slice(0, 10).map(summarizeCampaign),
  };
}

export async function getCampaignAnalytics({
  prisma,
  campaignId,
  userId,
  query = {},
  now = new Date(),
}) {
  const campaign = await requireOwnedCampaign(prisma, campaignId, userId);
  const range = normalizeAnalyticsRange({ ...query, now });
  const [recipients, recipientGroups, providerGroups, attempts, latestEvent] =
    await prisma.$transaction([
      prisma.campaignRecipient.findMany({
        where: {
          campaign_id: campaign.id,
          updated_at: { gte: range.from, lte: range.to },
        },
        select: {
          status: true,
          sent_at: true,
          failed_at: true,
          suppressed_at: true,
          updated_at: true,
          last_error: true,
        },
        take: 100_000,
      }),
      prisma.campaignRecipient.groupBy({
        by: ['status'],
        where: { campaign_id: campaign.id },
        _count: { _all: true },
      }),
      prisma.providerDeliveryEvent.groupBy({
        by: ['type'],
        where: {
          recipient: { campaign_id: campaign.id },
          occurred_at: { gte: range.from, lte: range.to },
        },
        _count: { _all: true },
      }),
      prisma.deliveryAttempt.aggregate({
        where: {
          recipient: { campaign_id: campaign.id },
          created_at: { gte: range.from, lte: range.to },
        },
        _count: { _all: true },
        _avg: { attempt_number: true },
        _max: { attempt_number: true },
      }),
      prisma.campaignEvent.findFirst({
        where: { campaign_id: campaign.id },
        orderBy: { created_at: 'desc' },
        select: { type: true, created_at: true },
      }),
    ]);

  const metrics = campaignOutcomeMetrics(campaign);
  const outcomes = serializeRecipientOutcomes(recipients);
  const sparseSeries = aggregateOutcomeSeries(outcomes, { interval: 'day' });
  return {
    campaign: summarizeCampaign(campaign),
    range,
    velocity: campaignVelocity(campaign, metrics, now),
    recipientStatusCounts: normalizeStatusGroups(recipientGroups),
    providerEventCounts: normalizeProviderGroups(providerGroups),
    deliveryAttempts: {
      count: attempts._count._all,
      averagePerRecipient: Number((attempts._avg.attempt_number ?? 0).toFixed(2)),
      maximumForRecipient: attempts._max.attempt_number ?? 0,
    },
    dailyOutcomes: denseDailySeries(sparseSeries, range),
    failureReasons: rankFailureReasons(
      recipients
        .filter(({ status }) => status === 'failed')
        .map(({ last_error }) => ({ reason: last_error, count: 1 })),
    ),
    latestLifecycleEvent: latestEvent,
  };
}

export async function getDeliveryTrends({ prisma, userId, query = {}, now = new Date() }) {
  const range = normalizeAnalyticsRange({ ...query, now });
  const recipients = await prisma.campaignRecipient.findMany({
    where: {
      campaign: { user_id: userId, deleted_at: null },
      updated_at: { gte: range.from, lte: range.to },
      status: { in: [...TERMINAL_RECIPIENT_STATUSES] },
    },
    select: {
      status: true,
      sent_at: true,
      failed_at: true,
      suppressed_at: true,
      updated_at: true,
    },
    take: 100_000,
  });
  const outcomes = serializeRecipientOutcomes(recipients);
  return {
    range,
    outcomes: outcomes.length,
    daily: denseDailySeries(aggregateOutcomeSeries(outcomes, { interval: 'day' }), range),
  };
}
