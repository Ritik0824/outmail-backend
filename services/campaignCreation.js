import { randomUUID } from 'node:crypto';
import { extractPlaceholders, fillPlaceholders } from '../domain/template.js';
import { parseRecipientFile, RecipientImportError } from './recipientImport.js';

export const DELIVERY_INTERVAL_MS = 2 * 60 * 1_000;
export const DELIVERY_ATTEMPTS = 3;

export class CampaignCreationError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'CampaignCreationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requiredText(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CampaignCreationError(
      'INVALID_CAMPAIGN',
      `${fieldName} is required`,
      { details: { field: fieldName } },
    );
  }
  return value.trim();
}

export function parseAttachmentIds(value) {
  if (value == null || value === '') return [];

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new CampaignCreationError(
        'INVALID_ATTACHMENTS',
        'attachmentIds must be a JSON array of resume IDs',
      );
    }
  }

  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new CampaignCreationError(
      'INVALID_ATTACHMENTS',
      'attachmentIds must contain only resume IDs',
    );
  }

  return [...new Set(parsed.map((id) => id.trim()))];
}

export function parseScheduledStart(value) {
  const scheduledStart = new Date(value);
  if (!value || Number.isNaN(scheduledStart.getTime())) {
    throw new CampaignCreationError(
      'INVALID_START_TIME',
      'startTime must be a valid date and time',
    );
  }
  return scheduledStart;
}

export function recipientJobId(recipientId) {
  return `campaign-recipient-${recipientId}`;
}

export function buildRecipientJobs({
  campaign,
  userId,
  recipients,
  templateId,
  resumeIds,
  subject,
  body,
  now = Date.now(),
  intervalMs = DELIVERY_INTERVAL_MS,
}) {
  const scheduledAt = campaign.scheduled_start.getTime();

  return recipients.map((recipient) => ({
    name: 'sendEmail',
    data: {
      campaignId: campaign.id,
      userId,
      recipientId: recipient.id,
      recipient: recipient.payload,
      templateId,
      resumeIds,
      subject: fillPlaceholders(subject, recipient.payload),
      body: fillPlaceholders(body, recipient.payload),
    },
    opts: {
      jobId: recipient.queue_job_id,
      delay: Math.max(0, scheduledAt + (recipient.position * intervalMs) - now),
      attempts: DELIVERY_ATTEMPTS,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    },
  }));
}

async function loadTemplate({ prisma, templateId, userId, subject, body }) {
  if (!templateId) {
    return {
      subject: requiredText(subject, 'subject'),
      body: requiredText(body, 'body'),
    };
  }

  const template = await prisma.emailTemplate.findFirst({
    where: { id: templateId, user_id: userId },
  });
  if (!template) {
    throw new CampaignCreationError('TEMPLATE_NOT_FOUND', 'Email template not found');
  }

  return {
    subject: typeof subject === 'string' && subject.trim() ? subject.trim() : template.subject,
    body: typeof body === 'string' && body.trim() ? body : template.html_content,
  };
}

async function verifyOwnedResumes({ prisma, resumeIds, userId }) {
  if (!resumeIds.length) return;
  const ownedResumes = await prisma.resume.findMany({
    where: { id: { in: resumeIds }, user_id: userId },
    select: { id: true },
  });
  if (ownedResumes.length !== resumeIds.length) {
    throw new CampaignCreationError(
      'ATTACHMENT_NOT_FOUND',
      'One or more attachments were not found',
    );
  }
}

async function persistCampaign({
  prisma,
  ids,
  userId,
  file,
  fileUrl,
  scheduledStart,
  templateId,
  resumeIds,
  recipients,
  campaignName,
  timezone,
  subject,
  body,
}) {
  return prisma.$transaction(async (transaction) => {
    await transaction.csvUpload.create({
      data: {
        id: ids.csvUploadId,
        s3_path: fileUrl,
        original_filename: file.originalname,
        user_id: userId,
      },
    });

    const campaign = await transaction.campaign.create({
      data: {
        id: ids.campaignId,
        user_id: userId,
        csv_upload_id: ids.csvUploadId,
        template_id: templateId,
        name: campaignName,
        subject,
        body,
        status: 'scheduled',
        scheduled_start: scheduledStart,
        timezone,
        total_emails: recipients.length,
        sent_emails: 0,
        failed_emails: 0,
      },
    });

    if (resumeIds.length) {
      await transaction.campaignResume.createMany({
        data: resumeIds.map((resumeId) => ({
          campaignId: campaign.id,
          resumeId,
        })),
      });
    }

    await transaction.campaignRecipient.createMany({
      data: recipients.map((recipient) => ({
        id: recipient.id,
        campaign_id: campaign.id,
        email: recipient.email,
        payload: recipient.payload,
        position: recipient.position,
        status: 'pending',
        queue_job_id: recipient.queue_job_id,
      })),
    });

    return campaign;
  });
}

