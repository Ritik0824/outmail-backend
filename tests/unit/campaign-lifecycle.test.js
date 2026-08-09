import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMPAIGN_ACTION,
  CAMPAIGN_STATUS,
  campaignProgressStatus,
  campaignTransition,
  CampaignTransitionError,
  isTerminalCampaignStatus,
  recipientStatusForCampaignAction,
} from '../../domain/campaignLifecycle.js';

const NOW = new Date('2026-08-11T10:00:00.000Z');

test('scheduled and running campaigns can be paused', () => {
  for (const status of [CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.RUNNING]) {
    assert.deepEqual(campaignTransition({ status, action: CAMPAIGN_ACTION.PAUSE, now: NOW }), {
      status: CAMPAIGN_STATUS.PAUSED,
      paused_at: NOW,
    });
  }
});

test('queue failure states can be paused before recovery', () => {
  for (const status of [CAMPAIGN_STATUS.QUEUE_FAILED, CAMPAIGN_STATUS.QUEUE_STATE_UNKNOWN]) {
    assert.equal(
      campaignTransition({ status, action: CAMPAIGN_ACTION.PAUSE, now: NOW }).status,
      CAMPAIGN_STATUS.PAUSED,
    );
  }
});

test('a campaign that never started resumes to scheduled', () => {
  assert.deepEqual(campaignTransition({
    status: CAMPAIGN_STATUS.PAUSED,
    action: CAMPAIGN_ACTION.RESUME,
    startedAt: null,
    now: NOW,
  }), {
    status: CAMPAIGN_STATUS.SCHEDULED,
    paused_at: null,
  });
});

test('a campaign with prior activity resumes to running', () => {
  assert.equal(campaignTransition({
    status: CAMPAIGN_STATUS.PAUSED,
    action: CAMPAIGN_ACTION.RESUME,
    startedAt: new Date('2026-08-11T09:00:00.000Z'),
    now: NOW,
  }).status, CAMPAIGN_STATUS.RUNNING);
});

test('cancelling records the timestamp and clears a pause', () => {
  assert.deepEqual(campaignTransition({
    status: CAMPAIGN_STATUS.PAUSED,
    action: CAMPAIGN_ACTION.CANCEL,
    now: NOW,
  }), {
    status: CAMPAIGN_STATUS.CANCELLED,
    cancelled_at: NOW,
    paused_at: null,
  });
});

test('completed and cancelled campaigns are terminal', () => {
  assert.equal(isTerminalCampaignStatus(CAMPAIGN_STATUS.COMPLETED), true);
  assert.equal(isTerminalCampaignStatus(CAMPAIGN_STATUS.CANCELLED), true);
  assert.equal(isTerminalCampaignStatus(CAMPAIGN_STATUS.RUNNING), false);
});

test('terminal campaigns reject lifecycle actions', () => {
  for (const status of [CAMPAIGN_STATUS.COMPLETED, CAMPAIGN_STATUS.CANCELLED]) {
    for (const action of Object.values(CAMPAIGN_ACTION)) {
      assert.throws(
        () => campaignTransition({ status, action, now: NOW }),
        (error) => error instanceof CampaignTransitionError
          && error.code === 'CAMPAIGN_TRANSITION_NOT_ALLOWED'
          && error.details.status === status,
      );
    }
  }
});

test('resume is accepted only from paused', () => {
  assert.throws(
    () => campaignTransition({
      status: CAMPAIGN_STATUS.SCHEDULED,
      action: CAMPAIGN_ACTION.RESUME,
      now: NOW,
    }),
    /Cannot resume/,
  );
});

test('unknown actions produce a client input error', () => {
  assert.throws(
    () => campaignTransition({ status: CAMPAIGN_STATUS.SCHEDULED, action: 'restart' }),
    (error) => error.code === 'UNKNOWN_CAMPAIGN_ACTION' && error.status === 400,
  );
});

test('progress completes when all recipients have terminal outcomes', () => {
  assert.equal(campaignProgressStatus({
    totalEmails: 5,
    sentEmails: 3,
    failedEmails: 1,
    cancelledEmails: 1,
    currentStatus: CAMPAIGN_STATUS.RUNNING,
  }), CAMPAIGN_STATUS.COMPLETED);
});

test('progress remains running while delivery outcomes are incomplete', () => {
  assert.equal(campaignProgressStatus({
    totalEmails: 5,
    sentEmails: 1,
    failedEmails: 0,
    currentStatus: CAMPAIGN_STATUS.SCHEDULED,
  }), CAMPAIGN_STATUS.RUNNING);
});

test('progress preserves paused and terminal states', () => {
  assert.equal(campaignProgressStatus({
    totalEmails: 1,
    sentEmails: 1,
    failedEmails: 0,
    currentStatus: CAMPAIGN_STATUS.PAUSED,
  }), CAMPAIGN_STATUS.PAUSED);
  assert.equal(campaignProgressStatus({
    totalEmails: 2,
    sentEmails: 0,
    failedEmails: 0,
    currentStatus: CAMPAIGN_STATUS.CANCELLED,
  }), CAMPAIGN_STATUS.CANCELLED);
});

test('lifecycle actions map to recipient queue states', () => {
  assert.equal(recipientStatusForCampaignAction(CAMPAIGN_ACTION.PAUSE), 'paused');
  assert.equal(recipientStatusForCampaignAction(CAMPAIGN_ACTION.RESUME), 'queued');
  assert.equal(recipientStatusForCampaignAction(CAMPAIGN_ACTION.CANCEL), 'cancelled');
});
