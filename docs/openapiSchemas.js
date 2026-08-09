export const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });

const nullableDateTime = {
  type: 'string',
  format: 'date-time',
  nullable: true,
};

const identifier = {
  type: 'string',
  format: 'uuid',
};

const pagination = {
  type: 'object',
  required: ['page', 'limit', 'total', 'pages'],
  properties: {
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    total: { type: 'integer', minimum: 0 },
    pages: { type: 'integer', minimum: 0 },
  },
};

export const openApiSchemas = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string', description: 'Human-readable error summary.' },
      code: { type: 'string', description: 'Stable machine-readable error code.' },
    },
    additionalProperties: true,
  },
  Pagination: pagination,
  User: {
    type: 'object',
    required: ['id', 'email', 'display_name'],
    properties: {
      id: identifier,
      email: { type: 'string', format: 'email' },
      display_name: { type: 'string' },
      isFirstTime: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' },
      last_login: nullableDateTime,
    },
  },
  CampaignStatus: {
    type: 'string',
    enum: [
      'scheduled',
      'queue_failed',
      'queue_state_unknown',
      'running',
      'paused',
      'cancelled',
      'completed',
    ],
  },
  RecipientStatus: {
    type: 'string',
    enum: [
      'pending',
      'queued',
      'sending',
      'retrying',
      'paused',
      'sent',
      'failed',
      'cancelled',
      'suppressed',
      'delivery_unknown',
    ],
  },
  CampaignCounters: {
    type: 'object',
    required: [
      'total_emails',
      'sent_emails',
      'failed_emails',
      'cancelled_emails',
      'suppressed_emails',
    ],
    properties: {
      total_emails: { type: 'integer', minimum: 0 },
      sent_emails: { type: 'integer', minimum: 0 },
      failed_emails: { type: 'integer', minimum: 0 },
      cancelled_emails: { type: 'integer', minimum: 0 },
      suppressed_emails: { type: 'integer', minimum: 0 },
    },
  },
  CampaignSummary: {
    allOf: [
      schemaRef('CampaignCounters'),
      {
        type: 'object',
        required: ['id', 'name', 'status', 'created_at'],
        properties: {
          id: identifier,
          name: { type: 'string' },
          status: schemaRef('CampaignStatus'),
          created_at: { type: 'string', format: 'date-time' },
          started_at: nullableDateTime,
          completed_at: nullableDateTime,
        },
      },
    ],
  },
  CampaignDetail: {
    allOf: [
      schemaRef('CampaignSummary'),
      {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          timezone: { type: 'string' },
          scheduled_start: { type: 'string', format: 'date-time' },
          paused_at: nullableDateTime,
          cancelled_at: nullableDateTime,
          template_id: { ...identifier, nullable: true },
          attachments: {
            type: 'array',
            items: schemaRef('AttachmentSummary'),
          },
          recipientStatusCounts: {
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 0 },
          },
        },
      },
    ],
  },
  CampaignCreateAccepted: {
    type: 'object',
    required: ['success', 'campaignId', 'recipientCount'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      campaignId: identifier,
      recipientCount: { type: 'integer', minimum: 1 },
      queuedJobs: { type: 'integer', minimum: 0 },
      status: schemaRef('CampaignStatus'),
    },
  },
  CampaignRecipient: {
    type: 'object',
    required: ['id', 'email', 'position', 'status'],
    properties: {
      id: identifier,
      email: { type: 'string', format: 'email' },
      payload: { type: 'object', additionalProperties: true },
      position: { type: 'integer', minimum: 0 },
      status: schemaRef('RecipientStatus'),
      sent_at: nullableDateTime,
      failed_at: nullableDateTime,
      suppressed_at: nullableDateTime,
      suppression_reason: { type: 'string', nullable: true },
      last_error: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  DeliveryAttempt: {
    type: 'object',
    required: ['id', 'attempt_number', 'status', 'started_at'],
    properties: {
      id: identifier,
      attempt_number: { type: 'integer', minimum: 1 },
      status: {
        type: 'string',
        enum: ['processing', 'sent', 'failed'],
      },
      provider_message_id: { type: 'string', nullable: true },
      error_message: { type: 'string', nullable: true },
      started_at: { type: 'string', format: 'date-time' },
      finished_at: nullableDateTime,
    },
  },
  RecipientAttempts: {
    allOf: [
      schemaRef('CampaignRecipient'),
      {
        type: 'object',
        properties: {
          deliveryAttempts: {
            type: 'array',
            items: schemaRef('DeliveryAttempt'),
          },
        },
      },
    ],
  },
  CampaignLifecycleResult: {
    type: 'object',
    required: ['success', 'campaignId', 'previousStatus', 'status'],
    properties: {
      success: { type: 'boolean' },
      campaignId: identifier,
      previousStatus: schemaRef('CampaignStatus'),
      status: schemaRef('CampaignStatus'),
      affectedRecipients: { type: 'integer', minimum: 0 },
      queuedRecipients: { type: 'integer', minimum: 0 },
      queueCleanup: { type: 'object', nullable: true, additionalProperties: true },
    },
  },
  CampaignEvent: {
    type: 'object',
    required: ['id', 'type', 'created_at'],
    properties: {
      id: identifier,
      type: { type: 'string' },
      actor_user_id: { ...identifier, nullable: true },
      from_status: { type: 'string', nullable: true },
      to_status: { type: 'string', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  Template: {
    type: 'object',
    required: ['id', 'name', 'subject', 'html_content', 'created_at'],
    properties: {
      id: identifier,
      name: { type: 'string' },
      subject: { type: 'string' },
      html_content: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
      user_id: identifier,
    },
  },
  TemplateInput: {
    type: 'object',
    required: ['name', 'subject', 'html_content'],
    properties: {
      name: { type: 'string', minLength: 1 },
      subject: { type: 'string', minLength: 1 },
      html_content: { type: 'string', minLength: 1 },
    },
  },
  AttachmentSummary: {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: identifier,
      name: { type: 'string' },
      s3_path: { type: 'string', format: 'uri' },
      uploaded_at: { type: 'string', format: 'date-time' },
      campaignCount: { type: 'integer', minimum: 0 },
    },
  },
  AttachmentDeleteResult: {
    type: 'object',
    required: ['id', 'deleted', 'storageDeleted'],
    properties: {
      id: identifier,
      deleted: { type: 'boolean' },
      storageDeleted: { type: 'boolean' },
    },
  },
  SuppressionReason: {
    type: 'string',
    enum: ['manual', 'unsubscribe', 'hard_bounce', 'complaint'],
  },
  SuppressionEntry: {
    type: 'object',
    required: ['id', 'email', 'reason', 'source', 'created_at'],
    properties: {
      id: identifier,
      email: { type: 'string', format: 'email' },
      reason: schemaRef('SuppressionReason'),
      source: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      removed_at: nullableDateTime,
    },
  },
  SuppressionInput: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
      reason: schemaRef('SuppressionReason'),
      source: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
    },
  },
  SuppressionBatchInput: {
    type: 'object',
    required: ['emails'],
    properties: {
      emails: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        uniqueItems: true,
        items: { type: 'string', format: 'email' },
      },
      reason: schemaRef('SuppressionReason'),
      source: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
    },
  },
  UnsubscribePreview: {
    type: 'object',
    required: ['email', 'campaignId', 'alreadyUnsubscribed'],
    properties: {
      email: { type: 'string', description: 'Masked recipient address.' },
      campaignId: identifier,
      alreadyUnsubscribed: { type: 'boolean' },
    },
  },
  UnsubscribeConfirmation: {
    type: 'object',
    required: ['success', 'alreadyUnsubscribed'],
    properties: {
      success: { type: 'boolean' },
      alreadyUnsubscribed: { type: 'boolean' },
      queueJobRemoved: { type: 'boolean' },
    },
  },
  AnalyticsRange: {
    type: 'object',
    required: ['from', 'to', 'days'],
    properties: {
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      days: { type: 'integer', minimum: 1, maximum: 366 },
    },
  },
  OutcomeMetrics: {
    type: 'object',
    required: [
      'total',
      'sent',
      'failed',
      'cancelled',
      'suppressed',
      'processed',
      'pending',
      'progressPercent',
      'countersConsistent',
    ],
    properties: {
      total: { type: 'integer', minimum: 0 },
      sent: { type: 'integer', minimum: 0 },
      failed: { type: 'integer', minimum: 0 },
      cancelled: { type: 'integer', minimum: 0 },
      suppressed: { type: 'integer', minimum: 0 },
      processed: { type: 'integer', minimum: 0 },
      pending: { type: 'integer', minimum: 0 },
      progressPercent: { type: 'number', minimum: 0 },
      acceptedRate: { type: 'number', minimum: 0 },
      failureRate: { type: 'number', minimum: 0 },
      suppressionRate: { type: 'number', minimum: 0 },
      cancellationRate: { type: 'number', minimum: 0 },
      countersConsistent: { type: 'boolean' },
    },
  },
  OutcomeBucket: {
    type: 'object',
    required: ['timestamp', 'sent', 'failed', 'cancelled', 'suppressed', 'total'],
    properties: {
      timestamp: { type: 'string' },
      sent: { type: 'integer', minimum: 0 },
      failed: { type: 'integer', minimum: 0 },
      cancelled: { type: 'integer', minimum: 0 },
      suppressed: { type: 'integer', minimum: 0 },
      total: { type: 'integer', minimum: 0 },
    },
  },
  CampaignAnalytics: {
    type: 'object',
    required: ['campaign', 'range', 'dailyOutcomes'],
    properties: {
      campaign: {
        type: 'object',
        properties: {
          id: identifier,
          name: { type: 'string' },
          status: schemaRef('CampaignStatus'),
          metrics: schemaRef('OutcomeMetrics'),
          health: {
            type: 'object',
            properties: {
              level: { type: 'string', enum: ['healthy', 'warning', 'critical', 'unknown'] },
              reason: { type: 'string' },
            },
          },
        },
      },
      range: schemaRef('AnalyticsRange'),
      velocity: {
        type: 'object',
        properties: {
          processedPerMinute: { type: 'number', minimum: 0 },
          estimatedCompletionAt: nullableDateTime,
        },
      },
      recipientStatusCounts: { type: 'object', additionalProperties: { type: 'integer' } },
      providerEventCounts: { type: 'object', additionalProperties: { type: 'integer' } },
      dailyOutcomes: { type: 'array', items: schemaRef('OutcomeBucket') },
      failureReasons: { type: 'array', items: schemaRef('FailureReason') },
    },
  },
  FailureReason: {
    type: 'object',
    required: ['reason', 'count'],
    properties: {
      reason: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
    },
  },
  QueueInspection: {
    type: 'object',
    required: ['inspected', 'existing', 'missing', 'unknown'],
    properties: {
      inspected: { type: 'integer', minimum: 0 },
      existing: { type: 'integer', minimum: 0 },
      missing: { type: 'integer', minimum: 0 },
      unknown: { type: 'integer', minimum: 0 },
      stateCounts: { type: 'object', additionalProperties: { type: 'integer' } },
      missingRecipients: { type: 'array', items: identifier },
      unknownRecipients: { type: 'array', items: identifier },
    },
  },
  IntegrityInspection: {
    type: 'object',
    required: ['campaign', 'expectedCounters', 'queueInspection', 'findings', 'healthy'],
    properties: {
      campaign: {
        type: 'object',
        properties: {
          id: identifier,
          name: { type: 'string' },
          status: schemaRef('CampaignStatus'),
        },
      },
      expectedCounters: schemaRef('CampaignCounters'),
      queueInspection: schemaRef('QueueInspection'),
      findings: { type: 'object', additionalProperties: true },
      healthy: { type: 'boolean' },
    },
  },
  ReconciliationResult: {
    type: 'object',
    required: ['dryRun', 'repaired', 'actions', 'inspection'],
    properties: {
      dryRun: { type: 'boolean' },
      repaired: { type: 'boolean' },
      actions: {
        type: 'object',
        properties: {
          updateCounters: { type: 'boolean' },
          updateStatus: { type: 'boolean' },
          requeueRecipients: { type: 'boolean' },
        },
      },
      inspection: schemaRef('IntegrityInspection'),
      queueRepair: { type: 'object', nullable: true, additionalProperties: true },
    },
  },
  HealthCheck: {
    type: 'object',
    required: ['name', 'status', 'latencyMs'],
    properties: {
      name: { type: 'string' },
      status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
      latencyMs: { type: 'number', minimum: 0 },
      critical: { type: 'boolean' },
      details: { type: 'object', additionalProperties: true },
      error: { type: 'string' },
      code: { type: 'string' },
    },
  },
  HealthReport: {
    type: 'object',
    required: ['status', 'ready', 'checkedAt', 'checks'],
    properties: {
      status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
      ready: { type: 'boolean' },
      checkedAt: { type: 'string', format: 'date-time' },
      checks: { type: 'array', items: schemaRef('HealthCheck') },
      runtime: { type: 'object', additionalProperties: true },
    },
  },
  DeliveryWebhookEvent: {
    type: 'object',
    required: ['eventId', 'messageId', 'type', 'email', 'occurredAt'],
    properties: {
      eventId: { type: 'string', maxLength: 200 },
      messageId: { type: 'string', maxLength: 500 },
      type: {
        type: 'string',
        enum: ['delivered', 'soft_bounce', 'hard_bounce', 'complaint'],
      },
      email: { type: 'string', format: 'email' },
      occurredAt: { type: 'string', format: 'date-time' },
      diagnostic: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
    },
  },
  ContactInput: {
    type: 'object',
    required: ['email', 'message'],
    properties: {
      email: { type: 'string', format: 'email' },
      message: { type: 'string', minLength: 10 },
    },
  },
  DeliveryQuota: {
    type: 'object',
    properties: {
      usage: {
        type: 'object',
        properties: {
          minute: { type: 'integer', minimum: 0 },
          day: { type: 'integer', minimum: 0 },
        },
      },
      remaining: {
        type: 'object',
        properties: {
          minute: { type: 'integer', minimum: 0 },
          day: { type: 'integer', minimum: 0 },
        },
      },
      limits: {
        type: 'object',
        properties: {
          minute: { type: 'integer', minimum: 1 },
          day: { type: 'integer', minimum: 1 },
        },
      },
      resetsAt: {
        type: 'object',
        properties: {
          minute: { type: 'string', format: 'date-time' },
          day: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};
