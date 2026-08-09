import express from 'express';
import multer from 'multer';
import prisma from '../prisma/prismaClient.js';
import { authenticateJWT } from '../middleware/auth.js';
import path from 'path';
import fs from 'fs';
import { uploadAttachmentToS3, deleteAttachmentFromS3 } from '../utils/s3.js';

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const allowed = [
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/webp',
  // Text
  'text/plain',
  'text/csv',
  // Archives
  'application/zip',
  'application/x-rar-compressed'
];
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only typical document, image, spreadsheet, or archive files are allowed.'));
  }
});

// List resumes
router.get('/', authenticateJWT, async (req, res) => {
  const user_id = req.user.id;
  const resumes = await prisma.resume.findMany({
    where: { user_id },
    orderBy: { uploaded_at: 'desc' }
  });
  res.json(resumes);
});

// Upload resume
router.post('/', authenticateJWT, upload.single('file'), async (req, res) => {
  const user_id = req.user.id;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded.' });

  const count = await prisma.resume.count({ where: { user_id } });
  if (count >= 3) {
    await fs.promises.unlink(file.path);
    return res.status(400).json({ error: 'Maximum 3 resumes allowed.' });
  }

  try {
    const fileBuffer = await fs.promises.readFile(file.path);
    const s3Url = await uploadAttachmentToS3(fileBuffer, file.originalname, file.mimetype);
    const resume = await prisma.resume.create({
      data: {
        user_id,
        name: file.originalname,
        s3_path: s3Url,
      }
    });
    res.json(resume);
  } finally {
    await fs.promises.unlink(file.path).catch(() => {});
  }
});

// Delete resume
router.delete('/:id', authenticateJWT, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;
  const resume = await prisma.resume.findUnique({ where: { id } });
  if (!resume || resume.user_id !== user_id) return res.status(404).json({ error: 'Not found' });

  try {
    await deleteAttachmentFromS3(resume.s3_path);
  } catch (err) {
    // Optionally log error, but continue to delete DB record
  }
  await prisma.resume.delete({ where: { id } });
  res.json({ success: true });
});

export default router;
