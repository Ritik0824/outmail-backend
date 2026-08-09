import { Readable } from 'node:stream';
import path from 'node:path';
import csvParser from 'csv-parser';
import Joi from 'joi';
import readXlsxFile from 'read-excel-file/node';
import { normalizePlaceholderName } from '../domain/template.js';

export const DEFAULT_MAX_RECIPIENTS = 5_000;

const emailSchema = Joi.string().email({ tlds: { allow: false } }).required();

export class RecipientImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecipientImportError';
    this.code = code;
    this.details = details;
  }
}

function cellValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function normalizeHeaders(headers) {
  const normalized = headers.map(normalizePlaceholderName);
  const emptyColumns = normalized
    .map((header, index) => ({ header, column: index + 1 }))
    .filter(({ header }) => !header)
    .map(({ column }) => column);
  if (emptyColumns.length) {
    throw new RecipientImportError(
      'EMPTY_COLUMNS',
      `Column names are required at positions: ${emptyColumns.join(', ')}`,
      { columns: emptyColumns },
    );
  }

  const duplicateHeaders = normalized.filter((header, index) => normalized.indexOf(header) !== index);
  if (duplicateHeaders.length) {
    const duplicates = [...new Set(duplicateHeaders)];
    throw new RecipientImportError(
      'DUPLICATE_COLUMNS',
      `Duplicate columns are not allowed: ${duplicates.join(', ')}`,
      { columns: duplicates },
    );
  }

  return normalized;
}

function validateRequiredHeaders(headers, requiredFields) {
  const required = [...new Set([...requiredFields, 'email'].map(normalizePlaceholderName))];
  const missing = required.filter((field) => !headers.includes(field));
  if (missing.length) {
    throw new RecipientImportError(
      'MISSING_COLUMNS',
      `Missing required columns: ${missing.join(', ')}`,
      { columns: missing },
    );
  }
  return required;
}

export function normalizeRecipientRows({
  headers,
  rows,
  requiredFields = [],
  firstDataRow = 2,
  maxRecipients = DEFAULT_MAX_RECIPIENTS,
}) {
  const normalizedHeaders = normalizeHeaders(headers);
  const required = validateRequiredHeaders(normalizedHeaders, requiredFields);
  const seenEmails = new Map();
  const recipients = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = firstDataRow + index;
    const values = Array.isArray(row)
      ? row.map(cellValue)
      : normalizedHeaders.map((header) => cellValue(row[header]));

    if (values.every((value) => value === '')) continue;

    const completePayload = Object.fromEntries(
      normalizedHeaders.map((header, columnIndex) => [header, values[columnIndex] ?? '']),
    );
    const email = completePayload.email.toLowerCase();
    const { error: emailError } = emailSchema.validate(email);
    if (emailError) {
      throw new RecipientImportError(
        'INVALID_EMAIL',
        `Invalid email address at row ${rowNumber}`,
        { row: rowNumber, value: completePayload.email },
      );
    }

    const firstSeenAt = seenEmails.get(email);
    if (firstSeenAt) {
      throw new RecipientImportError(
        'DUPLICATE_EMAIL',
        `Duplicate email address at rows ${firstSeenAt} and ${rowNumber}`,
        { email, rows: [firstSeenAt, rowNumber] },
      );
    }
    seenEmails.set(email, rowNumber);

    if (recipients.length >= maxRecipients) {
      throw new RecipientImportError(
        'TOO_MANY_RECIPIENTS',
        `A campaign can contain at most ${maxRecipients} recipients`,
        { maximum: maxRecipients },
      );
    }

    const payload = Object.fromEntries(required.map((field) => [field, completePayload[field]]));
    payload.email = email;
    recipients.push({
      email,
      payload,
      position: recipients.length,
    });
  }

  if (!recipients.length) {
    throw new RecipientImportError('EMPTY_FILE', 'The recipient file contains no data rows');
  }

  return { headers: normalizedHeaders, recipients };
}

async function readCsv(buffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = [];
    Readable.from([buffer])
      .pipe(csvParser({ mapHeaders: ({ header }) => normalizePlaceholderName(header) }))
      .on('headers', (value) => { headers = value; })
      .on('data', (row) => { rows.push(row); })
      .on('end', () => resolve({ headers, rows }))
      .on('error', reject);
  });
}

export async function parseRecipientFile({
  buffer,
  fileName,
  requiredFields = [],
  maxRecipients = DEFAULT_MAX_RECIPIENTS,
}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new RecipientImportError('EMPTY_FILE', 'The recipient file is empty');
  }

  const extension = path.extname(fileName).toLowerCase();
  let table;
  if (extension === '.csv') {
    table = await readCsv(buffer);
  } else if (extension === '.xlsx') {
    const [headers = [], ...rows] = await readXlsxFile(buffer);
    table = { headers, rows };
  } else {
    throw new RecipientImportError(
      'UNSUPPORTED_FILE',
      'Only .csv and .xlsx recipient files are supported',
    );
  }

  return normalizeRecipientRows({
    ...table,
    requiredFields,
    maxRecipients,
  });
}
