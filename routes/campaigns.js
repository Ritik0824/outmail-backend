import express from 'express';
import prisma from '../prisma/prismaClient.js';
import multer from 'multer';
import { authenticateJWT } from '../middleware/auth.js';
import { emailQueue } from '../queue/emailQueue.js'; // BullMQ queue instance
import csvParser from 'csv-parser';
import fs from 'fs';
import { uploadCsvToS3 } from '../utils/s3.js';
import fsPromises from 'fs/promises';
import readXlsxFile from 'read-excel-file/node';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// Utility to extract placeholders from template string (e.g. {{name}})
function extractPlaceholders(template) {
  if (!template) return [];
  // This regex matches {{placeholder}} or {{ placeholder }}
  const regex = /{{\s*([a-zA-Z0-9_ .-]+)\s*}}/g;
  const placeholders = new Set();
  let match;
  while ((match = regex.exec(template))) {
    placeholders.add(match[1].trim().toLowerCase());
  }
  return Array.from(placeholders);
}

function fillPlaceholders(template, data) {
  if (!template) return '';
  return template.replace(/{{\s*([a-zA-Z0-9_ .-]+)\s*}}/g, (_, key) => {
    const value = data[key.trim().toLowerCase()];
    return value !== undefined ? value : '';
  });
}

router.get('/mine', authenticateJWT, async (req, res) => {
  const userId = req.user.id;

  try {
    const campaigns = await prisma.campaign.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        created_at: true,
        started_at: true,
        completed_at: true,
        total_emails: true,
        sent_emails: true,
        failed_emails: true,
      },
    });
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

/**
 * POST /api/campaigns/start
 * Handles campaign creation, CSV upload, DB population, and queueing email jobs.
 */
