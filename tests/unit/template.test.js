import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPlaceholders, fillPlaceholders } from '../../domain/template.js';

test('extractPlaceholders normalizes and deduplicates names across templates', () => {
  assert.deepEqual(
    extractPlaceholders('Hello {{ Name }} at {{company}}', '{{name}} / {{ Job-Title }}'),
    ['name', 'company', 'job-title'],
  );
});

test('fillPlaceholders matches keys case-insensitively', () => {
  assert.equal(
    fillPlaceholders('Hello {{ NAME }} from {{ company }}', { name: 'Asha', COMPANY: 'OutMail' }),
    'Hello Asha from OutMail',
  );
});

test('fillPlaceholders replaces missing and null values with an empty string', () => {
  assert.equal(fillPlaceholders('{{known}}/{{missing}}/{{nullable}}', {
    known: 42,
    nullable: null,
  }), '42//');
});
