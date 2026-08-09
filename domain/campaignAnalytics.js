const OUTCOME_FIELDS = Object.freeze({
  sent: 'sent_emails',
  failed: 'failed_emails',
  cancelled: 'cancelled_emails',
  suppressed: 'suppressed_emails',
});

export class CampaignAnalyticsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CampaignAnalyticsError';
    this.code = code;
    this.details = details;
  }
}

function nonNegativeInteger(value, name) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0) {
    throw new CampaignAnalyticsError(
      'INVALID_CAMPAIGN_COUNTER',
      `${name} must be a non-negative integer`,
      { field: name, value },
    );
  }
  return number;
}

export function ratio(numerator, denominator, precision = 4) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(precision));
}

export function percentage(numerator, denominator, precision = 2) {
  return Number((ratio(numerator, denominator, precision + 2) * 100).toFixed(precision));
}

export function campaignOutcomeMetrics(campaign) {
  const total = nonNegativeInteger(campaign.total_emails, 'total_emails');
  const outcomes = Object.fromEntries(
    Object.entries(OUTCOME_FIELDS).map(([name, field]) => [
      name,
      nonNegativeInteger(campaign[field], field),
    ]),
  );
  const processed = Object.values(outcomes).reduce((sum, value) => sum + value, 0);
  const pending = Math.max(0, total - processed);
  return {
    total,
    ...outcomes,
    processed,
    pending,
    progressPercent: percentage(processed, total),
    acceptedRate: percentage(outcomes.sent, processed),
    failureRate: percentage(outcomes.failed, processed),
    suppressionRate: percentage(outcomes.suppressed, processed),
    cancellationRate: percentage(outcomes.cancelled, processed),
    countersConsistent: processed <= total,
  };
}

export function campaignHealth(metrics) {
  if (!metrics.countersConsistent) {
    return { level: 'critical', reason: 'counter_mismatch' };
  }
  if (metrics.total === 0) return { level: 'unknown', reason: 'empty_campaign' };
  if (metrics.suppressionRate >= 10) return { level: 'critical', reason: 'high_suppression_rate' };
  if (metrics.failureRate >= 20) return { level: 'critical', reason: 'high_failure_rate' };
  if (metrics.suppressionRate >= 3) return { level: 'warning', reason: 'elevated_suppression_rate' };
  if (metrics.failureRate >= 8) return { level: 'warning', reason: 'elevated_failure_rate' };
  return { level: 'healthy', reason: 'within_thresholds' };
}

function validDate(value, field) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CampaignAnalyticsError('INVALID_DATE_RANGE', `${field} must be a valid date`, { field });
  }
  return date;
}

export function normalizeAnalyticsRange({
  from,
  to,
  now = new Date(),
  defaultDays = 30,
  maximumDays = 366,
}) {
  const end = to ? validDate(to, 'to') : new Date(now);
  const start = from
    ? validDate(from, 'from')
    : new Date(end.getTime() - ((defaultDays - 1) * 86_400_000));
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(23, 59, 59, 999);
  if (start > end) {
    throw new CampaignAnalyticsError('INVALID_DATE_RANGE', 'from must be before or equal to to');
  }
  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  if (days > maximumDays) {
    throw new CampaignAnalyticsError(
      'DATE_RANGE_TOO_LARGE',
      `Analytics range cannot exceed ${maximumDays} days`,
      { maximumDays },
    );
  }
  return { from: start, to: end, days };
}

export function utcDayKey(value) {
  return validDate(value, 'timestamp').toISOString().slice(0, 10);
}

export function utcHourKey(value) {
  return `${validDate(value, 'timestamp').toISOString().slice(0, 13)}:00:00.000Z`;
}

export function aggregateOutcomeSeries(rows, { interval = 'day' } = {}) {
  if (!['day', 'hour'].includes(interval)) {
    throw new CampaignAnalyticsError('INVALID_ANALYTICS_INTERVAL', 'interval must be day or hour');
  }
  const keyFor = interval === 'day' ? utcDayKey : utcHourKey;
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFor(row.timestamp);
    const bucket = buckets.get(key) || {
      timestamp: key,
      sent: 0,
      failed: 0,
      cancelled: 0,
      suppressed: 0,
      total: 0,
    };
    const status = row.status;
    if (Object.hasOwn(bucket, status) && status !== 'total') bucket[status] += 1;
    bucket.total += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function denseDailySeries(series, range) {
  const byDate = new Map(series.map((bucket) => [bucket.timestamp.slice(0, 10), bucket]));
  const result = [];
  const cursor = new Date(range.from);
  cursor.setUTCHours(0, 0, 0, 0);
  const finalDay = new Date(range.to);
  finalDay.setUTCHours(0, 0, 0, 0);
  while (cursor <= finalDay) {
    const key = utcDayKey(cursor);
    result.push(byDate.get(key) || {
      timestamp: key,
      sent: 0,
      failed: 0,
      cancelled: 0,
      suppressed: 0,
      total: 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function compareMetricPeriods(current, previous) {
  const keys = new Set([...Object.keys(current), ...Object.keys(previous)]);
  return Object.fromEntries([...keys].map((key) => {
    const currentValue = Number(current[key] || 0);
    const previousValue = Number(previous[key] || 0);
    const absoluteChange = currentValue - previousValue;
    const percentChange = previousValue === 0
      ? (currentValue === 0 ? 0 : null)
      : percentage(absoluteChange, previousValue);
    return [key, { current: currentValue, previous: previousValue, absoluteChange, percentChange }];
  }));
}

export function rankFailureReasons(rows, limit = 10) {
  const counts = new Map();
  for (const row of rows) {
    const reason = typeof row.reason === 'string' && row.reason.trim()
      ? row.reason.trim()
      : 'Unknown failure';
    counts.set(reason, (counts.get(reason) || 0) + Number(row.count || 1));
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, Math.max(0, limit));
}

export function estimateCampaignCompletion({ pending, intervalMs, now = new Date() }) {
  const pendingCount = nonNegativeInteger(pending, 'pending');
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new CampaignAnalyticsError('INVALID_DELIVERY_INTERVAL', 'intervalMs must be non-negative');
  }
  return {
    pending: pendingCount,
    estimatedDurationMs: pendingCount > 0 ? (pendingCount - 1) * interval : 0,
    estimatedCompletionAt: new Date(now.getTime() + (pendingCount > 0 ? (pendingCount - 1) * interval : 0)),
  };
}
