import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalyticsServiceError,
  campaignVelocity,
  getAnalyticsOverview,
  getCampaignAnalytics,
  getDeliveryTrends,
  previousRange,
} from '../../services/analyticsService.js';

const baseCampaign = {
  id: 'campaign-1',
  name: 'August launch',
  status: 'running',
  scheduled_start: new Date('2026-08-08T10:00:00.000Z'),
  created_at: new Date('2026-08-08T09:00:00.000Z'),
  started_at: new Date('2026-08-08T10:00:00.000Z'),
  completed_at: null,
  total_emails: 100,
  sent_emails: 70,
  failed_emails: 5,
  cancelled_emails: 0,
  suppressed_emails: 5,
};

test('previousRange creates an adjacent period with equal duration', () => {
  const current = {
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-08-07T23:59:59.999Z'),
  };
  const previous = previousRange(current);
  assert.equal(previous.to.toISOString(), '2026-07-31T23:59:59.999Z');
  assert.equal(previous.from.toISOString(), '2026-07-25T00:00:00.000Z');
});

test('campaignVelocity estimates remaining processing time', () => {
  const velocity = campaignVelocity(
    baseCampaign,
    { processed: 80, pending: 20 },
    new Date('2026-08-08T10:40:00.000Z'),
  );
  assert.equal(velocity.processedPerMinute, 2);
  assert.equal(velocity.estimatedCompletionAt.toISOString(), '2026-08-08T10:49:30.000Z');
});

test('campaignVelocity reports no estimate before processing starts', () => {
  assert.deepEqual(campaignVelocity(baseCampaign, { processed: 0, pending: 100 }), {
    processedPerMinute: 0,
    estimatedCompletionAt: null,
  });
});

test('getAnalyticsOverview scopes every query to the owner and compares periods', async () => {
  const operations = [];
  const prisma = {
    campaign: {
      findMany: (args) => {
        operations.push(args);
        return Promise.resolve(operations.length === 1 ? [baseCampaign] : []);
      },
      groupBy: async () => [{ status: 'running', _count: { _all: 2 } }],
    },
    suppressionEntry: { count: async () => 3 },
    campaignRecipient: {
      findMany: async () => [{ last_error: 'Mailbox unavailable' }, { last_error: 'Mailbox unavailable' }],
    },
    $transaction: (promises) => Promise.all(promises),
  };
  const result = await getAnalyticsOverview({
    prisma,
    userId: 'user-1',
    query: { from: '2026-08-01', to: '2026-08-09' },
    now: new Date('2026-08-09T12:00:00.000Z'),
  });

  assert.equal(operations[0].where.user_id, 'user-1');
  assert.equal(operations[1].where.user_id, 'user-1');
  assert.equal(result.campaignCount, 1);
  assert.equal(result.totals.sent, 70);
  assert.equal(result.statusCounts.running, 2);
  assert.equal(result.comparisons.sent.current, 70);
  assert.equal(result.comparisons.sent.percentChange, null);
  assert.deepEqual(result.failureReasons[0], { reason: 'Mailbox unavailable', count: 2 });
});

test('getCampaignAnalytics returns a dense outcome series and provider metrics', async () => {
  const prisma = {
    campaign: { findFirst: async () => baseCampaign },
    campaignRecipient: {
      findMany: async () => [{
        status: 'sent',
        sent_at: new Date('2026-08-08T12:00:00.000Z'),
        failed_at: null,
        suppressed_at: null,
        updated_at: new Date('2026-08-08T12:00:00.000Z'),
        last_error: null,
      }],
      groupBy: async () => [{ status: 'sent', _count: { _all: 70 } }],
    },
    providerDeliveryEvent: {
      groupBy: async () => [{ type: 'delivered', _count: { _all: 65 } }],
    },
    deliveryAttempt: {
      aggregate: async () => ({
        _count: { _all: 80 },
        _avg: { attempt_number: 1.15 },
        _max: { attempt_number: 3 },
      }),
    },
    campaignEvent: {
      findFirst: async () => ({ type: 'started', created_at: new Date('2026-08-08T10:00:00Z') }),
    },
    $transaction: (promises) => Promise.all(promises),
  };
  const result = await getCampaignAnalytics({
    prisma,
    campaignId: 'campaign-1',
    userId: 'user-1',
    query: { from: '2026-08-08', to: '2026-08-09' },
    now: new Date('2026-08-09T00:00:00.000Z'),
  });

  assert.equal(result.campaign.metrics.progressPercent, 80);
  assert.equal(result.recipientStatusCounts.sent, 70);
  assert.equal(result.providerEventCounts.delivered, 65);
  assert.equal(result.deliveryAttempts.maximumForRecipient, 3);
  assert.equal(result.dailyOutcomes.length, 2);
  assert.equal(result.dailyOutcomes[0].sent, 1);
});

test('getCampaignAnalytics rejects campaigns belonging to another user', async () => {
  const prisma = { campaign: { findFirst: async () => null } };
  await assert.rejects(
    getCampaignAnalytics({ prisma, campaignId: 'campaign-1', userId: 'other-user' }),
    (error) => error instanceof AnalyticsServiceError
      && error.code === 'CAMPAIGN_NOT_FOUND'
      && error.status === 404,
  );
});

test('getDeliveryTrends aggregates only terminal outcomes in range', async () => {
  let arguments_;
  const prisma = {
    campaignRecipient: {
      findMany: async (args) => {
        arguments_ = args;
        return [{
          status: 'failed',
          sent_at: null,
          failed_at: new Date('2026-08-09T08:00:00.000Z'),
          suppressed_at: null,
          updated_at: new Date('2026-08-09T08:00:00.000Z'),
        }];
      },
    },
  };
  const result = await getDeliveryTrends({
    prisma,
    userId: 'user-1',
    query: { from: '2026-08-09', to: '2026-08-09' },
  });
  assert.equal(arguments_.where.campaign.user_id, 'user-1');
  assert.equal(result.outcomes, 1);
  assert.equal(result.daily[0].failed, 1);
});
