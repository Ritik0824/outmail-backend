ALTER TABLE "Campaign"
ADD COLUMN "suppressed_emails" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CampaignRecipient"
ADD COLUMN "suppressed_at" TIMESTAMP(3),
ADD COLUMN "suppression_reason" TEXT;

CREATE INDEX "CampaignRecipient_campaign_id_suppression_reason_idx"
ON "CampaignRecipient"("campaign_id", "suppression_reason");
