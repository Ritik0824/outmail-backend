CREATE INDEX "DeliveryAttempt_provider_message_id_idx"
ON "DeliveryAttempt"("provider_message_id");

CREATE TABLE "ProviderDeliveryEvent" (
    "id" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "delivery_attempt_id" TEXT,
    "recipient_id" TEXT,
    "type" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "error_message" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderDeliveryEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderDeliveryEvent_provider_event_id_key"
ON "ProviderDeliveryEvent"("provider_event_id");

CREATE INDEX "ProviderDeliveryEvent_provider_message_id_occurred_at_idx"
ON "ProviderDeliveryEvent"("provider_message_id", "occurred_at");

CREATE INDEX "ProviderDeliveryEvent_recipient_id_occurred_at_idx"
ON "ProviderDeliveryEvent"("recipient_id", "occurred_at");

CREATE INDEX "ProviderDeliveryEvent_type_occurred_at_idx"
ON "ProviderDeliveryEvent"("type", "occurred_at");

CREATE INDEX "ProviderDeliveryEvent_outcome_created_at_idx"
ON "ProviderDeliveryEvent"("outcome", "created_at");

ALTER TABLE "ProviderDeliveryEvent"
ADD CONSTRAINT "ProviderDeliveryEvent_delivery_attempt_id_fkey"
FOREIGN KEY ("delivery_attempt_id") REFERENCES "DeliveryAttempt"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProviderDeliveryEvent"
ADD CONSTRAINT "ProviderDeliveryEvent_recipient_id_fkey"
FOREIGN KEY ("recipient_id") REFERENCES "CampaignRecipient"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
