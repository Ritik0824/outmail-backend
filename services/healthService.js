import os from 'node:os';

export const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
});

export class HealthCheckError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HealthCheckError';
    this.code = code;
    this.details = details;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function withTimeout(operation, timeoutMs, name = 'operation') {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new HealthCheckError('INVALID_HEALTH_TIMEOUT', 'timeoutMs must be positive');
  }
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new HealthCheckError(
            'HEALTH_CHECK_TIMEOUT',
            `${name} did not respond within ${timeoutMs}ms`,
            { name, timeoutMs },
          ));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function timedCheck(name, operation, {
  timeoutMs = 2_000,
  critical = true,
  now = () => performance.now(),
} = {}) {
  const startedAt = now();
  try {
    const details = await withTimeout(operation, timeoutMs, name);
    return {
      name,
      status: HEALTH_STATUS.HEALTHY,
      critical,
      latencyMs: Number((now() - startedAt).toFixed(2)),
      details: details ?? {},
    };
  } catch (error) {
    return {
      name,
      status: HEALTH_STATUS.UNHEALTHY,
      critical,
      latencyMs: Number((now() - startedAt).toFixed(2)),
      error: errorMessage(error),
      code: error.code ?? 'HEALTH_CHECK_FAILED',
    };
  }
}

export function evaluateReadiness(checks) {
  const failedCritical = checks.filter(
    (check) => check.critical && check.status === HEALTH_STATUS.UNHEALTHY,
  );
  const failedOptional = checks.filter(
    (check) => !check.critical && check.status === HEALTH_STATUS.UNHEALTHY,
  );
  if (failedCritical.length) {
    return {
      status: HEALTH_STATUS.UNHEALTHY,
      ready: false,
      failedChecks: failedCritical.map(({ name }) => name),
    };
  }
  if (failedOptional.length) {
    return {
      status: HEALTH_STATUS.DEGRADED,
      ready: true,
      failedChecks: failedOptional.map(({ name }) => name),
    };
  }
  return { status: HEALTH_STATUS.HEALTHY, ready: true, failedChecks: [] };
}

export function runtimeSnapshot({ processObject = process, osModule = os } = {}) {
  const memory = processObject.memoryUsage();
  return {
    nodeVersion: processObject.version,
    processId: processObject.pid,
    uptimeSeconds: Math.floor(processObject.uptime()),
    memory: {
      residentBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    },
    host: {
      platform: osModule.platform(),
      release: osModule.release(),
      uptimeSeconds: Math.floor(osModule.uptime()),
      loadAverage: osModule.loadavg().map((value) => Number(value.toFixed(2))),
      freeMemoryBytes: osModule.freemem(),
      totalMemoryBytes: osModule.totalmem(),
    },
  };
}

async function databaseProbe(prisma) {
  await prisma.$queryRaw`SELECT 1`;
  return { connected: true };
}

async function queueProbe(queue) {
  const counts = await queue.getJobCounts(
    'active',
    'waiting',
    'delayed',
    'failed',
    'completed',
    'paused',
  );
  return {
    connected: true,
    counts,
    paused: await queue.isPaused(),
  };
}

async function workerProbe(queue) {
  const workers = await queue.getWorkers();
  if (!workers.length) {
    throw new HealthCheckError(
      'NO_DELIVERY_WORKERS',
      'No delivery workers are registered with the queue',
    );
  }
  return {
    workers: workers.length,
    available: workers.length > 0,
  };
}

export async function collectDependencyHealth({
  prisma,
  queue,
  timeoutMs = 2_000,
  includeWorkerCheck = true,
}) {
  if (!prisma || !queue) {
    throw new HealthCheckError(
      'HEALTH_DEPENDENCIES_REQUIRED',
      'Both Prisma and the delivery queue are required for readiness checks',
    );
  }
  const pendingChecks = [
    timedCheck('database', () => databaseProbe(prisma), { timeoutMs, critical: true }),
    timedCheck('delivery_queue', () => queueProbe(queue), { timeoutMs, critical: true }),
  ];
  if (includeWorkerCheck) {
    pendingChecks.push(
      timedCheck('delivery_worker', () => workerProbe(queue), { timeoutMs, critical: false }),
    );
  }
  const checks = await Promise.all(pendingChecks);
  const readiness = evaluateReadiness(checks);
  return { ...readiness, checks };
}

export function publicHealthReport(report) {
  return {
    status: report.status,
    ready: report.ready,
    checkedAt: report.checkedAt,
    checks: report.checks.map(({ name, status, latencyMs }) => ({ name, status, latencyMs })),
  };
}

export async function buildHealthReport({
  prisma,
  queue,
  timeoutMs,
  includeRuntime = true,
  now = new Date(),
}) {
  const dependencyHealth = await collectDependencyHealth({ prisma, queue, timeoutMs });
  return {
    service: 'outmail-backend',
    version: process.env.npm_package_version ?? 'unknown',
    environment: process.env.NODE_ENV ?? 'development',
    checkedAt: now.toISOString(),
    ...dependencyHealth,
    ...(includeRuntime ? { runtime: runtimeSnapshot() } : {}),
  };
}
