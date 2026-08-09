import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanupIsComplete,
  inspectRecipientJobs,
  JOB_CONTROL_OUTCOME,
  removeRecipientJobs,
} from '../../services/queueJobControl.js';

function fakeJob(state, overrides = {}) {
  return {
    attemptsMade: 1,
    processedOn: 100,
    finishedOn: null,
    failedReason: null,
    getState: async () => state,
    remove: async () => {},
    ...overrides,
  };
}

test('removeRecipientJobs removes delayed and waiting jobs', async () => {
  const removed = [];
  const queue = {
    getJob: async (jobId) => fakeJob(jobId === 'job-1' ? 'delayed' : 'waiting', {
      remove: async () => { removed.push(jobId); },
    }),
  };

  const summary = await removeRecipientJobs({ queue, jobIds: ['job-1', 'job-2'] });

  assert.deepEqual(removed.sort(), ['job-1', 'job-2']);
  assert.equal(summary.requested, 2);
  assert.equal(summary.removed, 2);
  assert.equal(summary.active, 0);
  assert.equal(cleanupIsComplete(summary), true);
});

test('removeRecipientJobs reports missing jobs as already clean', async () => {
  const summary = await removeRecipientJobs({
    queue: { getJob: async () => null },
    jobIds: ['missing-job'],
  });

  assert.equal(summary.missing, 1);
  assert.equal(summary.results[0].previousState, null);
  assert.equal(cleanupIsComplete(summary), true);
});

test('removeRecipientJobs does not attempt to remove an active job', async () => {
  let removeCalled = false;
  const summary = await removeRecipientJobs({
    queue: {
      getJob: async () => fakeJob('active', {
        remove: async () => { removeCalled = true; },
      }),
    },
    jobIds: ['active-job'],
  });

  assert.equal(removeCalled, false);
  assert.equal(summary.active, 1);
  assert.equal(summary.results[0].outcome, JOB_CONTROL_OUTCOME.ACTIVE);
  assert.equal(cleanupIsComplete(summary), false);
});

test('removeRecipientJobs captures queue and removal failures per job', async () => {
  const queue = {
    getJob: async (jobId) => {
      if (jobId === 'lookup-error') throw new Error('redis unavailable');
      return fakeJob('delayed', {
        remove: async () => { throw new Error('locked job'); },
      });
    },
  };

  const summary = await removeRecipientJobs({
    queue,
    jobIds: ['lookup-error', 'remove-error'],
  });

  assert.equal(summary.failed, 2);
  assert.match(summary.results[0].error, /redis unavailable/);
  assert.match(summary.results[1].error, /locked job/);
  assert.equal(cleanupIsComplete(summary), false);
});

test('removeRecipientJobs ignores blank and duplicate IDs', async () => {
  let lookups = 0;
  const summary = await removeRecipientJobs({
    queue: {
      getJob: async () => {
        lookups += 1;
        return null;
      },
    },
    jobIds: ['job-1', '', null, 'job-1', 'job-2'],
  });

  assert.equal(lookups, 2);
  assert.equal(summary.requested, 2);
});

test('removeRecipientJobs honors a concurrency ceiling', async () => {
  let active = 0;
  let maximumActive = 0;
  const queue = {
    getJob: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return null;
    },
  };

  await removeRecipientJobs({
    queue,
    jobIds: ['1', '2', '3', '4', '5'],
    concurrency: 2,
  });

  assert.equal(maximumActive, 2);
});

test('inspectRecipientJobs returns observable BullMQ state', async () => {
  const queue = {
    getJob: async (jobId) => jobId === 'missing'
      ? null
      : fakeJob('completed', { finishedOn: 250 }),
  };

  const states = await inspectRecipientJobs({
    queue,
    jobIds: ['completed', 'missing'],
  });

  assert.deepEqual(states[0], {
    jobId: 'completed',
    exists: true,
    state: 'completed',
    attemptsMade: 1,
    processedOn: 100,
    finishedOn: 250,
    failedReason: null,
  });
  assert.deepEqual(states[1], {
    jobId: 'missing',
    exists: false,
    state: 'missing',
  });
});

test('inspectRecipientJobs reports unknown when Redis inspection fails', async () => {
  const states = await inspectRecipientJobs({
    queue: { getJob: async () => { throw new Error('connection closed'); } },
    jobIds: ['job-1'],
  });

  assert.equal(states[0].exists, null);
  assert.equal(states[0].state, 'unknown');
  assert.match(states[0].error, /connection closed/);
});
