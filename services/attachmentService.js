import path from 'node:path';

export const ATTACHMENT_LIMITS = Object.freeze({
  maximumFilesPerUser: 3,
  maximumFileBytes: 5 * 1024 * 1024,
  maximumNameLength: 180,
});

export const ATTACHMENT_TYPES = Object.freeze({
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-powerpoint': ['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/bmp': ['.bmp'],
  'image/webp': ['.webp'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'application/zip': ['.zip'],
  'application/x-rar-compressed': ['.rar'],
});

export class AttachmentServiceError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'AttachmentServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function positiveInteger(value, fallback, maximum, field) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AttachmentServiceError(
      'INVALID_ATTACHMENT_PAGINATION',
      `${field} must be an integer between 1 and ${maximum}`,
    );
  }
  return parsed;
}

export function parseAttachmentPagination(query = {}) {
  return {
    page: positiveInteger(query.page, 1, 1_000_000, 'page'),
    limit: positiveInteger(query.limit, 20, 100, 'limit'),
  };
}

export function sanitizeAttachmentName(value) {
  if (typeof value !== 'string') {
    throw new AttachmentServiceError('INVALID_ATTACHMENT_NAME', 'Attachment name is required');
  }
  const basename = path.basename(value.replaceAll('\\', '/'));
  const normalized = basename
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (!normalized) {
    throw new AttachmentServiceError('INVALID_ATTACHMENT_NAME', 'Attachment name is empty');
  }
  if (normalized.length > ATTACHMENT_LIMITS.maximumNameLength) {
    throw new AttachmentServiceError(
      'ATTACHMENT_NAME_TOO_LONG',
      `Attachment names cannot exceed ${ATTACHMENT_LIMITS.maximumNameLength} characters`,
    );
  }
  return normalized;
}

