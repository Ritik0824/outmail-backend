const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const ACQUIRE_QUOTA_SCRIPT = `
local minuteCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local dailyCount = tonumber(redis.call('GET', KEYS[2]) or '0')
local minuteLimit = tonumber(ARGV[1])
local dailyLimit = tonumber(ARGV[2])
local minuteResetAt = tonumber(ARGV[3])
local dayResetAt = tonumber(ARGV[4])
local now = tonumber(ARGV[5])

if minuteCount >= minuteLimit then
  return {0, math.max(1, minuteResetAt - now), minuteCount, dailyCount, 'minute'}
end
if dailyCount >= dailyLimit then
  return {0, math.max(1, dayResetAt - now), minuteCount, dailyCount, 'day'}
end

minuteCount = redis.call('INCR', KEYS[1])
dailyCount = redis.call('INCR', KEYS[2])
if minuteCount == 1 then redis.call('PEXPIREAT', KEYS[1], minuteResetAt) end
if dailyCount == 1 then redis.call('PEXPIREAT', KEYS[2], dayResetAt) end
return {1, 0, minuteCount, dailyCount, 'none'}
`;

export class DeliveryQuotaError extends Error {
  constructor(code, message, status = 500, details = {}) {
    super(message);
    this.name = 'DeliveryQuotaError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function positiveLimit(value, fallback, name, maximum) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new DeliveryQuotaError(
      'INVALID_DELIVERY_QUOTA',
      `${name} must be an integer between 1 and ${maximum}`,
      500,
      { field: name, value },
    );
  }
  return parsed;
}

function timezoneOffset(value, fallback = 330) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < -720 || parsed > 840) {
    throw new DeliveryQuotaError(
      'INVALID_DELIVERY_TIMEZONE',
      'timezoneOffsetMinutes must be between -720 and 840',
      500,
      { value },
    );
  }
  return parsed;
}

export function normalizeQuotaOptions(options = {}) {
  return Object.freeze({
    minuteLimit: positiveLimit(options.minuteLimit, 20, 'minuteLimit', 1_000),
    dailyLimit: positiveLimit(options.dailyLimit, 500, 'dailyLimit', 100_000),
    timezoneOffsetMinutes: timezoneOffset(options.timezoneOffsetMinutes),
    keyPrefix: typeof options.keyPrefix === 'string' && options.keyPrefix.trim()
      ? options.keyPrefix.trim()
      : 'outmail:delivery-quota',
  });
}

export function quotaOptionsFromEnv(env = process.env) {
  return normalizeQuotaOptions({
    minuteLimit: env.DELIVERY_MINUTE_LIMIT,
    dailyLimit: env.DELIVERY_DAILY_LIMIT,
    timezoneOffsetMinutes: env.DELIVERY_TIMEZONE_OFFSET_MINUTES,
    keyPrefix: env.DELIVERY_QUOTA_KEY_PREFIX,
  });
}

function fixedWindow(timestamp, durationMs, offsetMs = 0) {
  const index = Math.floor((timestamp + offsetMs) / durationMs);
  const startsAt = (index * durationMs) - offsetMs;
  return {
    index,
    startsAt,
    resetsAt: startsAt + durationMs,
  };
}

export function quotaWindows(now = new Date(), timezoneOffsetMinutes = 330) {
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(timestamp)) {
    throw new DeliveryQuotaError('INVALID_QUOTA_TIME', 'now must be a valid timestamp');
  }
  const offsetMs = timezoneOffset(timezoneOffsetMinutes) * MINUTE_MS;
  return {
    timestamp,
    minute: fixedWindow(timestamp, MINUTE_MS),
    day: fixedWindow(timestamp, DAY_MS, offsetMs),
  };
}

function safeUserKey(userId) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 128) {
    throw new DeliveryQuotaError('INVALID_QUOTA_USER', 'A valid user ID is required', 400);
  }
  return encodeURIComponent(userId.trim());
}

export function quotaKeys({ userId, windows, keyPrefix = 'outmail:delivery-quota' }) {
  const user = safeUserKey(userId);
  return {
    minute: `${keyPrefix}:${user}:minute:${windows.minute.index}`,
    day: `${keyPrefix}:${user}:day:${windows.day.index}`,
  };
}

function integerReply(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new DeliveryQuotaError(
      'INVALID_QUOTA_RESPONSE',
      `Redis returned an invalid ${field}`,
      503,
    );
  }
  return parsed;
}

