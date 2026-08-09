-- Persist the rendered-template source needed to rebuild delivery jobs after a queue outage.
ALTER TABLE "Campaign"
ADD COLUMN "subject" TEXT,
ADD COLUMN "body" TEXT;

UPDATE "Campaign" AS campaign
SET
  "subject" = COALESCE(template."subject", ''),
  "body" = COALESCE(template."html_content", '')
FROM "EmailTemplate" AS template
WHERE campaign."template_id" = template."id";

UPDATE "Campaign"
SET
  "subject" = COALESCE("subject", ''),
  "body" = COALESCE("body", '');

ALTER TABLE "Campaign"
ALTER COLUMN "subject" SET NOT NULL,
ALTER COLUMN "body" SET NOT NULL;
