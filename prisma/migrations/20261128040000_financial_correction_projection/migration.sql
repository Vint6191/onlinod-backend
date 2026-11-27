-- Additive finance209 correction. Earlier migration receipts remain immutable.
CREATE OR REPLACE FUNCTION onlinod_guard_team_financial_authority_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical_status TEXT; canonical_gross INTEGER; canonical_found BOOLEAN := FALSE;
BEGIN
  IF NEW."creatorSaleId" IS NOT NULL THEN
    SELECT CASE WHEN NEW."sourceType"='PPV' AND s."saleType"::text<>'MESSAGE' THEN 'superseded' ELSE s."transactionStatus" END,s."amountCents"
      INTO canonical_status,canonical_gross
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

DROP TRIGGER "CreatorSale_refresh_team_fact_v1" ON "CreatorSale";
CREATE TRIGGER "CreatorSale_refresh_team_fact_v1" AFTER INSERT OR UPDATE OF "saleType","amountCents",currency,"purchasedAt","transactionStatus","sourceUpdatedAt"
  ON "CreatorSale" FOR EACH ROW EXECUTE FUNCTION onlinod_refresh_team_fact_from_creator_sale_v1();
DROP TRIGGER "CreatorSale_phase2_team_money_work" ON "CreatorSale";
CREATE TRIGGER "CreatorSale_phase2_team_money_work" AFTER INSERT OR UPDATE OF "fanId","externalNotificationId","eventFingerprint","saleType","messageId","amountCents",currency,"purchasedAt","transactionStatus","externalTransactionId","sourceUpdatedAt","financialCorrelation"
  ON "CreatorSale" FOR EACH ROW EXECUTE FUNCTION phase2_team_money_reconciliation_trigger();
DROP TRIGGER "CreatorTip_phase2_team_money_work" ON "CreatorTip";
CREATE TRIGGER "CreatorTip_phase2_team_money_work" AFTER INSERT OR UPDATE OF "fanId","externalNotificationId","eventFingerprint","messageId","amountCents",currency,"tippedAt","transactionStatus","externalTransactionId","sourceUpdatedAt","financialCorrelation"
  ON "CreatorTip" FOR EACH ROW EXECUTE FUNCTION phase2_team_money_reconciliation_trigger();

INSERT INTO "MaintenanceLaneState"(key,generation,"activeGeneration",cursor,"updatedAt") VALUES
 ('financial_correlation_adoption209','financial_correlation_adoption209','financial_correlation_adoption209',
  jsonb_build_object('phase','SALE','afterId','','upperSaleId',COALESCE((SELECT max(id) FROM "CreatorSale"),''),
    'upperTipId',COALESCE((SELECT max(id) FROM "CreatorTip"),'')),CURRENT_TIMESTAMP);