function hasSignature(buffer, signature, offset = 0) {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

export function detectAttachmentSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return 'empty';
  if (hasSignature(buffer, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (hasSignature(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (hasSignature(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (hasSignature(buffer, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (hasSignature(buffer, [0x42, 0x4d])) return 'bmp';
  if (hasSignature(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.subarray(8, 12).toString() === 'WEBP') {
    return 'webp';
  }
  if (hasSignature(buffer, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (hasSignature(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (hasSignature(buffer, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  const sample = buffer.subarray(0, Math.min(buffer.length, 4_096));
  if (!sample.includes(0)) return 'text';
  return 'unknown';
}

function expectedSignatures(mimetype) {
  if (mimetype === 'application/pdf') return ['pdf'];
  if (mimetype === 'image/jpeg') return ['jpeg'];
  if (mimetype === 'image/png') return ['png'];
  if (mimetype === 'image/gif') return ['gif'];
  if (mimetype === 'image/bmp') return ['bmp'];
  if (mimetype === 'image/webp') return ['webp'];
  if (['text/plain', 'text/csv'].includes(mimetype)) return ['text'];
  if (mimetype === 'application/zip') return ['zip'];
  if (mimetype === 'application/x-rar-compressed') return ['rar'];
  if (mimetype.includes('openxmlformats')) return ['zip'];
  if (mimetype.startsWith('application/vnd.ms-') || mimetype === 'application/msword') {
    return ['ole'];
  }
  return [];
}

export function validateAttachmentFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new AttachmentServiceError('ATTACHMENT_REQUIRED', 'Choose a file to upload');
  }
  if (!file.buffer.length) {
    throw new AttachmentServiceError('ATTACHMENT_EMPTY', 'The uploaded file is empty');
  }
  if (file.buffer.length > ATTACHMENT_LIMITS.maximumFileBytes) {
    throw new AttachmentServiceError(
      'ATTACHMENT_TOO_LARGE',
      `Attachments cannot exceed ${ATTACHMENT_LIMITS.maximumFileBytes} bytes`,
      413,
    );
  }
  const name = sanitizeAttachmentName(file.originalname);
  const mimetype = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase() : '';
  const extensions = ATTACHMENT_TYPES[mimetype];
  if (!extensions) {
    throw new AttachmentServiceError(
      'ATTACHMENT_TYPE_NOT_ALLOWED',
      'This attachment type is not allowed',
      415,
      { mimetype },
    );
  }
  const extension = path.extname(name).toLowerCase();
  if (!extensions.includes(extension)) {
    throw new AttachmentServiceError(
      'ATTACHMENT_EXTENSION_MISMATCH',
      'The filename extension does not match its content type',
      415,
      { mimetype, extension, allowedExtensions: extensions },
    );
  }
  const signature = detectAttachmentSignature(file.buffer);
  if (!expectedSignatures(mimetype).includes(signature)) {
    throw new AttachmentServiceError(
      'ATTACHMENT_CONTENT_MISMATCH',
      'The file content does not match its declared type',
      415,
      { mimetype, detected: signature },
    );
  }
  return { name, mimetype, size: file.buffer.length, buffer: file.buffer };
}

export async function listAttachments({ prisma, userId, query = {} }) {
  const { page, limit } = parseAttachmentPagination(query);
  const where = { user_id: userId };
  const [total, attachments] = await prisma.$transaction([
    prisma.resume.count({ where }),
    prisma.resume.findMany({
      where,
      orderBy: [{ uploaded_at: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        s3_path: true,
        uploaded_at: true,
        _count: { select: { CampaignResume: true } },
      },
    }),
  ]);
  return {
    attachments: attachments.map(({ _count, ...attachment }) => ({
      ...attachment,
      campaignCount: _count.CampaignResume,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function createAttachment({
  prisma,
  storage,
  userId,
  file,
  maximumFiles = ATTACHMENT_LIMITS.maximumFilesPerUser,
}) {
  const validated = validateAttachmentFile(file);
  const currentCount = await prisma.resume.count({ where: { user_id: userId } });
  if (currentCount >= maximumFiles) {
    throw new AttachmentServiceError(
      'ATTACHMENT_LIMIT_REACHED',
      `A user can store at most ${maximumFiles} attachments`,
      409,
      { maximumFiles },
    );
  }

  let objectUrl;
  try {
    objectUrl = await storage.upload({
      buffer: validated.buffer,
      name: validated.name,
      mimetype: validated.mimetype,
    });
  } catch (error) {
    throw new AttachmentServiceError(
      'ATTACHMENT_STORAGE_FAILED',
      'The attachment could not be stored',
      503,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  try {
    return await prisma.$transaction(async (transaction) => {
      const count = await transaction.resume.count({ where: { user_id: userId } });
      if (count >= maximumFiles) {
        throw new AttachmentServiceError(
          'ATTACHMENT_LIMIT_REACHED',
          `A user can store at most ${maximumFiles} attachments`,
          409,
          { maximumFiles },
        );
      }
      return transaction.resume.create({
        data: { user_id: userId, name: validated.name, s3_path: objectUrl },
        select: { id: true, name: true, s3_path: true, uploaded_at: true },
      });
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    try {
      await storage.delete(objectUrl);
    } catch (cleanupError) {
      console.error('ATTACHMENT UPLOAD CLEANUP ERROR:', cleanupError);
    }
    if (error instanceof AttachmentServiceError) throw error;
    throw new AttachmentServiceError(
      'ATTACHMENT_DATABASE_FAILED',
      'The attachment metadata could not be saved',
      503,
    );
  }
}

export async function deleteAttachment({ prisma, storage, userId, attachmentId }) {
  const attachment = await prisma.resume.findFirst({
    where: { id: attachmentId, user_id: userId },
    select: {
      id: true,
      name: true,
      s3_path: true,
      _count: { select: { CampaignResume: true } },
    },
  });
  if (!attachment) {
    throw new AttachmentServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found', 404);
  }
  if (attachment._count.CampaignResume > 0) {
    throw new AttachmentServiceError(
      'ATTACHMENT_IN_USE',
      'Remove the attachment from its campaigns before deleting it',
      409,
      { campaignCount: attachment._count.CampaignResume },
    );
  }

  const deleted = await prisma.resume.deleteMany({
    where: { id: attachment.id, user_id: userId },
  });
  if (!deleted.count) {
    throw new AttachmentServiceError(
      'ATTACHMENT_CHANGED',
      'The attachment changed while it was being deleted',
      409,
    );
  }
  try {
    await storage.delete(attachment.s3_path);
    return { id: attachment.id, deleted: true, storageDeleted: true };
  } catch (error) {
    console.error('ATTACHMENT STORAGE DELETE ERROR:', error);
    return { id: attachment.id, deleted: true, storageDeleted: false };
  }
}
