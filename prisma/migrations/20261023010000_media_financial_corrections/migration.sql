ALTER TABLE "CreatorMediaUsageFact" ADD COLUMN "observedPayload" JSONB;
ALTER TABLE "CreatorMediaUsageContribution" ADD COLUMN "revenueUnknownCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CreatorMediaAsset" ADD COLUMN "revenueUnknownCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CreatorMediaSaleLink" (
  "saleId" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
  "sourceKey" TEXT, "dialogId" TEXT, "messageId" TEXT, "netCents" INTEGER,
  "proofActive" BOOLEAN NOT NULL DEFAULT FALSE, "purchasedAt" TIMESTAMP(3), "operationId" TEXT,
  "version" TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorMediaSaleLink_message_idx" ON "CreatorMediaSaleLink"("creatorId","sourceKey","messageId");
CREATE TABLE "CreatorMediaMessageFinancialState" (
  "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL, "sourceKey" TEXT NOT NULL, "messageId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL, "netCents" BIGINT, "proofActive" BOOLEAN NOT NULL DEFAULT FALSE,
  "purchasedAt" TIMESTAMP(3), "operationId" TEXT, "version" TEXT NOT NULL,
  dirty BOOLEAN NOT NULL DEFAULT TRUE, cursor TEXT NOT NULL DEFAULT '',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY("creatorId","sourceKey","messageId"),
  FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorMediaMessageFinancialState_dirty_idx" ON "CreatorMediaMessageFinancialState"("creatorId",dirty,"sourceKey","messageId");
CREATE TABLE "CreatorMediaFinancialAdoptionState" (
  "creatorId" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'SALES',
  "upperSaleId" TEXT NOT NULL DEFAULT '',"saleCursor" TEXT NOT NULL DEFAULT '',
  "factSource" TEXT NOT NULL DEFAULT '',"factMessage" TEXT NOT NULL DEFAULT '',"factMedia" TEXT NOT NULL DEFAULT '',
  "completedAt" TIMESTAMP(3),
  FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorSale_media_adoption_idx" ON "CreatorSale"("creatorId",id);
CREATE INDEX "CreatorMediaUsageContribution_last_sale_idx" ON "CreatorMediaUsageContribution"("creatorId","mediaId","lastSoldAt");
CREATE INDEX "CreatorMediaUsageFact_last_sale_idx" ON "CreatorMediaUsageFact"("creatorId","sourceKey","mediaId",(payload->>'lastSoldAt') DESC) WHERE purchased;

-- Adoption has a frozen creator boundary and advances through existing facts
-- in bounded owner commits. Installation does not rebuild all media history.
INSERT INTO "MaintenanceLaneState"(key,generation,"activeGeneration",cursor,"updatedAt")
VALUES('media_financial_adoption_v1','media_financial_adoption_v1','media_financial_adoption_v1',
  jsonb_build_object('upperId',COALESCE((SELECT MAX(id) FROM "CreatorAccount"),''),'afterId',''),CURRENT_TIMESTAMP);

-- Team is a GROSS attribution view. A verified NET with unavailable gross is
-- not a zero-gross sale, and an unverified scan must never activate revenue.
-- All legacy trigger paths pass through this single current-fact guard.
CREATE OR REPLACE FUNCTION onlinod_guard_team_financial_authority_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical_status TEXT; canonical_gross INTEGER; canonical_found BOOLEAN := FALSE;
BEGIN
  IF NEW."creatorSaleId" IS NOT NULL THEN
    SELECT s."transactionStatus",s."amountCents" INTO canonical_status,canonical_gross
      FROM "CreatorSale" s WHERE s.id=NEW."creatorSaleId" AND s."agencyId"=NEW."agencyId" AND s."creatorId"=NEW."creatorId";
    canonical_found := FOUND;
  ELSIF NEW."creatorTipId" IS NOT NULL THEN
    SELECT t."transactionStatus",t."amountCents" INTO canonical_status,canonical_gross
      FROM "CreatorTip" t WHERE t.id=NEW."creatorTipId" AND t."agencyId"=NEW."agencyId" AND t."creatorId"=NEW."creatorId";
    canonical_found := FOUND;
  END IF;
  IF canonical_found THEN
    NEW."financialStatus" := canonical_status;
    NEW."amountCents" := GREATEST(COALESCE(canonical_gross,0),0);
    IF canonical_gross IS NULL AND COALESCE(lower(canonical_status),'') NOT IN ('undo','refunded','refund','chargeback','reversed','reversal','unverified','superseded') THEN
      NEW."financialStatus" := 'gross_unknown';
    END IF;
  END IF;
  IF COALESCE(lower(NEW."financialStatus"),'') IN ('undo','refunded','refund','chargeback','reversed','reversal','unverified','gross_unknown','superseded') THEN
    NEW."attributionActive" := FALSE;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TeamMoneyAttributionFact_current_financial_guard" BEFORE INSERT OR UPDATE ON "TeamMoneyAttributionFact"
FOR EACH ROW EXECUTE FUNCTION onlinod_guard_team_financial_authority_v1();
CREATE INDEX "TeamMoneyAttributionFact_uncertain_range_idx" ON "TeamMoneyAttributionFact"("agencyId","occurredAt","creatorId")
  WHERE "financialStatus" IN ('unverified','gross_unknown');
CREATE INDEX "TeamMoneyAttributionFact_uncertain_creator_idx" ON "TeamMoneyAttributionFact"("agencyId","creatorId","occurredAt")
  WHERE "financialStatus" IN ('unverified','gross_unknown');

CREATE INDEX "CreatorMediaUsageSourceState_legacy_pending_idx" ON "CreatorMediaUsageSourceState"("creatorId") WHERE "factProtocol"=0;
