BEGIN;

ALTER TABLE "TelegramDeliveryIntent"
  ADD COLUMN "instructionManifest" JSONB,
  ADD COLUMN "instructionParentId" TEXT,
  ADD COLUMN "instructionPartIndex" INTEGER;

ALTER TABLE "TelegramDeliveryIntent" DROP CONSTRAINT "TelegramDeliveryIntent_kind_check";
ALTER TABLE "TelegramDeliveryIntent" ADD CONSTRAINT "TelegramDeliveryIntent_kind_check"
  CHECK (kind IN ('TASK', 'REFERENCE', 'MANUAL_REMINDER', 'AUTO_REMINDER', 'CANCELLATION', 'REVISION_REQUEST', 'INSTRUCTION_PART'));
ALTER TABLE "TelegramDeliveryIntent" ADD CONSTRAINT "TelegramDeliveryIntent_instruction_part_check"
  CHECK (
    (kind <> 'INSTRUCTION_PART' AND "instructionParentId" IS NULL AND "instructionPartIndex" IS NULL)
    OR (kind = 'INSTRUCTION_PART' AND "instructionParentId" IS NOT NULL AND "instructionParentId" <> id
      AND "instructionPartIndex" IS NOT NULL AND "instructionPartIndex" >= 1 AND "instructionManifest" IS NULL)
  );
ALTER TABLE "TelegramDeliveryIntent" ADD CONSTRAINT "TelegramDeliveryIntent_instruction_manifest_check"
  CHECK ("instructionManifest" IS NULL OR (kind IN ('TASK', 'REVISION_REQUEST') AND jsonb_typeof("instructionManifest") = 'object'));

CREATE UNIQUE INDEX "TelegramDeliveryIntent_instruction_part_key"
  ON "TelegramDeliveryIntent" ("instructionParentId", "instructionPartIndex");
CREATE INDEX "TelegramDeliveryIntent_instruction_parent_idx"
  ON "TelegramDeliveryIntent" ("agencyId", "instructionParentId");

COMMIT;
