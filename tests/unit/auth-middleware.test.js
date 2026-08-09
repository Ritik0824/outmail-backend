import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { authenticateJWT, requireQueueAdmin } from '../../middleware/auth.js';
import { AUTH_COOKIE_NAME } from '../../utils/authToken.js';
import { setTestEnv } from '../helpers/env.js';

setTestEnv();

function buildApp(...middleware) {
  const app = express();
  app.use(cookieParser());
  app.get('/protected', ...middleware, (req, res) => {
    res.json({ user: req.user });
  });
  return app;
}

function sign(email = 'user@example.com') {
  return jwt.sign({ id: 'user-id', email }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

test('authenticateJWT rejects a missing credential', async () => {
  const response = await request(buildApp(authenticateJWT)).get('/protected');

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'Authentication required' });
});

test('authenticateJWT accepts a bearer token', async () => {
  const response = await request(buildApp(authenticateJWT))
    .get('/protected')
    .set('Authorization', `Bearer ${sign()}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.user.id, 'user-id');
});

test('authenticateJWT accepts the secure session cookie', async () => {
  const response = await request(buildApp(authenticateJWT))
    .get('/protected')
    .set('Cookie', `${AUTH_COOKIE_NAME}=${sign()}`);

  assert.equal(response.status, 200);
});

test('requireQueueAdmin denies an authenticated non-admin', async () => {
  const response = await request(buildApp(authenticateJWT, requireQueueAdmin))
    .get('/protected')
    .set('Authorization', `Bearer ${sign('user@example.com')}`);

  assert.equal(response.status, 403);
});

test('requireQueueAdmin accepts configured email case-insensitively', async () => {
  const response = await request(buildApp(authenticateJWT, requireQueueAdmin))
    .get('/protected')
    .set('Authorization', `Bearer ${sign('ADMIN@example.com')}`);

  assert.equal(response.status, 200);
});
