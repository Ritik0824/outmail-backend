import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import request from 'supertest';
import { setTestEnv } from '../helpers/env.js';
import { signDeliveryWebhook } from '../../domain/deliveryWebhook.js';

setTestEnv();
const { createApp } = await import('../../app.js');
const { closeEmailQueue } = await import('../../queue/emailQueue.js');
const app = createApp({ enableQueueDashboard: false });

after(async () => {
  await closeEmailQueue();
});

test('liveness endpoint is available without dependencies', async () => {
  const response = await request(app).get('/health/live');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('responses include security headers and suppress framework identity', async () => {
  const response = await request(app).get('/health/live');

  assert.ok(response.headers['content-security-policy']);
  assert.equal(response.headers['x-powered-by'], undefined);
});

test('CORS permits configured browser origins', async () => {
  const response = await request(app)
    .get('/health/live')
    .set('Origin', 'http://localhost:8080');

  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:8080');
});

test('CORS rejects an unconfigured browser origin', async () => {
  const response = await request(app)
    .get('/health/live')
    .set('Origin', 'https://attacker.example');

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: 'Origin is not allowed' });
});

test('authentication endpoints do not accept anonymous credential updates', async () => {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: 'victim@example.com', app_password: 'attempted-overwrite' });

  assert.equal(response.status, 401);
});

test('campaign delivery details and recovery require authentication', async () => {
  const details = await request(app).get('/api/campaigns/campaign-1/recipients');
  const recovery = await request(app).post('/api/campaigns/campaign-1/requeue');

  assert.equal(details.status, 401);
  assert.equal(recovery.status, 401);
});

test('campaign lifecycle and event history require authentication', async () => {
  const responses = await Promise.all([
    request(app).post('/api/campaigns/campaign-1/pause'),
    request(app).post('/api/campaigns/campaign-1/resume'),
    request(app).post('/api/campaigns/campaign-1/cancel'),
    request(app).get('/api/campaigns/campaign-1/events'),
  ]);

  assert.deepEqual(responses.map(({ status }) => status), [401, 401, 401, 401]);
});

test('suppression management requires authentication', async () => {
  const responses = await Promise.all([
    request(app).get('/api/suppressions'),
    request(app).get('/api/suppressions/summary'),
    request(app).get('/api/suppressions/check?email=user@example.com'),
    request(app).post('/api/suppressions').send({ email: 'user@example.com' }),
    request(app).post('/api/suppressions/batch').send({ emails: ['user@example.com'] }),
    request(app).delete('/api/suppressions/user%40example.com'),
  ]);

  assert.ok(responses.every(({ status }) => status === 401));
});

test('public unsubscribe endpoints reject invalid tokens without caching', async () => {
  const preview = await request(app).get('/api/unsubscribe/not-a-valid-token');
  const confirmation = await request(app).post('/api/unsubscribe/not-a-valid-token');

  assert.equal(preview.status, 400);
  assert.equal(confirmation.status, 400);
  assert.equal(preview.body.code, 'MALFORMED_UNSUBSCRIBE_TOKEN');
  assert.match(preview.headers['cache-control'], /no-store/);
});

test('delivery webhooks require a current valid signature', async () => {
  const response = await request(app)
    .post('/api/webhooks/delivery')
    .set('Content-Type', 'application/json')
    .set('x-outmail-timestamp', String(Math.floor(Date.now() / 1_000)))
    .set('x-outmail-signature', `v1=${'0'.repeat(64)}`)
    .send('{"eventId":"event-1"}');

  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'INVALID_WEBHOOK_SIGNATURE');
  assert.match(response.headers['cache-control'], /no-store/);
});

test('delivery webhooks reject malformed JSON after signature verification', async () => {
  const rawBody = '{not-json';
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = signDeliveryWebhook({
    secret: process.env.DELIVERY_WEBHOOK_SECRET,
    timestamp,
    rawBody,
  });
  const response = await request(app)
    .post('/api/webhooks/delivery')
    .set('Content-Type', 'application/json')
    .set('x-outmail-timestamp', String(timestamp))
    .set('x-outmail-signature', signature)
    .send(rawBody);

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'INVALID_WEBHOOK_JSON');
});

test('campaign analytics endpoints require authentication', async () => {
  const responses = await Promise.all([
    request(app).get('/api/analytics/overview'),
    request(app).get('/api/analytics/trends'),
    request(app).get('/api/analytics/campaigns/campaign-1'),
  ]);

  assert.deepEqual(responses.map(({ status }) => status), [401, 401, 401]);
});
