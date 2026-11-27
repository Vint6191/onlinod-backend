BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CreatorEarningsLedgerEntry" ADD COLUMN "financialFact" JSONB;
ALTER TABLE "CreatorEarningsGenerationEntry" ADD COLUMN "financialFact" JSONB;
ALTER TABLE "CreatorMediaFinancialAdoptionState" ADD COLUMN "semanticsVersion" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "CreatorBillingEntitlement_autoRenewEnabled_nextRenewalAt_creatorId_idx"
  ON "CreatorBillingEntitlement"("autoRenewEnabled","nextRenewalAt","creatorId");
CREATE INDEX "CreatorSale_agencyId_externalNotificationId_idx" ON "CreatorSale"("agencyId","externalNotificationId");
CREATE INDEX "CreatorSale_agencyId_externalTransactionId_idx" ON "CreatorSale"("agencyId","externalTransactionId");
CREATE TABLE "TeamPpvPurchaseAlias" (
  "agencyId" TEXT NOT NULL,"creatorId" TEXT NOT NULL,namespace TEXT NOT NULL,"externalId" TEXT NOT NULL,"rootId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamPpvPurchaseAlias_pkey" PRIMARY KEY ("agencyId","creatorId",namespace,"externalId"),
  CONSTRAINT "TeamPpvPurchaseAlias_namespace_check" CHECK(namespace IN ('creator_sale','notification','transaction','event')),
  CONSTRAINT "TeamPpvPurchaseAlias_scope_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TeamPpvPurchaseAlias_rootId_idx" ON "TeamPpvPurchaseAlias"("rootId");
CREATE FUNCTION onlinod_guard_team_purchase_identity_v3() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_TABLE_NAME='TeamPpvPurchaseAlias' THEN
  IF ROW(NEW."agencyId",NEW."creatorId",NEW.namespace,NEW."externalId",NEW."rootId")
    IS DISTINCT FROM ROW(OLD."agencyId",OLD."creatorId",OLD.namespace,OLD."externalId",OLD."rootId")
  THEN RAISE EXCEPTION 'TEAM_PURCHASE_ALIAS_IMMUTABLE' USING ERRCODE='55000'; END IF;
 ELSE
  IF NEW."agencyId" IS DISTINCT FROM OLD."agencyId"
    OR (OLD."creatorId" IS NOT NULL AND NEW."creatorId" IS DISTINCT FROM OLD."creatorId")
    OR (OLD."creatorSaleId" IS NOT NULL AND NEW."creatorSaleId" IS NOT NULL AND NEW."creatorSaleId"<>OLD."creatorSaleId")
    OR (OLD."financialTransactionId" IS NOT NULL AND NEW."financialTransactionId" IS NOT NULL AND NEW."financialTransactionId"<>OLD."financialTransactionId")
  THEN RAISE EXCEPTION 'TEAM_PURCHASE_ROOT_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER "TeamPpvPurchaseAlias_identity_guard" BEFORE UPDATE ON "TeamPpvPurchaseAlias"
 FOR EACH ROW EXECUTE FUNCTION onlinod_guard_team_purchase_identity_v3();
CREATE TRIGGER "TeamPpvPurchaseLedger_identity_guard" BEFORE UPDATE ON "TeamPpvPurchaseLedger"
 FOR EACH ROW EXECUTE FUNCTION onlinod_guard_team_purchase_identity_v3();
-- No historical receipt or current monetary row is relabelled during DDL.
-- Finite, bounded owners re-verify source state and rebuild derived projections.
INSERT INTO "MoneyResolutionAdoption"(id) VALUES('v8') ON CONFLICT(id) DO NOTHING;
INSERT INTO "MaintenanceLaneState"(key,generation,"activeGeneration",cursor,"updatedAt") VALUES
 ('media_financial_adoption_v2','media_financial_adoption_v2','media_financial_adoption_v2',
  jsonb_build_object('upperId',COALESCE((SELECT MAX(id) FROM "CreatorAccount"),''),'afterId',''),CURRENT_TIMESTAMP),
 ('team_purchase_identity_adoption_v3','team_purchase_identity_adoption_v3','team_purchase_identity_adoption_v3',
  jsonb_build_object('upperId',COALESCE((SELECT MAX(id) FROM "CreatorSale"),''),'upperRootId',COALESCE((SELECT MAX(id) FROM "TeamPpvPurchaseLedger"),''),'afterId',''),CURRENT_TIMESTAMP);
CREATE OR REPLACE FUNCTION onlinod_earnings_writer_fence_v6() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE creator text;
BEGIN
 creator := CASE WHEN TG_OP='DELETE' THEN OLD."creatorId" ELSE NEW."creatorId" END;
 IF current_setting('onlinod.earnings_writer_generation',true) IS DISTINCT FROM 'v9'
   AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=creator AND "deletedAt" IS NULL)
 THEN RAISE EXCEPTION 'EARNINGS_WRITER_UPGRADE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;
CREATE OR REPLACE FUNCTION onlinod_earnings_writer_fence_v7() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE creator text; rowdata jsonb;
BEGIN
 rowdata := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 creator := rowdata->>'creatorId';
 IF creator IS NULL THEN SELECT "creatorId" INTO creator FROM "CreatorEarningsGeneration" WHERE id=rowdata->>'generation'; END IF;
 IF current_setting('onlinod.earnings_writer_generation',true) IS DISTINCT FROM 'v9'
   AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=creator AND "deletedAt" IS NULL)
 THEN RAISE EXCEPTION 'EARNINGS_WRITER_UPGRADE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;
COMMIT;
