-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "queue_job_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_queue_job_id_key" ON "CampaignRecipient"("queue_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaign_id_email_key" ON "CampaignRecipient"("campaign_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaign_id_position_key" ON "CampaignRecipient"("campaign_id", "position");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaign_id_status_idx" ON "CampaignRecipient"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_recipient_id_attempt_number_key" ON "DeliveryAttempt"("recipient_id", "attempt_number");

-- CreateIndex
CREATE INDEX "DeliveryAttempt_recipient_id_status_idx" ON "DeliveryAttempt"("recipient_id", "status");

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "CampaignRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
