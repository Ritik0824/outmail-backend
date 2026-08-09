import { schemaRef } from './openapiSchemas.js';

const jsonContent = (schema) => ({
  'application/json': { schema },
});

const response = (description, schema) => ({
  description,
  ...(schema ? { content: jsonContent(schema) } : {}),
});

const requestBody = (schema, required = true) => ({
  required,
  content: jsonContent(schema),
});

const errorResponse = (description) => response(description, schemaRef('Error'));

const authErrors = {
  401: errorResponse('Authentication is missing, invalid, or expired.'),
};

const adminErrors = {
  ...authErrors,
  403: errorResponse('The authenticated user is not a configured queue administrator.'),
};

const campaignId = {
  name: 'campaignId',
  in: 'path',
  required: true,
  description: 'Campaign UUID.',
  schema: { type: 'string', format: 'uuid' },
};

const recipientId = {
  name: 'recipientId',
  in: 'path',
  required: true,
  description: 'Durable campaign recipient UUID.',
  schema: { type: 'string', format: 'uuid' },
};

const resourceId = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Resource UUID.',
  schema: { type: 'string', format: 'uuid' },
};

const pageParameters = [
  {
    name: 'page',
    in: 'query',
    description: 'One-based page number.',
    schema: { type: 'integer', minimum: 1, default: 1 },
  },
  {
    name: 'limit',
    in: 'query',
    description: 'Maximum results returned per page.',
    schema: { type: 'integer', minimum: 1, maximum: 100 },
  },
];

const analyticsRangeParameters = [
  {
    name: 'from',
    in: 'query',
    description: 'Inclusive beginning of the UTC analytics range.',
    schema: { type: 'string', format: 'date' },
  },
  {
    name: 'to',
    in: 'query',
    description: 'Inclusive end of the UTC analytics range.',
    schema: { type: 'string', format: 'date' },
  },
];

const lifecycleOperation = (action) => ({
  tags: ['Campaigns'],
  operationId: `${action}Campaign`,
  summary: `${action[0].toUpperCase()}${action.slice(1)} a campaign`,
  description: `Atomically ${action}s durable recipients and coordinates their queue jobs.`,
  parameters: [campaignId],
  responses: {
    202: response('Campaign transition accepted.', schemaRef('CampaignLifecycleResult')),
    400: errorResponse('The lifecycle action is invalid.'),
    404: errorResponse('Campaign not found for this user.'),
    409: errorResponse('The transition is not allowed from the current status.'),
    503: errorResponse('Queue coordination failed safely.'),
    ...authErrors,
  },
});