export async function createAndQueueCampaign({
  prisma,
  queue,
  uploadRecipientFile,
  deleteRecipientFile,
  userId,
  file,
  input,
  idFactory = randomUUID,
  now = Date.now(),
}) {
  if (!file?.buffer?.length) {
    throw new CampaignCreationError('FILE_REQUIRED', 'CSV/XLSX file required');
  }

  const campaignName = requiredText(input.campaignName, 'campaignName');
  const timezone = requiredText(input.timezone, 'timezone');
  const templateId = input.templateId && !['null', ''].includes(input.templateId)
    ? input.templateId
    : null;
  const resumeIds = parseAttachmentIds(input.attachmentIds);
  const scheduledStart = parseScheduledStart(input.startTime);
  const template = await loadTemplate({
    prisma,
    templateId,
    userId,
    subject: input.subject,
    body: input.body,
  });
  await verifyOwnedResumes({ prisma, resumeIds, userId });

  const requiredFields = [...extractPlaceholders(template.subject, template.body), 'email'];
  let imported;
  try {
    imported = await parseRecipientFile({
      buffer: file.buffer,
      fileName: file.originalname,
      requiredFields,
    });
  } catch (error) {
    if (error instanceof RecipientImportError) {
      throw new CampaignCreationError(error.code, error.message, { details: error.details });
    }
    throw error;
  }

  const ids = { csvUploadId: idFactory(), campaignId: idFactory() };
  const recipients = imported.recipients.map((recipient) => {
    const id = idFactory();
    return { ...recipient, id, queue_job_id: recipientJobId(id) };
  });

  const fileUrl = await uploadRecipientFile(
    file.buffer,
    file.originalname,
    file.mimetype,
  );

  let campaign;
  try {
    campaign = await persistCampaign({
      prisma,
      ids,
      userId,
      file,
      fileUrl,
      scheduledStart,
      templateId,
      resumeIds,
      recipients,
      campaignName,
      timezone,
      subject: template.subject,
      body: template.body,
    });
  } catch (error) {
    try {
      await deleteRecipientFile(fileUrl);
    } catch (cleanupError) {
      console.error('CAMPAIGN FILE CLEANUP ERROR:', cleanupError);
    }
    throw error;
  }

  const jobs = buildRecipientJobs({
    campaign,
    userId,
    recipients,
    templateId,
    resumeIds,
    subject: template.subject,
    body: template.body,
    now,
  });

  try {
    await queue.addBulk(jobs);
  } catch {
    try {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'queue_failed' },
      });
    } catch (statusError) {
      console.error('CAMPAIGN QUEUE STATUS ERROR:', statusError);
    }
    throw new CampaignCreationError(
      'QUEUE_FAILED',
      'Campaign was saved, but its delivery jobs could not be queued',
      { status: 503, details: { campaignId: campaign.id } },
    );
  }

  try {
    await prisma.campaignRecipient.updateMany({
      where: { campaign_id: campaign.id, status: 'pending' },
      data: { status: 'queued' },
    });
  } catch {
    try {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'queue_state_unknown' },
      });
    } catch (statusError) {
      console.error('CAMPAIGN QUEUE STATUS ERROR:', statusError);
    }
    throw new CampaignCreationError(
      'QUEUE_STATE_FAILED',
      'Delivery jobs were queued, but their database status could not be updated',
      { status: 503, details: { campaignId: campaign.id } },
    );
  }

  return {
    campaignId: campaign.id,
    status: campaign.status,
    totalRecipients: recipients.length,
  };
}
