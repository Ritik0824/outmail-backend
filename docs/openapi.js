import { openApiPaths } from './openapiPaths.js';
import { openApiSchemas } from './openapiSchemas.js';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

export const openApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'OutMail API',
    version: '1.0.0',
    summary: 'Durable campaign creation, delivery, analytics, and recovery.',
    description: [
      'OutMail imports recipient data and snapshots personalized campaign content before queueing.',
      'Recipient, attempt, suppression, lifecycle, and provider-event records make delivery observable',
      'and safely recoverable across API, worker, Redis, or provider failures.',
    ].join(' '),
    contact: {
      name: 'OutMail maintainers',
    },
    license: {
      name: 'Private project',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local development server',
    },
  ],
  tags: [
    { name: 'System', description: 'Basic service discovery.' },
    { name: 'Health', description: 'Liveness and dependency readiness.' },
    { name: 'Authentication', description: 'Google OAuth, session, and profile operations.' },
    { name: 'Contact', description: 'Rate-limited public contact requests.' },
    { name: 'Templates', description: 'Owner-scoped reusable email content.' },
    { name: 'Attachments', description: 'Validated files attached to campaigns.' },
    { name: 'Campaigns', description: 'Durable campaigns, recipients, attempts, and lifecycle.' },
    { name: 'Suppressions', description: 'Canonical per-user do-not-send records.' },
    { name: 'Unsubscribe', description: 'Signed public recipient opt-out flow.' },
    { name: 'Analytics', description: 'Owner-scoped outcomes and delivery trends.' },
    { name: 'Operations', description: 'Administrator health and reconciliation controls.' },
    { name: 'Webhooks', description: 'Raw-body authenticated provider callbacks.' },
  ],
  security: [
    { SessionCookie: [] },
    { BearerToken: [] },
  ],
  paths: openApiPaths,
  components: {
    securitySchemes: {
      SessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'outmail_session',
        description: 'Secure, HTTP-only browser session cookie issued after Google OAuth.',
      },
      BearerToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT supplied by trusted non-browser clients.',
      },
      DeliveryWebhookSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'x-outmail-signature',
        description: 'HMAC-SHA256 v1 signature over the timestamp and exact request bytes.',
      },
    },
    schemas: openApiSchemas,
  },
});

function operationEntries(document) {
  const operations = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      operations.push({ path, method: method.toUpperCase(), operation });
    }
  }
  return operations;
}

export function listApiOperations(document = openApiDocument) {
  return operationEntries(document).map(({ path, method, operation }) => ({
    path,
    method,
    operationId: operation.operationId,
    summary: operation.summary,
    tags: operation.tags ?? [],
    public: Array.isArray(operation.security) && operation.security.length === 0,
  }));
}

function pathVariables(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function parameterNames(operation, location) {
  return new Set(
    (operation.parameters ?? [])
      .filter((parameter) => parameter.in === location)
      .map((parameter) => parameter.name),
  );
}

function collectSchemaReferences(value, references = []) {
  if (!value || typeof value !== 'object') return references;
  if (typeof value.$ref === 'string') references.push(value.$ref);
  for (const child of Object.values(value)) {
    collectSchemaReferences(child, references);
  }
  return references;
}

export function validateOpenApiDocument(document = openApiDocument) {
  const errors = [];
  if (!String(document.openapi ?? '').startsWith('3.1.')) {
    errors.push('openapi must declare a 3.1.x version');
  }
  if (!document.info?.title || !document.info?.version) {
    errors.push('info.title and info.version are required');
  }
  const operationIds = new Map();
  for (const { path, method, operation } of operationEntries(document)) {
    if (!path.startsWith('/')) errors.push(`${method} ${path} must start with a slash`);
    if (!operation.operationId) {
      errors.push(`${method} ${path} is missing operationId`);
    } else if (operationIds.has(operation.operationId)) {
      errors.push(`operationId ${operation.operationId} is duplicated`);
    } else {
      operationIds.set(operation.operationId, `${method} ${path}`);
    }
    if (!operation.summary) errors.push(`${method} ${path} is missing a summary`);
    if (!operation.responses || Object.keys(operation.responses).length === 0) {
      errors.push(`${method} ${path} is missing responses`);
    }
    const declared = parameterNames(operation, 'path');
    for (const variable of pathVariables(path)) {
      if (!declared.has(variable)) {
        errors.push(`${method} ${path} does not declare path parameter ${variable}`);
      }
    }
  }

  const schemas = document.components?.schemas ?? {};
  for (const reference of collectSchemaReferences(document)) {
    const prefix = '#/components/schemas/';
    if (reference.startsWith(prefix) && !schemas[reference.slice(prefix.length)]) {
      errors.push(`Schema reference ${reference} does not exist`);
    }
  }
  return [...new Set(errors)];
}

export function assertValidOpenApiDocument(document = openApiDocument) {
  const errors = validateOpenApiDocument(document);
  if (errors.length) {
    throw new Error(`Invalid OpenAPI document: ${errors.join('; ')}`);
  }
  return document;
}

export function createOpenApiDocument({ serverUrl } = {}) {
  const document = structuredClone(openApiDocument);
  if (serverUrl) {
    const parsed = new URL(serverUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('OpenAPI server URL must use http or https');
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    document.servers = [{ url: parsed.toString().replace(/\/$/, ''), description: 'Current API server' }];
  }
  return assertValidOpenApiDocument(document);
}

export function apiDocumentationIndex(document = openApiDocument) {
  const operations = listApiOperations(document);
  return {
    title: document.info.title,
    version: document.info.version,
    openapi: document.openapi,
    operationCount: operations.length,
    tagCount: document.tags.length,
    schemaCount: Object.keys(document.components.schemas).length,
    specification: '/api/docs/openapi.json',
  };
}
