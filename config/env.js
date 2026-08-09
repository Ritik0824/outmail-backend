import Joi from 'joi';

const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).default('redis://localhost:6379'),
  APP_ORIGINS: Joi.string().default('http://localhost:8080'),
  FRONTEND_URL: Joi.string().uri().default('http://localhost:8080'),
  JWT_SECRET: Joi.string().min(32).required(),
  SECRET_KEY: Joi.string().min(32).required(),
  UNSUBSCRIBE_SECRET: Joi.string().min(32).required(),
  UNSUBSCRIBE_TOKEN_TTL_DAYS: Joi.number().integer().min(1).max(365).default(90),
  PUBLIC_API_URL: Joi.string().uri().default('http://localhost:3000'),
  GOOGLE_CLIENT_ID: Joi.string().required(),
  GOOGLE_CLIENT_SECRET: Joi.string().required(),
  GOOGLE_REDIRECT_URI: Joi.string().uri().required(),
  AWS_REGION: Joi.string().required(),
  AWS_ACCESS_KEY_ID: Joi.string().required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_BUCKET: Joi.string().required(),
  S3_URL: Joi.string().uri().required(),
  S3_ENDPOINT: Joi.string().uri().optional(),
  QUEUE_ADMIN_EMAILS: Joi.string().allow('').default(''),
}).unknown(true);

export function loadConfig(env = process.env) {
  const { value, error } = envSchema.validate(env, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    const details = error.details.map((detail) => detail.message).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    redisUrl: value.REDIS_URL,
    allowedOrigins: value.APP_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    frontendUrl: value.FRONTEND_URL,
    publicApiUrl: value.PUBLIC_API_URL.replace(/\/$/, ''),
    unsubscribeTokenTtlDays: value.UNSUBSCRIBE_TOKEN_TTL_DAYS,
    queueAdminEmails: value.QUEUE_ADMIN_EMAILS.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean),
  });
}
