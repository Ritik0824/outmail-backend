import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateOutcomeSeries,
  campaignHealth,
  campaignOutcomeMetrics,
  compareMetricPeriods,
  denseDailySeries,
  estimateCampaignCompletion,
  normalizeAnalyticsRange,
  percentage,
  rankFailureReasons,
} from '../../domain/campaignAnalytics.js';

test('campaignOutcomeMetrics calculates progress and rates', () => {
  const metrics = campaignOutcomeMetrics({
    total_emails: 100,
    sent_emails: 70,
    failed_emails: 10,
    cancelled_emails: 5,
    suppressed_emails: 5,
  });
  assert.deepEqual(metrics, {
    total: 100,
    sent: 70,
    failed: 10,
    cancelled: 5,
    suppressed: 5,
    processed: 90,
    pending: 10,
    progressPercent: 90,
    acceptedRate: 77.78,
    failureRate: 11.11,
    suppressionRate: 5.56,
    cancellationRate: 5.56,
    countersConsistent: true,
  });
});

test('campaignOutcomeMetrics identifies counter mismatches', () => {
  const metrics = campaignOutcomeMetrics({
    total_emails: 2,
    sent_emails: 2,
    failed_emails: 1,
  });
  assert.equal(metrics.pending, 0);
  assert.equal(metrics.countersConsistent, false);
  assert.deepEqual(campaignHealth(metrics), { level: 'critical', reason: 'counter_mismatch' });
});

test('campaignHealth classifies suppression and failure thresholds', () => {
  const base = {
    total: 100,
    countersConsistent: true,
    failureRate: 0,
    suppressionRate: 0,
  };
  assert.equal(campaignHealth(base).level, 'healthy');
  assert.equal(campaignHealth({ ...base, failureRate: 8 }).level, 'warning');
  assert.equal(campaignHealth({ ...base, failureRate: 20 }).level, 'critical');
  assert.equal(campaignHealth({ ...base, suppressionRate: 3 }).level, 'warning');
  assert.equal(campaignHealth({ ...base, suppressionRate: 10 }).level, 'critical');
});

test('percentage handles empty denominators deterministically', () => {
  assert.equal(percentage(1, 0), 0);
  assert.equal(percentage(1, 3), 33.33);
});

test('normalizeAnalyticsRange defaults to thirty inclusive UTC days', () => {
  const range = normalizeAnalyticsRange({ now: new Date('2026-08-12T10:00:00.000Z') });
  assert.equal(range.from.toISOString(), '2026-07-14T00:00:00.000Z');
  assert.equal(range.to.toISOString(), '2026-08-12T23:59:59.999Z');
  assert.equal(range.days, 30);
});

test('normalizeAnalyticsRange validates order and maximum size', () => {
  assert.throws(
    () => normalizeAnalyticsRange({ from: '2026-08-13', to: '2026-08-12' }),
    (error) => error.code === 'INVALID_DATE_RANGE',
  );
  assert.throws(
    () => normalizeAnalyticsRange({ from: '2020-01-01', to: '2026-08-12' }),
    (error) => error.code === 'DATE_RANGE_TOO_LARGE',
  );
});

test('aggregateOutcomeSeries groups and sorts daily outcomes', () => {
  const series = aggregateOutcomeSeries([
    { timestamp: '2026-08-12T11:00:00Z', status: 'failed' },
    { timestamp: '2026-08-11T11:00:00Z', status: 'sent' },
    { timestamp: '2026-08-12T12:00:00Z', status: 'sent' },
  ]);
  assert.deepEqual(series, [
    { timestamp: '2026-08-11', sent: 1, failed: 0, cancelled: 0, suppressed: 0, total: 1 },
    { timestamp: '2026-08-12', sent: 1, failed: 1, cancelled: 0, suppressed: 0, total: 2 },
  ]);
});

test('aggregateOutcomeSeries supports hourly buckets and validates interval', () => {
  assert.equal(aggregateOutcomeSeries([
    { timestamp: '2026-08-12T11:22:00Z', status: 'sent' },
  ], { interval: 'hour' })[0].timestamp, '2026-08-12T11:00:00.000Z');
  assert.throws(
    () => aggregateOutcomeSeries([], { interval: 'week' }),
    (error) => error.code === 'INVALID_ANALYTICS_INTERVAL',
  );
});

test('denseDailySeries fills days with no outcomes', () => {
  const range = normalizeAnalyticsRange({ from: '2026-08-10', to: '2026-08-12' });
  const dense = denseDailySeries([
    { timestamp: '2026-08-11', sent: 1, failed: 0, cancelled: 0, suppressed: 0, total: 1 },
  ], range);
  assert.equal(dense.length, 3);
  assert.equal(dense[0].total, 0);
  assert.equal(dense[1].sent, 1);
  assert.equal(dense[2].total, 0);
});

test('compareMetricPeriods handles growth from zero without infinity', () => {
  const comparison = compareMetricPeriods({ sent: 10, failed: 1 }, { sent: 0, failed: 2 });
  assert.equal(comparison.sent.percentChange, null);
  assert.equal(comparison.failed.percentChange, -50);
});

test('rankFailureReasons merges duplicates and uses deterministic ties', () => {
  assert.deepEqual(rankFailureReasons([
    { reason: 'Mailbox full', count: 2 },
    { reason: 'Unknown user', count: 3 },
    { reason: 'Mailbox full', count: 1 },
    { reason: '', count: 1 },
  ], 3), [
    { reason: 'Mailbox full', count: 3 },
    { reason: 'Unknown user', count: 3 },
    { reason: 'Unknown failure', count: 1 },
  ]);
});

test('estimateCampaignCompletion respects the first immediate recipient', () => {
  const estimate = estimateCampaignCompletion({
    pending: 3,
    intervalMs: 120_000,
    now: new Date('2026-08-12T10:00:00.000Z'),
  });
  assert.equal(estimate.estimatedDurationMs, 240_000);
  assert.equal(estimate.estimatedCompletionAt.toISOString(), '2026-08-12T10:04:00.000Z');
  assert.equal(estimateCampaignCompletion({ pending: 0, intervalMs: 120_000 }).estimatedDurationMs, 0);
});
