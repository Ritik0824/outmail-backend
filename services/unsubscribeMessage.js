import {
  createUnsubscribeToken,
  unsubscribeUrl,
} from '../domain/unsubscribeToken.js';

const FOOTER_MARKER = '--- OutMail preferences ---';

export function appendUnsubscribeFooter(text, url) {
  const content = typeof text === 'string' ? text.trimEnd() : '';
  if (content.includes(FOOTER_MARKER)) return content;
  const footer = `${FOOTER_MARKER}\nStop receiving emails from this sender: ${url}`;
  return content ? `${content}\n\n${footer}` : footer;
}

export function prepareUnsubscribeMessage({
  userId,
  campaignId,
  recipientId,
  email,
  text,
  secret = process.env.UNSUBSCRIBE_SECRET,
  publicApiUrl = process.env.PUBLIC_API_URL || 'http://localhost:3000',
  ttlDays = Number(process.env.UNSUBSCRIBE_TOKEN_TTL_DAYS || 90),
  now = new Date(),
}) {
  const token = createUnsubscribeToken({
    secret,
    userId,
    campaignId,
    recipientId,
    email,
    now,
    ttlDays,
  });
  const url = unsubscribeUrl({ publicApiUrl, token });
  return {
    text: appendUnsubscribeFooter(text, url),
    unsubscribeUrl: url,
    tokenExpiresAt: new Date(now.getTime() + (ttlDays * 86_400_000)),
  };
}
