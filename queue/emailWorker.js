import { Worker } from 'bullmq';
import sendEmailWithGmail from '../utils/sendEmailWithGmail.js';
import { canSendEmail, incrementEmailCount } from '../utils/rateLimit.js';
import { createRedisConnection } from './redisConnection.js';

export function createEmailWorker({
  prisma,
  connection = createRedisConnection(),
  sendEmail = sendEmailWithGmail,
  checkRateLimit = canSendEmail,
  recordEmailCount = incrementEmailCount,
} = {}) {
  if (!prisma) {
    throw new Error('createEmailWorker requires a Prisma client');
  }

  const worker = new Worker('emailQueue', async (job) => {
    const {
      campaignId,
      userId,
      recipient,
      templateId,
      resumeIds,
      subject,
      body,
    } = job.data;

    console.log(`[Worker] Processing job ${job.id} for user ${userId}, recipient: ${recipient.email}`);

    // 1. Rate limiting
    const { allowed, delayMs } = await checkRateLimit(userId);
    console.log(`[Worker] Rate limit check for user ${userId}: allowed=${allowed}, delayMs=${delayMs}`);
    if (!allowed) {
      console.log(`[Worker] User ${userId} exceeded rate limit. Rescheduling job ${job.id} for ${Math.round(delayMs/60000)} minutes later.`);
      await job.moveToDelayed(Date.now() + delayMs);
      return;
    }

    // 2. Fetch template, resumes, user info
    const template = templateId
      ? await prisma.emailTemplate.findUnique({ where: { id: templateId } })
      : null;
    const resumes = resumeIds && resumeIds.length
      ? await prisma.resume.findMany({ where: { id: { in: resumeIds } } })
      : [];
    const user = await prisma.user.findUnique({ where: { id: userId } });

    console.log(`[Worker] Sending email to ${recipient.email} with subject "${subject || (template && template.subject)}"`);

    // 3. Send email
    const result = await sendEmail({
      user,
      recipient,
      subject: subject || (template && template.subject),
      text: body || (template && template.html_content),
      attachments: resumes.map(r => ({
        filename: r.name,
        path: r.s3_path,
      })),
    });

    if (result.success) {
      console.log(`[Worker] Email sent successfully to ${recipient.email}`);
      await recordEmailCount(userId);
    } else {
      console.error(`[Worker] Failed to send email to ${recipient.email}: ${result.error}`);
    }

    // 5. Log result in EmailLog
    await prisma.emailLog.create({
      data: {
        campaign_id: campaignId,
        sent_at: result.success ? new Date() : null,
        status: result.success ? 'sent' : 'failed',
        error_message: result.success ? null : result.error,
        preview_html: body || (template && template.html_content),
      },
    });

    return result.success;
  }, { connection });

  worker.on('ready', () => {
    console.log('[Worker] Email worker is ready');
  });
  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id ?? 'unknown'} failed:`, err);
  });

  return worker;
}