export const openApiPaths = {
  '/': {
    get: {
      tags: ['System'],
      operationId: 'getServiceBanner',
      summary: 'Get the service banner',
      security: [],
      responses: {
        200: {
          description: 'Plain-text service banner.',
          content: { 'text/html': { schema: { type: 'string' } } },
        },
      },
    },
  },
  '/health/live': {
    get: {
      tags: ['Health'],
      operationId: 'getLiveness',
      summary: 'Check process liveness',
      description: 'Returns without contacting PostgreSQL, Redis, or a delivery worker.',
      security: [],
      responses: {
        200: response('The API process is alive.', {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', enum: ['ok'] } },
        }),
      },
    },
  },
  '/health/ready': {
    get: {
      tags: ['Health'],
      operationId: 'getReadiness',
      summary: 'Check public dependency readiness',
      description: 'Checks PostgreSQL, the delivery queue, and worker registration without exposing internals.',
      security: [],
      responses: {
        200: response('Critical dependencies are ready.', schemaRef('HealthReport')),
        503: response('A critical dependency is unavailable.', schemaRef('HealthReport')),
      },
    },
  },
  '/health/details': {
    get: {
      tags: ['Health', 'Operations'],
      operationId: 'getDetailedHealth',
      summary: 'Inspect detailed dependency and runtime health',
      description: 'Administrator-only view of queue counts, worker state, latency, memory, and host load.',
      responses: {
        200: response('Detailed service health.', schemaRef('HealthReport')),
        503: response('One or more critical dependencies are unavailable.', schemaRef('HealthReport')),
        ...adminErrors,
      },
    },
  },
  '/api/auth/google': {
    get: {
      tags: ['Authentication'],
      operationId: 'beginGoogleAuthentication',
      summary: 'Begin Google OAuth authentication',
      security: [],
      responses: {
        302: response('Redirect to Google OAuth consent.'),
      },
    },
  },
  '/api/auth/google/callback': {
    get: {
      tags: ['Authentication'],
      operationId: 'completeGoogleAuthentication',
      summary: 'Complete Google OAuth authentication',
      security: [],
      parameters: [
        {
          name: 'code',
          in: 'query',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        302: response('Set the secure session cookie and redirect to the dashboard.'),
        401: errorResponse('Google authentication failed.'),
      },
    },
  },
  '/api/auth/login': {
    post: {
      tags: ['Authentication'],
      operationId: 'refreshApplicationCredential',
      summary: 'Update the authenticated user application credential',
      description: 'Requires an existing valid session and never accepts anonymous credential writes.',
      requestBody: requestBody({
        type: 'object',
        required: ['app_password'],
        properties: { app_password: { type: 'string', minLength: 1 } },
      }),
      responses: {
        200: response('Application credential updated.', {
          type: 'object',
          properties: { success: { type: 'boolean' } },
        }),
        400: errorResponse('Credential input is invalid.'),
        ...authErrors,
      },
    },
  },
  '/api/auth/me': {
    get: {
      tags: ['Authentication'],
      operationId: 'getCurrentUser',
      summary: 'Get the authenticated user profile',
      responses: {
        200: response('Current user profile.', schemaRef('User')),
        ...authErrors,
      },
    },
  },
  '/api/auth/update-name': {
    post: {
      tags: ['Authentication'],
      operationId: 'updateCurrentUserName',
      summary: 'Update the current user display name',
      requestBody: requestBody({
        type: 'object',
        required: ['display_name'],
        properties: { display_name: { type: 'string', minLength: 1, maxLength: 120 } },
      }),
      responses: {
        200: response('Updated user profile.', schemaRef('User')),
        400: errorResponse('The display name is invalid.'),
        ...authErrors,
      },
    },
  },
  '/api/auth/logout': {
    post: {
      tags: ['Authentication'],
      operationId: 'logoutCurrentUser',
      summary: 'Clear the browser authentication cookie',
      security: [],
      responses: {
        204: response('The authentication cookie was cleared.'),
      },
    },
  },
  '/api/auth/contact': {
    post: {
      tags: ['Contact'],
      operationId: 'createContactMessage',
      summary: 'Submit a contact message',
      security: [],
      requestBody: requestBody(schemaRef('ContactInput')),
      responses: {
        200: response('Contact message stored.', {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        }),
        400: errorResponse('Contact input is invalid.'),
        429: errorResponse('The IP address exceeded an hourly or daily limit.'),
        500: errorResponse('The contact message could not be stored.'),
      },
    },
  },
  '/api/auth/email-usage': {
    get: {
      tags: ['Authentication', 'Analytics'],
      operationId: 'getDeliveryQuota',
      summary: 'Get current atomic delivery quota usage',
      responses: {
        200: response('Current minute and daily delivery quota.', schemaRef('DeliveryQuota')),
        503: errorResponse('Quota storage is unavailable.'),
        ...authErrors,
      },
    },
  },
  '/api/templates': {
    get: {
      tags: ['Templates'],
      operationId: 'listTemplates',
      summary: 'List templates owned by the user',
      responses: {
        200: response('Templates in newest-first order.', {
          type: 'array',
          items: schemaRef('Template'),
        }),
        ...authErrors,
      },
    },
    post: {
      tags: ['Templates'],
      operationId: 'createTemplate',
      summary: 'Create an email template',
      requestBody: requestBody(schemaRef('TemplateInput')),
      responses: {
        200: response('Template created.', schemaRef('Template')),
        400: errorResponse('All template fields are required.'),
        ...authErrors,
      },
    },
  },
  '/api/templates/{id}': {
    put: {
      tags: ['Templates'],
      operationId: 'updateTemplate',
      summary: 'Update an owned email template',
      parameters: [resourceId],
      requestBody: requestBody(schemaRef('TemplateInput')),
      responses: {
        200: response('Template updated.', {
          type: 'object',
          properties: { success: { type: 'boolean' } },
        }),
        400: errorResponse('Template input is invalid.'),
        404: errorResponse('Template not found for this user.'),
        ...authErrors,
      },
    },
    delete: {
      tags: ['Templates'],
      operationId: 'deleteTemplate',
      summary: 'Delete an owned email template',
      parameters: [resourceId],
      responses: {
        200: response('Template deleted.', {
          type: 'object',
          properties: { success: { type: 'boolean' } },
        }),
        404: errorResponse('Template not found for this user.'),
        ...authErrors,
      },
    },
  },
  '/api/resumes': {
    get: {
      tags: ['Attachments'],
      operationId: 'listAttachments',
      summary: 'List campaign attachments',
      parameters: pageParameters,
      responses: {
        200: response('Paginated attachment collection.', {
          type: 'object',
          properties: {
            attachments: { type: 'array', items: schemaRef('AttachmentSummary') },
            pagination: schemaRef('Pagination'),
          },
        }),
        ...authErrors,
      },
    },
    post: {
      tags: ['Attachments'],
      operationId: 'createAttachment',
      summary: 'Upload a validated campaign attachment',
      description: 'Accepts one in-memory upload up to 5 MiB and verifies extension and file signature.',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: {
        201: response('Attachment stored.', {
          type: 'object',
          properties: { attachment: schemaRef('AttachmentSummary') },
        }),
        400: errorResponse('No file was supplied or metadata is invalid.'),
        409: errorResponse('The per-user attachment limit was reached.'),
        413: errorResponse('The attachment exceeds 5 MiB.'),
        415: errorResponse('The attachment type, extension, or signature is not allowed.'),
        503: errorResponse('Object or metadata storage is unavailable.'),
        ...authErrors,
      },
    },
  },
  '/api/resumes/{id}': {
    delete: {
      tags: ['Attachments'],
      operationId: 'deleteAttachment',
      summary: 'Delete an unused owned attachment',
      parameters: [resourceId],
      responses: {
        200: response('Attachment metadata deleted.', schemaRef('AttachmentDeleteResult')),
        404: errorResponse('Attachment not found for this user.'),
        409: errorResponse('The attachment is still used by one or more campaigns.'),
        ...authErrors,
      },
    },
  },
  '/api/campaigns/mine': {
    get: {
      tags: ['Campaigns'],
      operationId: 'listCampaigns',
      summary: 'List campaigns owned by the user',
      responses: {
        200: response('Campaign summaries in newest-first order.', {
          type: 'object',
          properties: {
            campaigns: { type: 'array', items: schemaRef('CampaignSummary') },
          },
        }),
        ...authErrors,
      },
    },
  },
  '/api/campaigns/start': {
    post: {
      tags: ['Campaigns'],
      operationId: 'startCampaign',
      summary: 'Create and queue a durable campaign',
      description: 'Imports recipients, snapshots personalized content, persists jobs, and queues stable IDs.',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['csv', 'name', 'subject', 'body', 'scheduled_start'],
              properties: {
                csv: { type: 'string', format: 'binary' },
                name: { type: 'string' },
                subject: { type: 'string' },
                body: { type: 'string' },
                scheduled_start: { type: 'string', format: 'date-time' },
                timezone: { type: 'string' },
                template_id: { type: 'string', format: 'uuid' },
                resume_ids: {
                  type: 'array',
                  items: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
      },
      responses: {
        202: response('Campaign persisted and queueing accepted.', schemaRef('CampaignCreateAccepted')),
        400: errorResponse('Campaign fields or recipient data are invalid.'),
        413: errorResponse('The recipient file exceeds 10 MiB.'),
        503: errorResponse('Campaign data was preserved but queueing failed.'),
        ...authErrors,
      },
    },
  },
  '/api/campaigns/{campaignId}': {
    get: {
      tags: ['Campaigns'],
      operationId: 'getCampaign',
      summary: 'Get an owned campaign overview',
      parameters: [campaignId],
      responses: {
        200: response('Campaign detail and recipient status counts.', {
          type: 'object',
          properties: { campaign: schemaRef('CampaignDetail') },
        }),
        404: errorResponse('Campaign not found for this user.'),
        ...authErrors,
      },
    },
  },
  '/api/campaigns/{campaignId}/recipients': {
    get: {
      tags: ['Campaigns'],
      operationId: 'listCampaignRecipients',
      summary: 'List durable campaign recipients',
      parameters: [
        campaignId,
        ...pageParameters,
        {
          name: 'status',
          in: 'query',
          schema: schemaRef('RecipientStatus'),
        },
        {
          name: 'search',
          in: 'query',
          schema: { type: 'string', maxLength: 254 },
        },
      ],
      responses: {
        200: response('Paginated recipient collection.', {
          type: 'object',
          properties: {
            recipients: { type: 'array', items: schemaRef('CampaignRecipient') },
            pagination: schemaRef('Pagination'),
          },
        }),
        400: errorResponse('Recipient filters are invalid.'),
        404: errorResponse('Campaign not found for this user.'),
        ...authErrors,
      },
    },
  },
  '/api/campaigns/{campaignId}/recipients/{recipientId}/attempts': {
    get: {
      tags: ['Campaigns'],
      operationId: 'getRecipientAttempts',
      summary: 'Inspect delivery attempts for one campaign recipient',
      parameters: [campaignId, recipientId],
      responses: {
        200: response('Recipient and ordered delivery attempts.', {
          type: 'object',
          properties: { recipient: schemaRef('RecipientAttempts') },
        }),
        404: errorResponse('Campaign or recipient not found for this user.'),
        ...authErrors,
      },
    },
  },
  '/api/campaigns/{campaignId}/requeue': {
    post: {
      tags: ['Campaigns'],
      operationId: 'requeueCampaign',
      summary: 'Restore missing pending campaign jobs',
      parameters: [campaignId],
      responses: {
        202: response('Pending recipients queued with stable IDs.', {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            campaignId: { type: 'string', format: 'uuid' },
            requeuedRecipients: { type: 'integer', minimum: 0 },
          },
        }),
        404: errorResponse('Campaign not found for this user.'),
        503: errorResponse('Queueing or durable status persistence failed.'),
        ...authErrors,
      },
    },
  },
  '/api/campaigns/{campaignId}/pause': {
    post: lifecycleOperation('pause'),
  },
  '/api/campaigns/{campaignId}/resume': {
    post: lifecycleOperation('resume'),
  },
  '/api/campaigns/{campaignId}/cancel': {
    post: lifecycleOperation('cancel'),
  },
  '/api/campaigns/{campaignId}/events': {
    get: {
      tags: ['Campaigns'],
      operationId: 'listCampaignEvents',
      summary: 'List immutable campaign lifecycle events',
      parameters: [campaignId, ...pageParameters],
      responses: {
        200: response('Paginated campaign event stream.', {
          type: 'object',
          properties: {
            events: { type: 'array', items: schemaRef('CampaignEvent') },
            pagination: schemaRef('Pagination'),
          },
        }),
        400: errorResponse('Event pagination is invalid.'),
        404: errorResponse('Campaign not found for this user.'),
        ...authErrors,
      },
    },
  },
  '/api/suppressions': {
    get: {
      tags: ['Suppressions'],
      operationId: 'listSuppressions',
      summary: 'List active and historical suppression entries',
      parameters: [
        ...pageParameters,
        { name: 'search', in: 'query', schema: { type: 'string' } },
        { name: 'reason', in: 'query', schema: schemaRef('SuppressionReason') },
        { name: 'includeRemoved', in: 'query', schema: { type: 'boolean', default: false } },
      ],
      responses: {
        200: response('Paginated suppression collection.', {
          type: 'object',
          properties: {
            entries: { type: 'array', items: schemaRef('SuppressionEntry') },
            pagination: schemaRef('Pagination'),
          },
        }),
        400: errorResponse('Suppression filters are invalid.'),
        ...authErrors,
      },
    },
    post: {
      tags: ['Suppressions'],
      operationId: 'createSuppression',
      summary: 'Create or strengthen a suppression entry',
      requestBody: requestBody(schemaRef('SuppressionInput')),
      responses: {
        201: response('Suppression created or updated.', {
          type: 'object',
          properties: { entry: schemaRef('SuppressionEntry') },
        }),
        400: errorResponse('Suppression input is invalid.'),
        ...authErrors,
      },
    },
  },
  '/api/suppressions/summary': {
    get: {
      tags: ['Suppressions'],
      operationId: 'getSuppressionSummary',
      summary: 'Summarize active suppressions by reason',
      responses: {
        200: response('Suppression totals.', {
          type: 'object',
          properties: {
            summary: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
          },
        }),
        ...authErrors,
      },
    },
  },
  '/api/suppressions/check': {
    get: {
      tags: ['Suppressions'],
      operationId: 'checkSuppression',
      summary: 'Check one normalized address for suppression',
      parameters: [{
        name: 'email',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'email' },
      }],
      responses: {
        200: response('Suppression decision.', {
          type: 'object',
          properties: {
            suppressed: { type: 'boolean' },
            entry: { ...schemaRef('SuppressionEntry'), nullable: true },
          },
        }),
        400: errorResponse('Email address is invalid.'),
        ...authErrors,
      },
    },
  },
  '/api/suppressions/batch': {
    post: {
      tags: ['Suppressions'],
      operationId: 'createSuppressionBatch',
      summary: 'Create a normalized batch of suppression entries',
      requestBody: requestBody(schemaRef('SuppressionBatchInput')),
      responses: {
        201: response('Batch import summary.', {
          type: 'object',
          additionalProperties: true,
        }),
        400: errorResponse('One or more batch entries are invalid.'),
        ...authErrors,
      },
    },
  },
  '/api/suppressions/{email}': {
    delete: {
      tags: ['Suppressions'],
      operationId: 'deleteManualSuppression',
      summary: 'Remove a manual suppression entry',
      description: 'Compliance and provider-generated suppressions cannot be manually removed.',
      parameters: [{
        name: 'email',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'email' },
      }],
      responses: {
        200: response('Manual suppression removed.', {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            entry: schemaRef('SuppressionEntry'),
          },
        }),
        404: errorResponse('Active suppression not found.'),
        409: errorResponse('The suppression reason cannot be manually removed.'),
        ...authErrors,
      },
    },
  },
  '/api/unsubscribe/{token}': {
    get: {
      tags: ['Unsubscribe'],
      operationId: 'previewUnsubscribe',
      summary: 'Preview a signed recipient unsubscribe request',
      security: [],
      parameters: [{
        name: 'token',
        in: 'path',
        required: true,
        schema: { type: 'string', maxLength: 4096 },
      }],
      responses: {
        200: response('Masked unsubscribe preview.', schemaRef('UnsubscribePreview')),
        400: errorResponse('Token is malformed or invalid.'),
        410: errorResponse('Token has expired.'),
        429: errorResponse('Unsubscribe rate limit exceeded.'),
      },
    },
    post: {
      tags: ['Unsubscribe'],
      operationId: 'confirmUnsubscribe',
      summary: 'Confirm a signed recipient unsubscribe request',
      security: [],
      parameters: [{
        name: 'token',
        in: 'path',
        required: true,
        schema: { type: 'string', maxLength: 4096 },
      }],
      responses: {
        200: response('Idempotent unsubscribe result.', schemaRef('UnsubscribeConfirmation')),
        400: errorResponse('Token is malformed or invalid.'),
        410: errorResponse('Token has expired.'),
        429: errorResponse('Unsubscribe rate limit exceeded.'),
      },
    },
  },
  '/api/analytics/overview': {
    get: {
      tags: ['Analytics'],
      operationId: 'getAnalyticsOverview',
      summary: 'Get account-wide campaign analytics',
      parameters: analyticsRangeParameters,
      responses: {
        200: response('Owner-scoped analytics overview.', {
          type: 'object',
          properties: { analytics: { type: 'object', additionalProperties: true } },
        }),
        400: errorResponse('Analytics date range is invalid or too large.'),
        ...authErrors,
      },
    },
  },
  '/api/analytics/trends': {
    get: {
      tags: ['Analytics'],
      operationId: 'getDeliveryTrends',
      summary: 'Get dense daily delivery outcome trends',
      parameters: analyticsRangeParameters,
      responses: {
        200: response('Daily terminal outcome series.', {
          type: 'object',
          properties: {
            trends: {
              type: 'object',
              properties: {
                range: schemaRef('AnalyticsRange'),
                outcomes: { type: 'integer', minimum: 0 },
                daily: { type: 'array', items: schemaRef('OutcomeBucket') },
              },
            },
          },
        }),
        400: errorResponse('Analytics date range is invalid or too large.'),
        ...authErrors,
      },
    },
  },
  '/api/analytics/campaigns/{campaignId}': {
    get: {
      tags: ['Analytics'],
      operationId: 'getCampaignAnalytics',
      summary: 'Get detailed analytics for one owned campaign',
      parameters: [campaignId, ...analyticsRangeParameters],
      responses: {
        200: response('Campaign outcome, provider, velocity, and failure analytics.', {
          type: 'object',
          properties: { analytics: schemaRef('CampaignAnalytics') },
        }),
        400: errorResponse('Analytics date range is invalid or too large.'),
        404: errorResponse('Campaign not found for this user.'),
        ...authErrors,
      },
    },
  },
  '/api/operations/campaigns/{campaignId}/integrity': {
    get: {
      tags: ['Operations'],
      operationId: 'inspectCampaignIntegrity',
      summary: 'Inspect durable counters and queue jobs',
      parameters: [campaignId],
      responses: {
        200: response('Read-only integrity inspection.', {
          type: 'object',
          properties: { inspection: schemaRef('IntegrityInspection') },
        }),
        404: errorResponse('Campaign not found for this administrator.'),
        ...adminErrors,
      },
    },
  },
  '/api/operations/campaigns/{campaignId}/reconcile': {
    post: {
      tags: ['Operations'],
      operationId: 'reconcileCampaignIntegrity',
      summary: 'Dry-run or repair campaign integrity',
      parameters: [campaignId],
      requestBody: requestBody({
        type: 'object',
        properties: { dryRun: { type: 'boolean', default: true } },
      }, false),
      responses: {
        200: response('Dry-run reconciliation report.', schemaRef('ReconciliationResult')),
        202: response('Repair reconciliation report.', schemaRef('ReconciliationResult')),
        404: errorResponse('Campaign not found for this administrator.'),
        503: errorResponse('A required queue repair failed.'),
        ...adminErrors,
      },
    },
  },
  '/api/operations/campaigns/reconcile': {
    post: {
      tags: ['Operations'],
      operationId: 'reconcileCampaignBatch',
      summary: 'Inspect or repair a bounded campaign batch',
      requestBody: requestBody({
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', default: true },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      }, false),
      responses: {
        200: response('Batch dry-run report.', { type: 'object', additionalProperties: true }),
        202: response('Batch repair report.', { type: 'object', additionalProperties: true }),
        400: errorResponse('Batch options are invalid.'),
        ...adminErrors,
      },
    },
  },
  '/api/webhooks/delivery': {
    post: {
      tags: ['Webhooks'],
      operationId: 'receiveDeliveryWebhook',
      summary: 'Receive an authenticated provider delivery event',
      description: 'The HMAC signature binds the timestamp and exact raw JSON body before parsing.',
      security: [{ DeliveryWebhookSignature: [] }],
      parameters: [
        {
          name: 'x-outmail-timestamp',
          in: 'header',
          required: true,
          schema: { type: 'integer' },
        },
        {
          name: 'x-outmail-signature',
          in: 'header',
          required: true,
          schema: { type: 'string', pattern: '^v1=[a-f0-9]{64}' },
        },
      ],
      requestBody: requestBody(schemaRef('DeliveryWebhookEvent')),
      responses: {
        202: response('Event stored and processed idempotently.', {
          type: 'object',
          properties: {
            received: { type: 'boolean' },
            duplicate: { type: 'boolean' },
            outcome: { type: 'string' },
          },
        }),
        400: errorResponse('The payload or signature headers are malformed.'),
        401: errorResponse('The signature is invalid, stale, or from the future.'),
        409: errorResponse('The event conflicts with durable recipient identity.'),
        429: errorResponse('Webhook rate limit exceeded.'),
      },
    },
  },
};
