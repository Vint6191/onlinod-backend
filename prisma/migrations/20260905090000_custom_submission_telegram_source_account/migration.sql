ALTER TABLE "CustomContentSubmission"
ADD COLUMN IF NOT EXISTS "telegramSourceAccountId" TEXT;

ALTER TABLE "CustomContentSubmission"
ADD COLUMN IF NOT EXISTS "telegramSourceUserId" TEXT;

-- Historical provider-proven rows are backfilled only when every referenced inbound event
-- is still present and all events agree on one provider namespace (account + sender user id).
-- Ambiguous legacy rows deliberately remain NULL and therefore fail closed in upload-work.
WITH source_identity AS (
  SELECT
    submission."id" AS "submissionId",
    MIN(inbound."accountId") AS "accountId",
    MIN(inbound."senderTelegramUserId") AS "senderTelegramUserId",
    COUNT(DISTINCT inbound."id") AS "eventCount",
    COUNT(DISTINCT inbound."accountId") AS "accountCount",
    COUNT(DISTINCT inbound."senderTelegramUserId") AS "senderCount",
    cardinality(submission."telegramInboundEventIds") AS "expectedEventCount"
  FROM "CustomContentSubmission" AS submission
  JOIN "TelegramInboundEvent" AS inbound
    ON inbound."id" = ANY(submission."telegramInboundEventIds")
  WHERE cardinality(submission."telegramInboundEventIds") > 0
  GROUP BY submission."id", submission."telegramInboundEventIds"
)
UPDATE "CustomContentSubmission" AS submission
SET
  "telegramSourceAccountId" = source_identity."accountId",
  "telegramSourceUserId" = source_identity."senderTelegramUserId"
FROM source_identity
WHERE submission."id" = source_identity."submissionId"
  AND submission."telegramSourceAccountId" IS NULL
  AND submission."telegramSourceUserId" IS NULL
  AND source_identity."eventCount" = source_identity."expectedEventCount"
  AND source_identity."accountCount" = 1
  AND source_identity."senderCount" = 1;

DROP INDEX IF EXISTS "CustomContentSubmission_agencyId_telegramSourceAccountId_idx";
CREATE INDEX IF NOT EXISTS "CustomContentSubmission_agencyId_telegramSourceAccountId_telegramSourceUserId_idx"
ON "CustomContentSubmission"("agencyId", "telegramSourceAccountId", "telegramSourceUserId");
