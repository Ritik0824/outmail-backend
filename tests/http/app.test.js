import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import request from 'supertest';
import { setTestEnv } from '../helpers/env.js';

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
