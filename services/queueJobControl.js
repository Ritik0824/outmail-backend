const DEFAULT_CONCURRENCY = 25;

export const JOB_CONTROL_OUTCOME = Object.freeze({
  REMOVED: 'removed',
  MISSING: 'missing',
  ACTIVE: 'active',
  FAILED: 'failed',
});

function uniqueJobIds(jobIds) {
  if (!Array.isArray(jobIds)) return [];
  return [...new Set(jobIds.filter((jobId) => typeof jobId === 'string' && jobId.trim()))];
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function summarize(results) {
  const summary = {
    requested: results.length,
    removed: 0,
    missing: 0,
    active: 0,
    failed: 0,
    results,
  };
  for (const result of results) {
    summary[result.outcome] += 1;
  }
  return summary;
}

async function removeJob(queue, jobId) {
  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return { jobId, outcome: JOB_CONTROL_OUTCOME.MISSING, previousState: null };
    }

    const previousState = await job.getState();
    if (previousState === 'active') {
      return { jobId, outcome: JOB_CONTROL_OUTCOME.ACTIVE, previousState };
    }

    await job.remove();
    return { jobId, outcome: JOB_CONTROL_OUTCOME.REMOVED, previousState };
  } catch (error) {
    return {
      jobId,
      outcome: JOB_CONTROL_OUTCOME.FAILED,
      previousState: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function removeRecipientJobs({
  queue,
  jobIds,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const normalized = uniqueJobIds(jobIds);
  if (!normalized.length) return summarize([]);
  const results = await mapWithConcurrency(
    normalized,
    concurrency,
    (jobId) => removeJob(queue, jobId),
  );
  return summarize(results);
}

async function inspectJob(queue, jobId) {
  try {
    const job = await queue.getJob(jobId);
    if (!job) return { jobId, exists: false, state: 'missing' };
    return {
      jobId,
      exists: true,
      state: await job.getState(),
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn || null,
      finishedOn: job.finishedOn || null,
      failedReason: job.failedReason || null,
    };
  } catch (error) {
    return {
      jobId,
      exists: null,
      state: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inspectRecipientJobs({
  queue,
  jobIds,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const normalized = uniqueJobIds(jobIds);
  return mapWithConcurrency(
    normalized,
    concurrency,
    (jobId) => inspectJob(queue, jobId),
  );
}

export function cleanupIsComplete(summary) {
  return summary.active === 0 && summary.failed === 0;
}