router.post(
  '/start',
  authenticateJWT,
  upload.single('csv'),
  async (req, res) => {
    let csvFile;
    try {
      const userId = req.user.id;
      const {
        templateId,
        attachmentIds,
        subject,
        body,
        startTime,
        timezone,
        campaignName,
      } = req.body;

      // 1. Upload CSV/XLSX to S3
      csvFile = req.file;
      if (!csvFile) {
        return res.status(400).json({ error: 'CSV/XLSX file required.' });
      }

      const fileBuffer = await fsPromises.readFile(csvFile.path);

      // 3. Fetch template if templateId is provided, else use manual subject/body
      let template = null;
      let templateSubject = subject;
      let templateBody = body;
      if (templateId && templateId !== '' && templateId !== 'null') {
        template = await prisma.emailTemplate.findFirst({
          where: { id: templateId, user_id: userId },
        });
        if (!template) {
          throw new Error('Email template not found');
        }
        templateSubject = subject || template.subject;
        templateBody = body || template.html_content;
      }

      // 4. Extract placeholders from subject and body, always include 'email'
      const placeholders = [
        ...new Set([
          ...extractPlaceholders(templateSubject),
          ...extractPlaceholders(templateBody),
          'email'
        ])
      ].map(ph => ph.trim().toLowerCase());

      const requestedResumeIds = Array.isArray(attachmentIds)
        ? attachmentIds
        : JSON.parse(attachmentIds || '[]');
      const resumeIds = [...new Set(requestedResumeIds)];
      const ownedResumes = resumeIds.length
        ? await prisma.resume.findMany({
            where: { id: { in: resumeIds }, user_id: userId },
            select: { id: true },
          })
        : [];
      if (ownedResumes.length !== resumeIds.length) {
        throw new Error('One or more attachments were not found');
      }

      // 1. Upload file to S3 and create CsvUpload entry
      const s3Url = await uploadCsvToS3(fileBuffer, csvFile.originalname, csvFile.mimetype);

      const csvUpload = await prisma.csvUpload.create({
        data: {
          s3_path: s3Url,
          original_filename: csvFile.originalname,
          user_id: userId,
        },
      });

      // 2. Now create the campaign using csvUpload.id
      const campaign = await prisma.campaign.create({
        data: {
          user_id: userId,
          csv_upload_id: csvUpload.id,
          template_id: templateId && templateId !== '' && templateId !== 'null' ? templateId : null,
          name: campaignName,
          status: 'scheduled',
          scheduled_start: new Date(startTime),
          timezone,
          total_emails: 0,
          sent_emails: 0,
          failed_emails: 0,
        },
      });

      // 6. Link attachments (resumes) to campaign
      for (const resumeId of resumeIds) {
        await prisma.campaignResume.create({
          data: {
            campaignId: campaign.id,
            resumeId,
          },
        });
      }

      // 7. Parse file and enqueue jobs
      const recipients = [];
      let headersChecked = false;
      let missingPlaceholders = [];

      const fileExt = csvFile.originalname.split('.').pop().toLowerCase();

      if (fileExt === 'csv') {
        // CSV logic (streaming)
        await new Promise((resolve, reject) => {
          fs.createReadStream(csvFile.path)
            .pipe(csvParser())
            .on('headers', (headers) => {
              const csvHeaders = headers.map(h => h.trim().toLowerCase());
              missingPlaceholders = placeholders.filter(ph => !csvHeaders.includes(ph));
              headersChecked = true;
              if (missingPlaceholders.length > 0) {
                reject(
                  new Error(
                    `Missing placeholders in CSV: ${missingPlaceholders.join(', ')}`
                  )
                );
              }
            })
            .on('data', async (row) => {
              if (!headersChecked || missingPlaceholders.length > 0) return;
              const rowData = {};
              Object.keys(row).forEach(k => {
                rowData[k.trim().toLowerCase()] = row[k];
              });
              const recipientData = {};
              placeholders.forEach(ph => {
                recipientData[ph] = rowData[ph] || '';
              });
              if (recipientData.email) {
                recipients.push(recipientData);
                const delay = new Date(startTime).getTime() + (recipients.length * 2 * 60 * 1000) - Date.now();
                await emailQueue.add('sendEmail', {
                  campaignId: campaign.id,
                  userId,
                  recipient: recipientData,
                  templateId: templateId && templateId !== '' && templateId !== 'null' ? templateId : null,
                  resumeIds,
                  subject: fillPlaceholders(templateSubject, recipientData),
                  body: fillPlaceholders(templateBody, recipientData),
                }, { delay });
              }
            })
            .on('end', resolve)
            .on('error', reject);
        });
      } else if (fileExt === 'xlsx') {
        const rows = await readXlsxFile(fileBuffer);

        if (rows.length < 2) {
          throw new Error('XLSX file is empty');
        }
        const xlsxHeaders = rows[0].map((header) => String(header ?? '').trim().toLowerCase());
        missingPlaceholders = placeholders.filter(ph => !xlsxHeaders.includes(ph));
        if (missingPlaceholders.length > 0) {
          throw new Error(
            `Missing placeholders in XLSX: ${missingPlaceholders.join(', ')}`
          );
        }

        for (const [i, row] of rows.slice(1).entries()) {
          const rowData = Object.fromEntries(
            xlsxHeaders.map((header, columnIndex) => [header, String(row[columnIndex] ?? '')]),
          );
          const recipientData = {};
          placeholders.forEach(ph => {
            recipientData[ph] = rowData[ph] || '';
          });
          if (recipientData.email) {
            recipients.push(recipientData);
            const delay = new Date(startTime).getTime() + (i * 2 * 60 * 1000) - Date.now();
            await emailQueue.add('sendEmail', {
              campaignId: campaign.id,
              userId,
              recipient: recipientData,
              templateId: templateId && templateId !== '' && templateId !== 'null' ? templateId : null,
              resumeIds,
              subject: fillPlaceholders(templateSubject, recipientData),
              body: fillPlaceholders(templateBody, recipientData),
            }, { delay });
          }
        }
      } else {
        throw new Error('Unsupported file type. Please upload a .csv or .xlsx file.');
      }

      // 8. Update campaign with total_emails
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { total_emails: recipients.length },
      });

      // 9. Delete local file
      await fsPromises.unlink(csvFile.path);

      res.json({
        success: true,
        campaignId: campaign.id,
        totalRecipients: recipients.length,
      });
    } catch (err) {
      // Clean up local file on error
      if (csvFile && csvFile.path) {
        try { await fsPromises.unlink(csvFile.path); } catch {}
      }
      console.error('CAMPAIGN START ERROR:', err); 
      if (err.message && err.message.startsWith('Missing placeholders')) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message && err.message === 'Email template not found') {
        return res.status(400).json({ error: err.message });
      }
      if (err.message && err.message === 'One or more attachments were not found') {
        return res.status(400).json({ error: err.message });
      }
      if (err.message && err.message.startsWith('Unsupported file type')) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message && err.message === 'XLSX file is empty') {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: 'Failed to start campaign.' });
    }
  }
);

export default router;
