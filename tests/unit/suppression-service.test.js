import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addSuppression,
  addSuppressionBatch,
  getSuppressionDecision,
  listSuppressions,
  removeSuppression,
  suppressionSummary,
} from '../../services/suppressionService.js';

function suppressionStore(initialEntries = []) {
  const entries = initialEntries.map((entry, index) => ({
    id: `entry-${index + 1}`,
    user_id: 'user-1',
    source: 'dashboard',
    details: {},
    removed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...entry,
  }));
  const key = ({ user_id, email }) => entries.find(
    (entry) => entry.user_id === user_id && entry.email === email,
  );
  const model = {
    findUnique: async ({ where }) => {
      if (where.id) return entries.find((entry) => entry.id === where.id) || null;
      return key(where.user_id_email) || null;
    },
    findMany: async ({ where }) => entries.filter((entry) => (
      entry.user_id === where.user_id
      && (!where.email?.in || where.email.in.includes(entry.email))
    )),
    upsert: async ({ where, create, update }) => {
      const existing = key(where.user_id_email);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const created = { id: `entry-${entries.length + 1}`, ...create };
      entries.push(created);
      return created;
    },
    update: async ({ where, data }) => {
      const entry = entries.find((candidate) => candidate.id === where.id);
      Object.assign(entry, data);
      return entry;
    },
    count: async ({ where }) => entries.filter((entry) => (
      entry.user_id === where.user_id
      && (where.removed_at !== null || entry.removed_at === null)
    )).length,
    groupBy: async () => {
      const counts = new Map();
      for (const entry of entries.filter(({ removed_at }) => !removed_at)) {
        counts.set(entry.reason, (counts.get(entry.reason) || 0) + 1);
      }
      return [...counts].map(([reason, count]) => ({ reason, _count: { _all: count } }));
    },
  };
  const prisma = {
    suppressionEntry: model,
    $transaction: async (value) => Array.isArray(value) ? Promise.all(value) : value({ suppressionEntry: model }),
  };
  return { prisma, entries };
}

test('addSuppression creates a normalized manual entry', async () => {
  const store = suppressionStore();
  const entry = await addSuppression({
    prisma: store.prisma,
    userId: 'user-1',
    email: ' ASHA@Example.com ',
  });

  assert.equal(entry.email, 'asha@example.com');
  assert.equal(entry.reason, 'manual');
  assert.equal(entry.source, 'dashboard');
  assert.equal(entry.removed_at, null);
});

test('addSuppression upgrades a weaker reason without downgrading a complaint', async () => {
  const store = suppressionStore([{ email: 'asha@example.com', reason: 'manual' }]);
  const upgraded = await addSuppression({
    prisma: store.prisma,
    userId: 'user-1',
    email: 'asha@example.com',
    reason: 'complaint',
    source: 'provider_webhook',
  });
  assert.equal(upgraded.reason, 'complaint');

  const preserved = await addSuppression({
    prisma: store.prisma,
    userId: 'user-1',
    email: 'asha@example.com',
    reason: 'manual',
  });
  assert.equal(preserved.reason, 'complaint');
  assert.equal(preserved.source, 'provider_webhook');
});

test('addSuppression rejects invalid details and email values', async () => {
  const store = suppressionStore();
  await assert.rejects(
    addSuppression({ prisma: store.prisma, userId: 'user-1', email: 'invalid' }),
    (error) => error.code === 'INVALID_EMAIL',
  );
  await assert.rejects(
    addSuppression({
      prisma: store.prisma,
      userId: 'user-1',
      email: 'valid@example.com',
      details: ['not', 'an', 'object'],
    }),
    (error) => error.code === 'INVALID_SUPPRESSION_DETAILS',
  );
});

test('addSuppressionBatch reports created and updated entries', async () => {
  const store = suppressionStore([{ email: 'existing@example.com', reason: 'manual' }]);
  const result = await addSuppressionBatch({
    prisma: store.prisma,
    userId: 'user-1',
    emails: ['existing@example.com', 'new@example.com', 'NEW@example.com'],
    reason: 'hard_bounce',
    source: 'import',
  });

  assert.deepEqual(result, { created: 1, updated: 1, total: 2 });
  assert.equal(store.entries.length, 2);
  assert.ok(store.entries.every(({ reason }) => reason === 'hard_bounce'));
});

test('removeSuppression soft-removes only manual entries', async () => {
  const store = suppressionStore([{ email: 'manual@example.com', reason: 'manual' }]);
  const removedAt = new Date('2026-08-12T10:00:00.000Z');
  const entry = await removeSuppression({
    prisma: store.prisma,
    userId: 'user-1',
    email: 'manual@example.com',
    now: removedAt,
  });
  assert.equal(entry.removed_at, removedAt);
});

test('removeSuppression protects compliance and provider entries', async () => {
  for (const reason of ['unsubscribed', 'hard_bounce', 'complaint']) {
    const store = suppressionStore([{ email: 'locked@example.com', reason }]);
    await assert.rejects(
      removeSuppression({
        prisma: store.prisma,
        userId: 'user-1',
        email: 'locked@example.com',
      }),
      (error) => error.code === 'SUPPRESSION_LOCKED'
        && error.status === 409
        && error.details.reason === reason,
    );
  }
});

test('getSuppressionDecision hides removed entries', async () => {
  const store = suppressionStore([
    { email: 'active@example.com', reason: 'manual' },
    { email: 'removed@example.com', reason: 'manual', removed_at: new Date() },
  ]);
  assert.equal((await getSuppressionDecision({
    prisma: store.prisma,
    userId: 'user-1',
    email: 'active@example.com',
  })).suppressed, true);
  assert.deepEqual(await getSuppressionDecision({
    prisma: store.prisma,
    userId: 'user-1',
    email: 'removed@example.com',
  }), { suppressed: false, entry: null });
});

test('listSuppressions builds paginated user-scoped results', async () => {
  const store = suppressionStore([
    { email: 'one@example.com', reason: 'manual' },
    { email: 'two@example.com', reason: 'complaint' },
  ]);
  const result = await listSuppressions({
    prisma: store.prisma,
    userId: 'user-1',
    query: { page: '1', limit: '1' },
  });
  assert.equal(result.pagination.total, 2);
  assert.equal(result.pagination.pages, 2);
});

test('suppressionSummary returns zeroes for reasons without entries', async () => {
  const store = suppressionStore([
    { email: 'one@example.com', reason: 'manual' },
    { email: 'two@example.com', reason: 'complaint' },
  ]);
  assert.deepEqual(await suppressionSummary({ prisma: store.prisma, userId: 'user-1' }), {
    active: 2,
    byReason: {
      manual: 1,
      unsubscribed: 0,
      hard_bounce: 0,
      complaint: 1,
    },
  });
});
