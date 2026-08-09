import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AttachmentServiceError,
  createAttachment,
  deleteAttachment,
  detectAttachmentSignature,
  listAttachments,
  sanitizeAttachmentName,
  validateAttachmentFile,
} from '../../services/attachmentService.js';

const pdf = Buffer.from('%PDF-1.7\nexample');

function pdfFile(overrides = {}) {
  return {
    buffer: pdf,
    originalname: 'resume.pdf',
    mimetype: 'application/pdf',
    ...overrides,
  };
}

test('sanitizeAttachmentName removes paths, controls, and unsafe leading dots', () => {
  assert.equal(sanitizeAttachmentName('../.\u0000 Resume  2026.pdf'), 'Resume 2026.pdf');
  assert.equal(sanitizeAttachmentName('folder\\cv.pdf'), 'cv.pdf');
});

test('detectAttachmentSignature recognizes supported binary formats', () => {
  assert.equal(detectAttachmentSignature(pdf), 'pdf');
  assert.equal(detectAttachmentSignature(Buffer.from([0xff, 0xd8, 0xff, 0x01])), 'jpeg');
  assert.equal(detectAttachmentSignature(Buffer.from('plain text')), 'text');
  assert.equal(detectAttachmentSignature(Buffer.from([0, 1, 2, 3])), 'unknown');
});

test('validateAttachmentFile verifies name, media type, extension, and bytes', () => {
  assert.deepEqual(validateAttachmentFile(pdfFile()), {
    name: 'resume.pdf',
    mimetype: 'application/pdf',
    size: pdf.length,
    buffer: pdf,
  });
  assert.throws(
    () => validateAttachmentFile(pdfFile({ originalname: 'resume.exe' })),
    (error) => error.code === 'ATTACHMENT_EXTENSION_MISMATCH',
  );
  assert.throws(
    () => validateAttachmentFile(pdfFile({ buffer: Buffer.from('not a pdf') })),
    (error) => error.code === 'ATTACHMENT_CONTENT_MISMATCH',
  );
});

test('listAttachments returns owner scoped pagination and campaign usage', async () => {
  let findArguments;
  const prisma = {
    resume: {
      count: async () => 1,
      findMany: async (args) => {
        findArguments = args;
        return [{
          id: 'attachment-1',
          name: 'resume.pdf',
          s3_path: 'https://storage/resume.pdf',
          uploaded_at: new Date(),
          _count: { CampaignResume: 2 },
        }];
      },
    },
    $transaction: (promises) => Promise.all(promises),
  };
  const result = await listAttachments({ prisma, userId: 'user-1', query: { limit: '10' } });
  assert.equal(findArguments.where.user_id, 'user-1');
  assert.equal(result.attachments[0].campaignCount, 2);
  assert.deepEqual(result.pagination, { page: 1, limit: 10, total: 1, pages: 1 });
});

test('createAttachment uploads then saves sanitized owner scoped metadata', async () => {
  let uploaded;
  let created;
  const storage = {
    upload: async (input) => { uploaded = input; return 'https://storage/object.pdf'; },
    delete: async () => {},
  };
  const transaction = {
    resume: {
      count: async () => 1,
      create: async ({ data }) => { created = data; return { id: 'attachment-1', ...data }; },
    },
  };
  const prisma = {
    resume: { count: async () => 1 },
    $transaction: async (operation) => operation(transaction),
  };
  const result = await createAttachment({
    prisma,
    storage,
    userId: 'user-1',
    file: pdfFile({ originalname: '../resume.pdf' }),
  });
  assert.equal(uploaded.name, 'resume.pdf');
  assert.equal(created.user_id, 'user-1');
  assert.equal(result.id, 'attachment-1');
});

test('createAttachment deletes the object when database persistence fails', async () => {
  const deleted = [];
  const prisma = {
    resume: { count: async () => 0 },
    $transaction: async () => { throw new Error('database offline'); },
  };
  await assert.rejects(
    createAttachment({
      prisma,
      storage: {
        upload: async () => 'https://storage/object.pdf',
        delete: async (url) => { deleted.push(url); },
      },
      userId: 'user-1',
      file: pdfFile(),
    }),
    (error) => error.code === 'ATTACHMENT_DATABASE_FAILED',
  );
  assert.deepEqual(deleted, ['https://storage/object.pdf']);
});

test('createAttachment enforces the per-user limit before storage', async () => {
  let uploads = 0;
  await assert.rejects(
    createAttachment({
      prisma: { resume: { count: async () => 3 } },
      storage: { upload: async () => { uploads += 1; } },
      userId: 'user-1',
      file: pdfFile(),
    }),
    (error) => error instanceof AttachmentServiceError && error.code === 'ATTACHMENT_LIMIT_REACHED',
  );
  assert.equal(uploads, 0);
});

test('deleteAttachment refuses to remove a file used by campaigns', async () => {
  const prisma = {
    resume: {
      findFirst: async () => ({
        id: 'attachment-1',
        s3_path: 'https://storage/object.pdf',
        _count: { CampaignResume: 2 },
      }),
    },
  };
  await assert.rejects(
    deleteAttachment({
      prisma,
      storage: {},
      userId: 'user-1',
      attachmentId: 'attachment-1',
    }),
    (error) => error.code === 'ATTACHMENT_IN_USE' && error.details.campaignCount === 2,
  );
});

test('deleteAttachment keeps database deletion successful when object cleanup fails', async () => {
  const prisma = {
    resume: {
      findFirst: async () => ({
        id: 'attachment-1',
        s3_path: 'https://storage/object.pdf',
        _count: { CampaignResume: 0 },
      }),
      deleteMany: async () => ({ count: 1 }),
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await deleteAttachment({
      prisma,
      storage: { delete: async () => { throw new Error('S3 offline'); } },
      userId: 'user-1',
      attachmentId: 'attachment-1',
    });
    assert.deepEqual(result, {
      id: 'attachment-1',
      deleted: true,
      storageDeleted: false,
    });
  } finally {
    console.error = originalError;
  }
});
