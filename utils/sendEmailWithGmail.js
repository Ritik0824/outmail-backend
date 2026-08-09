import nodemailer from 'nodemailer';
import { decrypt } from './encryption.js';
import { getS3FileBufferFromUrl } from './s3.js';

export default async function sendEmailWithGmail({ user, recipient, subject, text, attachments = [] }) {
  try {
    const decrypted = decrypt(user.app_password_hash);
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: user.email, pass: decrypted },
    });
    const formattedAttachments = await Promise.all(
      attachments.map(async ({ filename, path }) => {
        const { buffer } = await getS3FileBufferFromUrl(path);
        return { filename, content: buffer };
      }),
    );
    const result = await transporter.sendMail({
      from: `"${user.display_name}" <${user.email}>`,
      to: recipient.email,
      subject,
      text,
      attachments: formattedAttachments,
    });

    return { success: true, messageId: result.messageId || null };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
