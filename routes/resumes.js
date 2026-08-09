import express from 'express';
import multer from 'multer';
import prisma from '../prisma/prismaClient.js';
import { authenticateJWT } from '../middleware/auth.js';
import { uploadAttachmentToS3, deleteAttachmentFromS3 } from '../utils/s3.js';
import {
  ATTACHMENT_LIMITS,
  AttachmentServiceError,
  createAttachment,
  deleteAttachment,
  listAttachments,
} from '../services/attachmentService.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_LIMITS.maximumFileBytes, files: 1 },
});

const storage = {
  upload: ({ buffer, name, mimetype }) => uploadAttachmentToS3(buffer, name, mimetype),
  delete: (url) => deleteAttachmentFromS3(url),
};

function sendAttachmentError(res, error, fallback) {
  if (error instanceof AttachmentServiceError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
}

// List resumes
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const result = await listAttachments({ prisma, userId: req.user.id, query: req.query });
    res.json(result);
  } catch (error) {
    sendAttachmentError(res, error, 'Failed to list attachments');
  }
});

// Upload resume
router.post('/', authenticateJWT, upload.single('file'), async (req, res) => {
  try {
    const attachment = await createAttachment({
      prisma,
      storage,
      userId: req.user.id,
      file: req.file,
    });
    res.status(201).json({ attachment });
  } catch (error) {
    sendAttachmentError(res, error, 'Failed to upload attachment');
  }
});

// Delete resume
router.delete('/:id', authenticateJWT, async (req, res) => {
  try {
    const result = await deleteAttachment({
      prisma,
      storage,
      userId: req.user.id,
      attachmentId: req.params.id,
    });
    res.json(result);
  } catch (error) {
    sendAttachmentError(res, error, 'Failed to delete attachment');
  }
});

router.use((error, _req, res, _next) => {
  sendAttachmentError(res, error, 'Attachment request failed');
});

export default router;
