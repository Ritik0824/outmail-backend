import express from 'express';
import prisma from '../prisma/prismaClient.js';
import { authenticateJWT } from '../middleware/auth.js';

const router = express.Router();

router.get('/email-usage', authenticateJWT, async (req, res) => {
  const userId = req.user.id;
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Find all campaigns for this user
  const campaigns = await prisma.campaign.findMany({
    where: { user_id: userId },
    select: { id: true },
  });
  const campaignIds = campaigns.map(c => c.id);

  // Count emails sent in the last hour and day
  const [hourlyUsed, dailyUsed] = await Promise.all([
    prisma.emailLog.count({
      where: {
        campaign_id: { in: campaignIds },
        created_at: { gte: oneHourAgo },
      },
    }),
    prisma.emailLog.count({
      where: {
        campaign_id: { in: campaignIds },
        created_at: { gte: oneDayAgo },
      },
    }),
  ]);

  res.json({
    hourlyUsed,
    hourlyLimit: 20,
    dailyUsed,
    dailyLimit: 50,
  });
});

export default router;
