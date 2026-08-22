-- V20.10: exact PHYSICAL stage age without abusing CustomOrder.updatedAt.
ALTER TABLE "CustomOrder" ADD COLUMN "physicalStatusChangedAt" TIMESTAMP(3);

-- Existing physical orders have no historical transition ledger. Use the latest
-- known row update as a conservative baseline; all V20.10+ transitions update
-- this dedicated timestamp explicitly.
UPDATE "CustomOrder"
SET "physicalStatusChangedAt" = COALESCE("updatedAt", "createdAt")
WHERE "type" = 'PHYSICAL'
  AND "physicalStatusChangedAt" IS NULL;

CREATE INDEX "CustomOrder_agencyId_type_status_physicalStatusChangedAt_idx"
ON "CustomOrder"("agencyId", "type", "status", "physicalStatusChangedAt");