export function parseAcquireReply(reply, options, windows) {
  if (!Array.isArray(reply) || reply.length < 5) {
    throw new DeliveryQuotaError(
      'INVALID_QUOTA_RESPONSE',
      'Redis returned an invalid delivery quota response',
      503,
    );
  }
  const allowed = integerReply(reply[0], 'allowed') === 1;
  const delayMs = Math.max(0, integerReply(reply[1], 'delay'));
  const minuteCount = integerReply(reply[2], 'minute count');
  const dailyCount = integerReply(reply[3], 'daily count');
  const limitedBy = String(reply[4]);
  return {
    allowed,
    delayMs,
    limitedBy: limitedBy === 'none' ? null : limitedBy,
    usage: {
      minute: minuteCount,
      day: dailyCount,
    },
    limits: {
      minute: options.minuteLimit,
      day: options.dailyLimit,
    },
    resetsAt: {
      minute: new Date(windows.minute.resetsAt),
      day: new Date(windows.day.resetsAt),
    },
  };
}

export async function acquireDeliveryQuota({
  redis,
  userId,
  now = new Date(),
  options: rawOptions = {},
}) {
  if (!redis || typeof redis.eval !== 'function') {
    throw new DeliveryQuotaError(
      'QUOTA_STORE_REQUIRED',
      'A Redis-compatible quota store is required',
      500,
    );
  }
  const options = normalizeQuotaOptions(rawOptions);
  const windows = quotaWindows(now, options.timezoneOffsetMinutes);
  const keys = quotaKeys({ userId, windows, keyPrefix: options.keyPrefix });
  let reply;
  try {
    reply = await redis.eval(
      ACQUIRE_QUOTA_SCRIPT,
      2,
      keys.minute,
      keys.day,
      options.minuteLimit,
      options.dailyLimit,
      windows.minute.resetsAt,
      windows.day.resetsAt,
      windows.timestamp,
    );
  } catch (error) {
    throw new DeliveryQuotaError(
      'QUOTA_STORE_UNAVAILABLE',
      'Delivery quota storage is unavailable',
      503,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return parseAcquireReply(reply, options, windows);
}

export async function inspectDeliveryQuota({
  redis,
  userId,
  now = new Date(),
  options: rawOptions = {},
}) {
  if (!redis || typeof redis.mget !== 'function') {
    throw new DeliveryQuotaError('QUOTA_STORE_REQUIRED', 'A Redis-compatible quota store is required');
  }
  const options = normalizeQuotaOptions(rawOptions);
  const windows = quotaWindows(now, options.timezoneOffsetMinutes);
  const keys = quotaKeys({ userId, windows, keyPrefix: options.keyPrefix });
  let values;
  try {
    values = await redis.mget(keys.minute, keys.day);
  } catch (error) {
    throw new DeliveryQuotaError(
      'QUOTA_STORE_UNAVAILABLE',
      'Delivery quota storage is unavailable',
      503,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const minute = Math.max(0, Number.parseInt(values[0] ?? '0', 10) || 0);
  const day = Math.max(0, Number.parseInt(values[1] ?? '0', 10) || 0);
  return {
    usage: { minute, day },
    remaining: {
      minute: Math.max(0, options.minuteLimit - minute),
      day: Math.max(0, options.dailyLimit - day),
    },
    limits: { minute: options.minuteLimit, day: options.dailyLimit },
    resetsAt: {
      minute: new Date(windows.minute.resetsAt),
      day: new Date(windows.day.resetsAt),
    },
  };
}

export async function resetDeliveryQuota({ redis, userId, now = new Date(), options = {} }) {
  if (!redis || typeof redis.del !== 'function') {
    throw new DeliveryQuotaError('QUOTA_STORE_REQUIRED', 'A Redis-compatible quota store is required');
  }
  const normalized = normalizeQuotaOptions(options);
  const windows = quotaWindows(now, normalized.timezoneOffsetMinutes);
  const keys = quotaKeys({ userId, windows, keyPrefix: normalized.keyPrefix });
  const removed = await redis.del(keys.minute, keys.day);
  return { removed, keys: Object.values(keys) };
}

export function deliveryQuotaHeaders(quota) {
  return {
    'X-RateLimit-Limit-Minute': String(quota.limits.minute),
    'X-RateLimit-Limit-Day': String(quota.limits.day),
    'X-RateLimit-Remaining-Minute': String(
      Math.max(0, quota.limits.minute - quota.usage.minute),
    ),
    'X-RateLimit-Remaining-Day': String(Math.max(0, quota.limits.day - quota.usage.day)),
    ...(quota.delayMs > 0 ? { 'Retry-After': String(Math.ceil(quota.delayMs / 1_000)) } : {}),
  };
}
