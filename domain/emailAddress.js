import { domainToASCII } from 'node:url';

export class EmailAddressError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EmailAddressError';
    this.code = code;
    this.details = details;
  }
}

function validateLocalPart(localPart) {
  if (!localPart || localPart.length > 64) return false;
  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart);
}

function validateDomain(asciiDomain) {
  if (!asciiDomain || asciiDomain.length > 253 || !asciiDomain.includes('.')) return false;
  const labels = asciiDomain.split('.');
  return labels.every((label) => (
    label.length >= 1
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
    && /^[a-z0-9-]+$/i.test(label)
  ));
}

export function normalizeEmailAddress(value) {
  if (typeof value !== 'string') {
    throw new EmailAddressError('EMAIL_REQUIRED', 'Email address is required');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) {
    throw new EmailAddressError('INVALID_EMAIL', 'Email address is invalid', { value: trimmed });
  }

  const separator = trimmed.lastIndexOf('@');
  if (separator <= 0 || separator !== trimmed.indexOf('@')) {
    throw new EmailAddressError('INVALID_EMAIL', 'Email address is invalid', { value: trimmed });
  }
  const localPart = trimmed.slice(0, separator).toLowerCase();
  const rawDomain = trimmed.slice(separator + 1).toLowerCase();
  const asciiDomain = domainToASCII(rawDomain);
  if (!validateLocalPart(localPart) || !validateDomain(asciiDomain)) {
    throw new EmailAddressError('INVALID_EMAIL', 'Email address is invalid', { value: trimmed });
  }
  return `${localPart}@${asciiDomain}`;
}

export function emailDomain(value) {
  return normalizeEmailAddress(value).split('@')[1];
}

export function sameEmailAddress(left, right) {
  try {
    return normalizeEmailAddress(left) === normalizeEmailAddress(right);
  } catch {
    return false;
  }
}

export function normalizeEmailList(values, { maximum = 5_000 } = {}) {
  if (!Array.isArray(values)) {
    throw new EmailAddressError('EMAIL_LIST_REQUIRED', 'An array of email addresses is required');
  }
  if (values.length > maximum) {
    throw new EmailAddressError(
      'TOO_MANY_EMAILS',
      `At most ${maximum} email addresses can be submitted at once`,
      { maximum, received: values.length },
    );
  }

  const normalized = [];
  const seen = new Set();
  const invalid = [];
  for (const [index, value] of values.entries()) {
    try {
      const email = normalizeEmailAddress(value);
      if (!seen.has(email)) {
        seen.add(email);
        normalized.push(email);
      }
    } catch {
      invalid.push({ index, value });
    }
  }
  if (invalid.length) {
    throw new EmailAddressError(
      'INVALID_EMAIL_LIST',
      'One or more email addresses are invalid',
      { invalid },
    );
  }
  return normalized;
}
