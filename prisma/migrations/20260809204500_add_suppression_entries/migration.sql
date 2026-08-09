CREATE TABLE "SuppressionEntry" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SuppressionEntry_user_id_email_key"
ON "SuppressionEntry"("user_id", "email");

CREATE INDEX "SuppressionEntry_user_id_removed_at_created_at_idx"
ON "SuppressionEntry"("user_id", "removed_at", "created_at");

CREATE INDEX "SuppressionEntry_reason_created_at_idx"
ON "SuppressionEntry"("reason", "created_at");

ALTER TABLE "SuppressionEntry"
ADD CONSTRAINT "SuppressionEntry_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
