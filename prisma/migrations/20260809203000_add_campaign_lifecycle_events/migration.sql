ALTER TABLE "Campaign"
ADD COLUMN "cancelled_emails" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CampaignEvent" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CampaignEvent_campaign_id_created_at_idx"
ON "CampaignEvent"("campaign_id", "created_at");

CREATE INDEX "CampaignEvent_type_created_at_idx"
ON "CampaignEvent"("type", "created_at");

ALTER TABLE "CampaignEvent"
ADD CONSTRAINT "CampaignEvent_campaign_id_fkey"
FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
