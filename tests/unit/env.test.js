import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../config/env.js';
import { setTestEnv } from '../helpers/env.js';

test('loadConfig normalizes origins and queue administrators', () => {
  setTestEnv();
  const config = loadConfig({
    ...process.env,
    APP_ORIGINS: 'https://app.example.com, https://admin.example.com ',
    QUEUE_ADMIN_EMAILS: 'ADMIN@example.com, ops@example.com',
  });

  assert.deepEqual(config.allowedOrigins, [
    'https://app.example.com',
    'https://admin.example.com',
  ]);
  assert.deepEqual(config.queueAdminEmails, ['admin@example.com', 'ops@example.com']);
});

test('loadConfig applies safe development defaults', () => {
  setTestEnv();
  const env = { ...process.env };
  delete env.PORT;
  delete env.REDIS_URL;
  delete env.APP_ORIGINS;

  const config = loadConfig(env);

  assert.equal(config.port, 3000);
  assert.equal(config.redisUrl, 'redis://localhost:6379');
  assert.deepEqual(config.allowedOrigins, ['http://localhost:8080']);
});

test('loadConfig reports all invalid required settings together', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'invalid', JWT_SECRET: 'short' }),
    (error) => {
      assert.match(error.message, /NODE_ENV/);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /JWT_SECRET/);
      assert.match(error.message, /SECRET_KEY/);
      return true;
    },
  );
});
