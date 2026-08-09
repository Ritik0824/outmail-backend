import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRecipientRows,
  parseRecipientFile,
  RecipientImportError,
} from '../../services/recipientImport.js';

test('parseRecipientFile normalizes a CSV into ordered recipients', async () => {
  const result = await parseRecipientFile({
    buffer: Buffer.from('Email,Name,Company\n ASHA@example.com ,Asha,Acme\nben@example.com,Ben,Beta\n'),
    fileName: 'recipients.csv',
    requiredFields: ['name', 'company'],
  });

  assert.deepEqual(result.headers, ['email', 'name', 'company']);
  assert.deepEqual(result.recipients, [
    {
      email: 'asha@example.com',
      payload: { name: 'Asha', company: 'Acme', email: 'asha@example.com' },
      position: 0,
    },
    {
      email: 'ben@example.com',
      payload: { name: 'Ben', company: 'Beta', email: 'ben@example.com' },
      position: 1,
    },
  ]);
});

test('normalizeRecipientRows reports missing placeholder columns', () => {
  assert.throws(
    () => normalizeRecipientRows({
      headers: ['email', 'name'],
      rows: [['user@example.com', 'User']],
      requiredFields: ['company'],
    }),
    (error) => error instanceof RecipientImportError
      && error.code === 'MISSING_COLUMNS'
      && error.details.columns.includes('company'),
  );
});

test('normalizeRecipientRows rejects duplicate emails case-insensitively', () => {
  assert.throws(
    () => normalizeRecipientRows({
      headers: ['email'],
      rows: [['User@example.com'], ['user@example.com']],
    }),
    (error) => {
      assert.equal(error.code, 'DUPLICATE_EMAIL');
      assert.deepEqual(error.details.rows, [2, 3]);
      return true;
    },
  );
});

test('normalizeRecipientRows rejects blank and duplicate column names', () => {
  assert.throws(
    () => normalizeRecipientRows({
      headers: ['email', null],
      rows: [['user@example.com', 'value']],
    }),
    (error) => error.code === 'EMPTY_COLUMNS'
      && error.details.columns.includes(2),
  );

  assert.throws(
    () => normalizeRecipientRows({
      headers: ['Email', ' email '],
      rows: [['user@example.com', 'second@example.com']],
    }),
    (error) => error.code === 'DUPLICATE_COLUMNS'
      && error.details.columns.includes('email'),
  );
});

test('normalizeRecipientRows identifies the row containing an invalid email', () => {
  assert.throws(
    () => normalizeRecipientRows({
      headers: ['email'],
      rows: [['valid@example.com'], ['not-an-email']],
    }),
    (error) => error.code === 'INVALID_EMAIL' && error.details.row === 3,
  );
});

test('normalizeRecipientRows enforces the configured recipient limit', () => {
  assert.throws(
    () => normalizeRecipientRows({
      headers: ['email'],
      rows: [['one@example.com'], ['two@example.com']],
      maxRecipients: 1,
    }),
    (error) => error.code === 'TOO_MANY_RECIPIENTS' && error.details.maximum === 1,
  );
});

test('parseRecipientFile rejects unsupported file types', async () => {
  await assert.rejects(
    parseRecipientFile({ buffer: Buffer.from('data'), fileName: 'recipients.txt' }),
    (error) => error.code === 'UNSUPPORTED_FILE',
  );
});
