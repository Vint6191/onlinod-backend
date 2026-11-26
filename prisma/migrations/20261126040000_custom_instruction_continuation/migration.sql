BEGIN;

-- A reviewed continuation has its own immutable delivery identity. Historical
-- TASK/REVISION_REQUEST receipts are retained without rewriting their content.
ALTER TABLE "TelegramDeliveryIntent" DROP CONSTRAINT "TelegramDeliveryIntent_kind_check";
ALTER TABLE "TelegramDeliveryIntent" ADD CONSTRAINT "TelegramDeliveryIntent_kind_check"
  CHECK (kind IN ('TASK', 'REFERENCE', 'MANUAL_REMINDER', 'AUTO_REMINDER', 'CANCELLATION', 'REVISION_REQUEST', 'INSTRUCTION_PART', 'INSTRUCTION_CONTINUATION'));

ALTER TABLE "TelegramDeliveryIntent" DROP CONSTRAINT "TelegramDeliveryIntent_instruction_manifest_check";
ALTER TABLE "TelegramDeliveryIntent" ADD CONSTRAINT "TelegramDeliveryIntent_instruction_manifest_check"
  CHECK ("instructionManifest" IS NULL OR (kind IN ('TASK', 'REVISION_REQUEST', 'INSTRUCTION_CONTINUATION') AND jsonb_typeof("instructionManifest") = 'object'));
ALTER TABLE "TelegramDeliveryIntent" ADD CONSTRAINT "TelegramDeliveryIntent_continuation_manifest_check"
  CHECK (kind <> 'INSTRUCTION_CONTINUATION' OR "instructionManifest" IS NOT NULL);

DROP INDEX "TelegramDeliveryIntent_current_thread_lookup_idx";
CREATE INDEX "TelegramDeliveryIntent_current_thread_lookup_idx"
  ON "TelegramDeliveryIntent" ("agencyId", "customOrderId", "accountId", "remoteRecipientTelegramUserId", "kind", "confirmedAt" DESC, "id" DESC)
  WHERE "state" = 'CONFIRMED' AND "kind" IN ('TASK', 'REVISION_REQUEST', 'INSTRUCTION_CONTINUATION');

COMMIT;
