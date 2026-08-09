import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import request from 'supertest';
import { setTestEnv } from '../helpers/env.js';

setTestEnv({
  DATABASE_URL: process.env.TEST_DATABASE_URL
    || 'postgresql://outmail:outmail@localhost:5432/outmail?schema=outmail_test',
});

const prisma = (await import('../../prisma/prismaClient.js')).default;
const { createApp } = await import('../../app.js');
const { createAuthToken } = await import('../../utils/authToken.js');
const { decrypt } = await import('../../utils/encryption.js');
const { closeEmailQueue } = await import('../../queue/emailQueue.js');
const app = createApp({ enableQueueDashboard: false });

let user;
let otherUser;

before(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.suppressionEntry.deleteMany();
  await prisma.user.deleteMany();
  user = await prisma.user.create({
    data: {
      email: 'owner@example.com',
      display_name: 'Original Name',
      app_password_hash: '',
    },
  });
  otherUser = await prisma.user.create({
    data: {
      email: 'other@example.com',
      display_name: 'Other User',
      app_password_hash: '',
    },
  });
});

after(async () => {
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  await closeEmailQueue();
});

test('GET /api/auth/me returns only the authenticated user', async () => {
  const response = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${createAuthToken(user)}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.user.id, user.id);
  assert.equal(response.body.user.app_password_hash, undefined);
});

test('POST /api/auth/update-name updates the session and hides credentials', async () => {
  const response = await request(app)
    .post('/api/auth/update-name')
    .set('Authorization', `Bearer ${createAuthToken(user)}`)
    .send({ name: 'Updated Name' });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.display_name, 'Updated Name');
  assert.equal(response.body.user.app_password_hash, undefined);
  assert.match(response.headers['set-cookie'][0], /HttpOnly/);
  assert.match(response.headers['set-cookie'][0], /SameSite=Lax/);
});

test('POST /api/auth/login can update only the authenticated account', async () => {
  const response = await request(app)
    .post('/api/auth/login')
    .set('Authorization', `Bearer ${createAuthToken(user)}`)
    .send({
      email: otherUser.email,
      display_name: 'Authenticated Owner',
      app_password: 'generated-app-password',
    });

  assert.equal(response.status, 200);
  const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
  const unchangedOtherUser = await prisma.user.findUnique({ where: { id: otherUser.id } });
  assert.equal(decrypt(updatedUser.app_password_hash), 'generated-app-password');
  assert.equal(unchangedOtherUser.app_password_hash, '');
});

test('POST /api/auth/logout expires the session cookie', async () => {
  const response = await request(app).post('/api/auth/logout');

  assert.equal(response.status, 204);
  assert.match(response.headers['set-cookie'][0], /outmail_session=;/);
});
