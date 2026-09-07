BEGIN;

ALTER TABLE "TelegramDeliveryIntent"
  ADD COLUMN IF NOT EXISTS "customSubmissionId" TEXT;

DROP INDEX IF EXISTS "TelegramDeliveryIntent_agencyId_customSubmissionId_kind_createdAt_idx";
CREATE INDEX "TelegramDeliveryIntent_agencyId_customSubmissionId_kind_createdAt_idx"
  ON "TelegramDeliveryIntent"("agencyId", "customSubmissionId", "kind", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "TelegramDeliveryIntent_one_revision_request_per_submission_key"
  ON "TelegramDeliveryIntent"("customSubmissionId")
  WHERE "kind" = 'REVISION_REQUEST' AND "customSubmissionId" IS NOT NULL;

ALTER TABLE "TelegramDeliveryIntent" DROP CONSTRAINT IF EXISTS "TelegramDeliveryIntent_kind_check";
ALTER TABLE "TelegramDeliveryIntent"
  ADD CONSTRAINT "TelegramDeliveryIntent_kind_check"
  CHECK ("kind" IN ('TASK', 'REFERENCE', 'MANUAL_REMINDER', 'AUTO_REMINDER', 'CANCELLATION', 'REVISION_REQUEST'));

-- Existing REVISION_REQUESTED decisions intentionally receive no synthetic receipt.
-- Application recovery may materialize a PLANNED REVISION_REQUEST from the historical
-- decision + confirmed TASK thread, but migration never invents provider success.

COMMIT;
