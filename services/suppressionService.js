import {
  normalizeEmailAddress,
  normalizeEmailList,
  EmailAddressError,
} from '../domain/emailAddress.js';
import {
  assertSuppressionReason,
  assertSuppressionSource,
  canRemoveSuppression,
  strongerSuppressionReason,
  SUPPRESSION_REASON,
  SUPPRESSION_SOURCE,
} from '../domain/suppression.js';

export class SuppressionServiceError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'SuppressionServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function mapDomainError(error) {
  if (error instanceof EmailAddressError) {
    return new SuppressionServiceError(error.code, error.message, { details: error.details });
  }
  if (error?.name === 'SuppressionRuleError') {
    return new SuppressionServiceError(error.code, error.message, { details: error.details });
  }
  return error;
}

function normalizedDetails(details) {
  if (details == null) return {};
  if (typeof details !== 'object' || Array.isArray(details)) {
    throw new SuppressionServiceError(
      'INVALID_SUPPRESSION_DETAILS',
      'Suppression details must be an object',
    );
  }
  return details;
}

function resolveSuppression(existing, incoming) {
  const reason = strongerSuppressionReason(existing?.reason, incoming.reason);
  const incomingWins = !existing || reason === incoming.reason;
  return {
    email: incoming.email,
    reason,
    source: incomingWins ? incoming.source : existing.source,
    details: incomingWins ? incoming.details : existing.details,
    removed_at: null,
  };
}

export async function addSuppression({
  prisma,
  userId,
  email,
  reason = SUPPRESSION_REASON.MANUAL,
  source = SUPPRESSION_SOURCE.DASHBOARD,
  details = {},
}) {
  try {
    const normalizedEmail = normalizeEmailAddress(email);
    assertSuppressionReason(reason);
    assertSuppressionSource(source);
    const safeDetails = normalizedDetails(details);

    return prisma.$transaction(async (transaction) => {
      const existing = await transaction.suppressionEntry.findUnique({
        where: { user_id_email: { user_id: userId, email: normalizedEmail } },
      });
      const resolved = resolveSuppression(existing, {
        email: normalizedEmail,
        reason,
        source,
        details: safeDetails,
      });
      return transaction.suppressionEntry.upsert({
        where: { user_id_email: { user_id: userId, email: normalizedEmail } },
        create: { user_id: userId, ...resolved },
        update: resolved,
      });
    });
  } catch (error) {
    throw mapDomainError(error);
  }
}

export async function addSuppressionBatch({
  prisma,
  userId,
  emails,
  reason = SUPPRESSION_REASON.MANUAL,
  source = SUPPRESSION_SOURCE.IMPORT,
  details = {},
}) {
  try {
    const normalizedEmails = normalizeEmailList(emails);
    assertSuppressionReason(reason);
    assertSuppressionSource(source);
    const safeDetails = normalizedDetails(details);
    if (!normalizedEmails.length) return { created: 0, updated: 0, total: 0 };

    const existingEntries = await prisma.suppressionEntry.findMany({
      where: { user_id: userId, email: { in: normalizedEmails } },
    });
    const existingByEmail = new Map(existingEntries.map((entry) => [entry.email, entry]));
    const operations = normalizedEmails.map((email) => {
      const existing = existingByEmail.get(email);
      const resolved = resolveSuppression(existing, {
        email,
        reason,
        source,
        details: safeDetails,
      });
      return prisma.suppressionEntry.upsert({
        where: { user_id_email: { user_id: userId, email } },
        create: { user_id: userId, ...resolved },
        update: resolved,
      });
    });
    await prisma.$transaction(operations);
    return {
      created: normalizedEmails.length - existingEntries.length,
      updated: existingEntries.length,
      total: normalizedEmails.length,
    };
  } catch (error) {
    throw mapDomainError(error);
  }
}

export async function removeSuppression({ prisma, userId, email, now = new Date() }) {
  let normalizedEmail;
  try {
    normalizedEmail = normalizeEmailAddress(email);
  } catch (error) {
    throw mapDomainError(error);
  }

  const entry = await prisma.suppressionEntry.findUnique({
    where: { user_id_email: { user_id: userId, email: normalizedEmail } },
  });
  if (!entry || entry.removed_at) {
    throw new SuppressionServiceError(
      'SUPPRESSION_NOT_FOUND',
      'Active suppression entry not found',
      { status: 404 },
    );
  }
  if (!canRemoveSuppression(entry.reason)) {
    throw new SuppressionServiceError(
      'SUPPRESSION_LOCKED',
      `A ${entry.reason} suppression cannot be removed manually`,
      { status: 409, details: { reason: entry.reason } },
    );
  }
  return prisma.suppressionEntry.update({
    where: { id: entry.id },
    data: { removed_at: now },
  });
}

export async function getSuppressionDecision({ prisma, userId, email }) {
  let normalizedEmail;
  try {
    normalizedEmail = normalizeEmailAddress(email);
  } catch (error) {
    throw mapDomainError(error);
  }
  const entry = await prisma.suppressionEntry.findUnique({
    where: { user_id_email: { user_id: userId, email: normalizedEmail } },
    select: {
      id: true,
      email: true,
      reason: true,
      source: true,
      details: true,
      created_at: true,
      removed_at: true,
    },
  });
  return entry && !entry.removed_at
    ? { suppressed: true, entry }
    : { suppressed: false, entry: null };
}

function listFilters(query = {}) {
  const page = Number(query.page || 1);
  const limit = Number(query.limit || 50);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new SuppressionServiceError(
      'INVALID_SUPPRESSION_PAGINATION',
      'page and limit must be positive integers, with limit at most 100',
    );
  }
  const reason = typeof query.reason === 'string' && query.reason ? query.reason : null;
  if (reason) {
    try {
      assertSuppressionReason(reason);
    } catch (error) {
      throw mapDomainError(error);
    }
  }
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 254) : '';
  const includeRemoved = query.includeRemoved === 'true' || query.includeRemoved === true;
  return { page, limit, reason, search: search || null, includeRemoved };
}

export async function listSuppressions({ prisma, userId, query }) {
  const filters = listFilters(query);
  const where = {
    user_id: userId,
    ...(filters.reason ? { reason: filters.reason } : {}),
    ...(filters.search ? { email: { contains: filters.search, mode: 'insensitive' } } : {}),
    ...(!filters.includeRemoved ? { removed_at: null } : {}),
  };
  const [total, entries] = await prisma.$transaction([
    prisma.suppressionEntry.count({ where }),
    prisma.suppressionEntry.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      select: {
        id: true,
        email: true,
        reason: true,
        source: true,
        details: true,
        created_at: true,
        updated_at: true,
        removed_at: true,
      },
    }),
  ]);
  return {
    entries,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit),
    },
  };
}

export async function suppressionSummary({ prisma, userId }) {
  const grouped = await prisma.suppressionEntry.groupBy({
    by: ['reason'],
    where: { user_id: userId, removed_at: null },
    _count: { _all: true },
  });
  const byReason = Object.fromEntries(
    Object.values(SUPPRESSION_REASON).map((reason) => [reason, 0]),
  );
  for (const group of grouped) byReason[group.reason] = group._count._all;
  return {
    active: Object.values(byReason).reduce((total, count) => total + count, 0),
    byReason,
  };
}
