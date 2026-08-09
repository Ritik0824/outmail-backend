import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHealthReport,
  collectDependencyHealth,
  evaluateReadiness,
  HEALTH_STATUS,
  publicHealthReport,
  timedCheck,
  withTimeout,
} from '../../services/healthService.js';

test('withTimeout resolves a dependency before the deadline', async () => {
  assert.equal(await withTimeout(async () => 'ready', 50, 'fast'), 'ready');
});

test('withTimeout rejects a dependency after the deadline', async () => {
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), 5, 'stuck'),
    (error) => error.code === 'HEALTH_CHECK_TIMEOUT' && error.details.name === 'stuck',
  );
});

test('timedCheck converts dependency errors into structured results', async () => {
  let elapsed = 0;
  const result = await timedCheck(
    'database',
    async () => { throw new Error('connection refused'); },
    { now: () => { elapsed += 2; return elapsed; } },
  );
  assert.equal(result.status, HEALTH_STATUS.UNHEALTHY);
  assert.equal(result.critical, true);
  assert.equal(result.latencyMs, 2);
  assert.equal(result.error, 'connection refused');
});

test('evaluateReadiness distinguishes critical and optional failures', () => {
  const healthy = { name: 'database', critical: true, status: HEALTH_STATUS.HEALTHY };
  const optionalFailure = { name: 'worker', critical: false, status: HEALTH_STATUS.UNHEALTHY };
  const criticalFailure = { name: 'queue', critical: true, status: HEALTH_STATUS.UNHEALTHY };

  assert.deepEqual(evaluateReadiness([healthy]), {
    status: HEALTH_STATUS.HEALTHY,
    ready: true,
    failedChecks: [],
  });
  assert.equal(evaluateReadiness([healthy, optionalFailure]).status, HEALTH_STATUS.DEGRADED);
  assert.equal(evaluateReadiness([criticalFailure]).ready, false);
});

test('collectDependencyHealth reports database, queue, and worker state', async () => {
  const prisma = { $queryRaw: async () => [{ value: 1 }] };
  const queue = {
    getJobCounts: async () => ({ waiting: 2, active: 1 }),
    isPaused: async () => false,
    getWorkers: async () => [{ id: 'worker-1' }],
  };
  const report = await collectDependencyHealth({ prisma, queue });
  assert.equal(report.status, HEALTH_STATUS.HEALTHY);
  assert.equal(report.checks[1].details.counts.waiting, 2);
  assert.equal(report.checks[2].details.workers, 1);
});

test('collectDependencyHealth marks an unavailable queue as critical', async () => {
  const prisma = { $queryRaw: async () => [{ value: 1 }] };
  const queue = {
    getJobCounts: async () => { throw new Error('redis offline'); },
    getWorkers: async () => [],
  };
  const report = await collectDependencyHealth({ prisma, queue });
  assert.equal(report.status, HEALTH_STATUS.UNHEALTHY);
  assert.equal(report.ready, false);
  assert.deepEqual(report.failedChecks, ['delivery_queue']);
});

test('publicHealthReport removes internal dependency details', () => {
  const report = publicHealthReport({
    status: 'healthy',
    ready: true,
    checkedAt: '2026-08-09T12:00:00.000Z',
    checks: [{ name: 'database', status: 'healthy', latencyMs: 2, details: { secret: true } }],
  });
  assert.deepEqual(report.checks[0], { name: 'database', status: 'healthy', latencyMs: 2 });
});

test('buildHealthReport can omit runtime details for public readiness', async () => {
  const report = await buildHealthReport({
    prisma: { $queryRaw: async () => [] },
    queue: {
      getJobCounts: async () => ({}),
      isPaused: async () => false,
      getWorkers: async () => [{ id: 'worker-1' }],
    },
    includeRuntime: false,
    now: new Date('2026-08-09T12:00:00.000Z'),
  });
  assert.equal(report.checkedAt, '2026-08-09T12:00:00.000Z');
  assert.equal(Object.hasOwn(report, 'runtime'), false);
  assert.equal(report.status, HEALTH_STATUS.HEALTHY);
});
