-- NOD has one monetary currency: USD. Old unsupported facts remain
-- evidence; they are never relabeled, converted, or made spendable.
-- Only inactive Team quarantine metadata may retain a non-USD value in a new
-- derived row. Existing unsupported rows can be repaired or classified without
-- changing their original evidence. All new operational money is USD.
CREATE OR REPLACE FUNCTION public.onlinod_usd_transaction_supported_v1(p_agency text,p_creator text,p_transaction text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_transaction IS NULL OR NOT (
    EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" f WHERE f."agencyId"=p_agency AND f."creatorId"=p_creator
      AND f."externalTransactionId"=p_transaction AND f.currency IS DISTINCT FROM 'USD')
    OR EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" p
      JOIN "CreatorEarningsGeneration" g ON g.id=p."activeGeneration"
      JOIN "CreatorEarningsGenerationEntry" e ON e.generation=g.id AND e."transactionId"=p_transaction
      WHERE p."agencyId"=p_agency AND p."creatorId"=p_creator AND (
        (e."financialFact" ? 'currency' AND e."financialFact"->>'currency' IS DISTINCT FROM 'USD')
        OR (e."financialFact"->'value' ? 'currency' AND e."financialFact"->'value'->>'currency' IS DISTINCT FROM 'USD')
        OR (e."observedAt"=g."snapshotAt" AND EXISTS(SELECT 1 FROM "FinancialObservedFact" o
          WHERE o."runId"=g."runId" AND o."windowIndex"=0 AND o."externalId"=p_transaction AND o.value->>'currency' IS DISTINCT FROM 'USD'))))
    OR EXISTS(SELECT 1 FROM "CreatorEarningsLedgerEntry" e
      WHERE e."agencyId"=p_agency AND e."creatorId"=p_creator AND e."transactionId"=p_transaction
        AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" p WHERE p."agencyId"=p_agency AND p."creatorId"=p_creator AND p."activeGeneration" IS NOT NULL)
        AND ((e."financialFact" ? 'currency' AND e."financialFact"->>'currency' IS DISTINCT FROM 'USD')
          OR (e."financialFact"->'value' ? 'currency' AND e."financialFact"->'value'->>'currency' IS DISTINCT FROM 'USD')))
  )
$$;

CREATE OR REPLACE FUNCTION public.onlinod_usd_currency_guard_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jsonb:=to_jsonb(NEW); old_j jsonb; c text:=j->>'currency'; mode text:=COALESCE(TG_ARGV[0],'source');
BEGIN
  IF mode='team' THEN
    IF (TG_TABLE_NAME='TeamPpvPurchaseLedger' AND (
      EXISTS(SELECT 1 FROM "CreatorSale" s WHERE s.id=j->>'creatorSaleId' AND s."agencyId"=j->>'agencyId' AND (s.currency IS DISTINCT FROM 'USD' OR NOT onlinod_usd_transaction_supported_v1(s."agencyId",s."creatorId",s."externalTransactionId")))
      OR EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" f WHERE f.id=j->>'financialTransactionId' AND f."agencyId"=j->>'agencyId' AND NOT onlinod_usd_transaction_supported_v1(f."agencyId",f."creatorId",f."externalTransactionId"))))
      OR (TG_TABLE_NAME='TeamTipLedger' AND EXISTS(SELECT 1 FROM "CreatorTip" t WHERE t.id=j->>'creatorTipId' AND t."agencyId"=j->>'agencyId' AND (t.currency IS DISTINCT FROM 'USD' OR NOT onlinod_usd_transaction_supported_v1(t."agencyId",t."creatorId",t."externalTransactionId")))) THEN
      NEW:=jsonb_populate_record(NEW,jsonb_build_object('financialStatus','unsupported_currency'));
      j:=to_jsonb(NEW);
    END IF;
  END IF;
  IF c IS NULL OR c='USD' THEN RETURN NEW; END IF;
  IF mode='team' AND lower(COALESCE(j->>'financialStatus',''))='unsupported_currency' THEN RETURN NEW; END IF;
  IF mode='fact' AND lower(COALESCE(j->>'financialStatus',''))='unsupported_currency' AND NOT COALESCE((j->>'attributionActive')::boolean,false) THEN RETURN NEW; END IF;
  IF mode='contribution' AND NOT COALESCE((j->>'active')::boolean,false) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    old_j:=to_jsonb(OLD);
    IF c IS NOT DISTINCT FROM old_j->>'currency' THEN
      IF mode='team' THEN
        NEW:=jsonb_populate_record(NEW,jsonb_build_object('financialStatus','unsupported_currency'));
      ELSIF mode='fact' THEN
        NEW:=jsonb_populate_record(NEW,jsonb_build_object('financialStatus','unsupported_currency','attributionActive',false));
      ELSIF mode='contribution' AND COALESCE((j->>'active')::boolean,false) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='USD_CURRENCY_REQUIRED',CONSTRAINT=TG_NAME;
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='USD_CURRENCY_REQUIRED',CONSTRAINT=TG_NAME;
END $$;

CREATE OR REPLACE FUNCTION public.onlinod_usd_earnings_entry_guard_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE((NEW."financialFact" ? 'currency' AND NEW."financialFact"->>'currency' IS DISTINCT FROM 'USD')
    OR (NEW."financialFact"->'value' ? 'currency' AND NEW."financialFact"->'value'->>'currency' IS DISTINCT FROM 'USD'),false) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW."financialFact" IS NOT DISTINCT FROM OLD."financialFact" THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='USD_CURRENCY_REQUIRED',CONSTRAINT=TG_NAME;
END $$;


CREATE OR REPLACE FUNCTION onlinod_guard_team_financial_authority_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical_currency TEXT; canonical_status TEXT; canonical_gross INTEGER; canonical_found BOOLEAN := FALSE;
BEGIN
  IF NEW."creatorSaleId" IS NOT NULL THEN
    SELECT CASE WHEN NEW."sourceType"='PPV' AND s."saleType"::text<>'MESSAGE' THEN 'superseded' ELSE s."transactionStatus" END,s."amountCents",s.currency
      INTO canonical_status,canonical_gross,canonical_currency
      FROM "CreatorSale" s WHERE s.id=NEW."creatorSaleId" AND s."agencyId"=NEW."agencyId" AND s."creatorId"=NEW."creatorId";
    canonical_found := FOUND;
  ELSIF NEW."creatorTipId" IS NOT NULL THEN
    SELECT t."transactionStatus",t."amountCents",t.currency INTO canonical_status,canonical_gross,canonical_currency
      FROM "CreatorTip" t WHERE t.id=NEW."creatorTipId" AND t."agencyId"=NEW."agencyId" AND t."creatorId"=NEW."creatorId";
    canonical_found := FOUND;
  END IF;
  IF NEW.currency IS DISTINCT FROM 'USD' OR (canonical_found AND canonical_currency IS DISTINCT FROM 'USD')
    OR EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" f WHERE f.id=NEW."financialTransactionId" AND f."agencyId"=NEW."agencyId" AND NOT onlinod_usd_transaction_supported_v1(f."agencyId",f."creatorId",f."externalTransactionId"))
    OR EXISTS(SELECT 1 FROM "CreatorSale" s WHERE s.id=NEW."creatorSaleId" AND s."agencyId"=NEW."agencyId" AND NOT onlinod_usd_transaction_supported_v1(s."agencyId",s."creatorId",s."externalTransactionId"))
    OR EXISTS(SELECT 1 FROM "CreatorTip" t WHERE t.id=NEW."creatorTipId" AND t."agencyId"=NEW."agencyId" AND NOT onlinod_usd_transaction_supported_v1(t."agencyId",t."creatorId",t."externalTransactionId")) THEN
    NEW."financialStatus" := 'unsupported_currency';
    NEW."attributionActive" := FALSE;
    RETURN NEW;
  END IF;
  IF canonical_found THEN
    NEW."financialStatus" := canonical_status;
    NEW."amountCents" := GREATEST(COALESCE(canonical_gross,0),0);
    IF canonical_gross IS NULL AND COALESCE(lower(canonical_status),'') NOT IN ('undo','refunded','refund','chargeback','reversed','reversal','unverified','superseded') THEN
      NEW."financialStatus" := 'gross_unknown';
    END IF;
  END IF;
  IF COALESCE(lower(NEW."financialStatus"),'') IN ('undo','refunded','refund','chargeback','reversed','reversal','unverified','gross_unknown','superseded','unsupported_currency') THEN
    NEW."attributionActive" := FALSE;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_receipt_project_v2(receipt_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE r "CreatorSubscriptionLedger"%ROWTYPE; cache "TrafficReceiptProjection"%ROWTYPE; next_fact JSONB:='{}'; fact JSONB; sign INTEGER; a TEXT; c TEXT; t TEXT; p TEXT; d JSONB;
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO r FROM "CreatorSubscriptionLedger" WHERE "id"=receipt_id;
  SELECT * INTO cache FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  a:=COALESCE(r."agencyId",cache."agencyId");c:=COALESCE(r."creatorId",cache."creatorId");
  IF c IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(c);
  -- Read again after the projection lock: concurrent rebuild and live writes
  -- must compare against the most recently committed cache.
  SELECT * INTO cache FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  SELECT * INTO r FROM "CreatorSubscriptionLedger" WHERE "id"=receipt_id;
  IF r."id" IS NOT NULL AND r."amountCents">0 AND r.currency='USD' THEN
    SELECT "sourceType" INTO t FROM "TrafficSource" WHERE "id"=r."sourceId" AND "creatorId"=c AND "agencyId"=a;
    IF r."sourceId" IS NOT NULL AND t IS NULL THEN RAISE EXCEPTION 'TRAFFIC_RECEIPT_SOURCE_SCOPE'; END IF;
    next_fact:=jsonb_build_object('source',COALESCE(r."sourceId",''),'type',COALESCE(t,'paid_unknown'),'fan',r."fanId",
      'period',to_char(r."occurredAt",'YYYY-MM-DD'),'amount',r."amountCents");
  END IF;
  IF r."id" IS NOT NULL AND r."sourceId" IS NOT NULL AND r."amountCents">0 AND r.currency='USD' THEN
    UPDATE "TrafficSourceMember" SET "needsValueRefresh"=true,
      "lastRevenueAt"=GREATEST("lastRevenueAt",r."occurredAt"),"convertedAt"=LEAST("convertedAt",r."occurredAt")
    WHERE "agencyId"=a AND "creatorId"=c AND "sourceId"=r."sourceId" AND "fanId"=r."fanId"
      AND (NOT "needsValueRefresh" OR "lastRevenueAt" IS NULL OR "lastRevenueAt"<r."occurredAt"
        OR "convertedAt" IS NULL OR "convertedAt">r."occurredAt");
  END IF;
  IF COALESCE(cache."fact",'{}')=next_fact THEN RETURN; END IF;
  FOR fact,sign IN SELECT COALESCE(cache."fact",'{}'),-1 UNION ALL SELECT next_fact,1 LOOP
    IF fact='{}'::jsonb THEN CONTINUE; END IF;
    d:=jsonb_build_object('paidSubscriptions',sign,'revenueCents',sign*(fact->>'amount')::numeric);
    FOREACH p IN ARRAY ARRAY['*',fact->>'period'] LOOP
      PERFORM "onlinod_traffic_add_v2"(a,c,'total','',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'type',fact->>'type',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'source',fact->>'source',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'receiptFan:'||(fact->>'source'),fact->>'fan',p,d);
    END LOOP;
  END LOOP;
  IF r."id" IS NULL THEN DELETE FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  ELSE
    INSERT INTO "TrafficReceiptProjection"("id","agencyId","creatorId","fact") VALUES(receipt_id,a,c,next_fact)
      ON CONFLICT("id") DO UPDATE SET "fact"=EXCLUDED."fact";
    PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_receipt_capture_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' AND (OLD."sourceId",OLD."fanId",OLD."amountCents",OLD."occurredAt",OLD.currency) IS NOT DISTINCT FROM (NEW."sourceId",NEW."fanId",NEW."amountCents",NEW."occurredAt",NEW.currency) THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN
    PERFORM "onlinod_traffic_publish_fact_v3"(OLD."agencyId",OLD."creatorId",TG_TABLE_NAME,OLD."id");
    RETURN OLD;
  END IF;
  PERFORM "onlinod_traffic_publish_fact_v3"(NEW."agencyId",NEW."creatorId",TG_TABLE_NAME,NEW."id");
  IF NEW."sourceId" IS NULL THEN PERFORM "onlinod_traffic_dirty_fan_v2"(NEW."agencyId",NEW."creatorId",NEW."fanId"); END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_source_metrics_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE previous JSONB:='{}'; desired JSONB; d JSONB;
BEGIN
  IF TG_OP='UPDATE' AND NEW."projectionMetrics" IS DISTINCT FROM OLD."projectionMetrics" AND (to_jsonb(NEW)-'projectionMetrics')=(to_jsonb(OLD)-'projectionMetrics') THEN RETURN NEW; END IF;
  PERFORM "onlinod_traffic_lock_v2"(NEW."creatorId");
  IF TG_OP='UPDATE' THEN previous:=OLD."projectionMetrics"; END IF;
  desired:=jsonb_build_object('sources',1,'costCents',CASE WHEN NEW.currency='USD' THEN NEW."costCents" ELSE 0 END,'unsupportedCostSources',CASE WHEN NEW.currency='USD' THEN 0 ELSE 1 END);
  d:="onlinod_traffic_delta_v2"(previous,desired);
  PERFORM "onlinod_traffic_add_v2"(NEW."agencyId",NEW."creatorId",'total','','*',d);
  PERFORM "onlinod_traffic_add_v2"(NEW."agencyId",NEW."creatorId",'type',NEW."sourceType",'*',d);
  UPDATE "TrafficSource" SET "projectionMetrics"=desired WHERE "id"=NEW."id" AND "projectionMetrics" IS DISTINCT FROM desired;
  RETURN NEW;
END $function$;

CREATE TRIGGER "BillingOrder_01_usd_guard" BEFORE INSERT OR UPDATE ON "BillingOrder" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "AgencyBillingWallet_01_usd_guard" BEFORE INSERT OR UPDATE ON "AgencyBillingWallet" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "BillingWalletTransaction_01_usd_guard" BEFORE INSERT OR UPDATE ON "BillingWalletTransaction" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorNotificationScanItem_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorNotificationScanItem" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorFinancialTransaction_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorFinancialTransaction" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorEarningsTotal_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorEarningsTotal" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorSale_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorSale" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorTip_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorTip" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorSubscriptionEvent_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorSubscriptionEvent" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorSubscriptionState_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorSubscriptionState" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorPaidSubscription_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorPaidSubscription" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorEarningsDaily_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorEarningsDaily" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorEarningsPublishedDay_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorEarningsPublishedDay" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "TeamActivityEvent_01_usd_guard" BEFORE INSERT OR UPDATE ON "TeamActivityEvent" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "MoneyAttribution_01_usd_guard" BEFORE INSERT OR UPDATE ON "MoneyAttribution" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "ContentBlock_01_usd_guard" BEFORE INSERT OR UPDATE ON "ContentBlock" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "TeamSentMessageLedger_01_usd_guard" BEFORE INSERT OR UPDATE ON "TeamSentMessageLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "TeamMoneyAttributionFact_zz_usd_guard" BEFORE INSERT OR UPDATE ON "TeamMoneyAttributionFact" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('fact');
CREATE TRIGGER "TeamMoneyDailyRollup_01_usd_guard" BEFORE INSERT OR UPDATE ON "TeamMoneyDailyRollup" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "TeamMoneyLifetimeRollup_01_usd_guard" BEFORE INSERT OR UPDATE ON "TeamMoneyLifetimeRollup" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "TeamMoneyRollupContribution_01_usd_guard" BEFORE INSERT OR UPDATE ON "TeamMoneyRollupContribution" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('contribution');
CREATE TRIGGER "TrafficSource_01_usd_guard" BEFORE INSERT OR UPDATE ON "TrafficSource" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorSubscriptionLedger_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorSubscriptionLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "TeamPpvPurchaseLedger_01_usd_guard" BEFORE INSERT OR UPDATE ON "TeamPpvPurchaseLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('team');
CREATE TRIGGER "TeamTipLedger_01_usd_guard" BEFORE INSERT OR UPDATE ON "TeamTipLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('team');
CREATE TRIGGER "TeamPpvResolveJob_01_usd_guard" BEFORE INSERT OR UPDATE ON "TeamPpvResolveJob" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorNotificationEvent_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorNotificationEvent" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_currency_guard_v1('source');
CREATE TRIGGER "CreatorEarningsLedgerEntry_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorEarningsLedgerEntry" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_earnings_entry_guard_v1();
CREATE TRIGGER "CreatorEarningsGenerationEntry_01_usd_guard" BEFORE INSERT OR UPDATE ON "CreatorEarningsGenerationEntry" FOR EACH ROW EXECUTE FUNCTION onlinod_usd_earnings_entry_guard_v1();
CREATE INDEX "CreatorFinancialTransaction_unsupported_usd_idx" ON "CreatorFinancialTransaction"("creatorId","agencyId") WHERE currency IS DISTINCT FROM 'USD';
CREATE INDEX "CreatorEarningsPublishedDay_unsupported_usd_idx" ON "CreatorEarningsPublishedDay"("creatorId",date) WHERE currency IS DISTINCT FROM 'USD';
CREATE INDEX "CreatorEarningsGenerationEntry_unsupported_usd_idx" ON "CreatorEarningsGenerationEntry"(generation,"transactionId") WHERE ("financialFact" ? 'currency' AND "financialFact"->>'currency' IS DISTINCT FROM 'USD') OR ("financialFact"->'value' ? 'currency' AND "financialFact"->'value'->>'currency' IS DISTINCT FROM 'USD');
CREATE INDEX "CreatorEarningsLedgerEntry_unsupported_usd_idx" ON "CreatorEarningsLedgerEntry"("creatorId","occurredAt") WHERE ("financialFact" ? 'currency' AND "financialFact"->>'currency' IS DISTINCT FROM 'USD') OR ("financialFact"->'value' ? 'currency' AND "financialFact"->'value'->>'currency' IS DISTINCT FROM 'USD');
CREATE INDEX "TeamMoneyAttributionFact_unsupported_usd_idx" ON "TeamMoneyAttributionFact"("agencyId","creatorId","occurredAt","memberId") WHERE currency IS DISTINCT FROM 'USD' OR "financialStatus"='unsupported_currency';
CREATE INDEX "TeamMoneyDailyRollup_unsupported_usd_idx" ON "TeamMoneyDailyRollup"("agencyId","creatorId",day) WHERE currency IS DISTINCT FROM 'USD';
CREATE INDEX "TrafficSource_unsupported_usd_idx" ON "TrafficSource"("agencyId","creatorId","sourceType",id) WHERE currency IS DISTINCT FROM 'USD';
CREATE INDEX "CreatorSubscriptionLedger_unsupported_usd_idx" ON "CreatorSubscriptionLedger"("agencyId","creatorId","occurredAt","sourceId","fanId") WHERE currency IS DISTINCT FROM 'USD';
CREATE INDEX "CreatorSale_unsupported_usd_idx" ON "CreatorSale"("creatorId") WHERE currency IS DISTINCT FROM 'USD';
CREATE INDEX "CreatorTip_unsupported_usd_idx" ON "CreatorTip"("creatorId") WHERE currency IS DISTINCT FROM 'USD';
CREATE INDEX "FinancialObservedFact_unsupported_usd_idx" ON "FinancialObservedFact"("runId","windowIndex") WHERE value->>'currency' IS DISTINCT FROM 'USD';

-- Preserve canonical amounts, currency and manual ownership. The fact
-- trigger now forces unsupported money inactive even when a stale worker tries
-- to project it as paid. Derived contributions are withdrawn exactly once.
UPDATE "TeamPpvPurchaseLedger" r SET "financialStatus"='unsupported_currency',"updatedAt"=CURRENT_TIMESTAMP
WHERE r.currency IS DISTINCT FROM 'USD'
  OR EXISTS(SELECT 1 FROM "CreatorSale" s WHERE s.id=r."creatorSaleId" AND (s.currency IS DISTINCT FROM 'USD' OR NOT onlinod_usd_transaction_supported_v1(s."agencyId",s."creatorId",s."externalTransactionId")))
  OR EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" f WHERE f.id=r."financialTransactionId" AND NOT onlinod_usd_transaction_supported_v1(f."agencyId",f."creatorId",f."externalTransactionId"));
UPDATE "TeamTipLedger" r SET "financialStatus"='unsupported_currency',"updatedAt"=CURRENT_TIMESTAMP
WHERE r.currency IS DISTINCT FROM 'USD'
  OR EXISTS(SELECT 1 FROM "CreatorTip" t WHERE t.id=r."creatorTipId" AND (t.currency IS DISTINCT FROM 'USD' OR NOT onlinod_usd_transaction_supported_v1(t."agencyId",t."creatorId",t."externalTransactionId")));
UPDATE "TeamMoneyAttributionFact" f SET "financialStatus"='unsupported_currency',"attributionActive"=false,"updatedAt"=CURRENT_TIMESTAMP
WHERE f.currency IS DISTINCT FROM 'USD'
  OR EXISTS(SELECT 1 FROM "CreatorSale" s WHERE s.id=f."creatorSaleId" AND (s.currency IS DISTINCT FROM 'USD' OR NOT onlinod_usd_transaction_supported_v1(s."agencyId",s."creatorId",s."externalTransactionId")))
  OR EXISTS(SELECT 1 FROM "CreatorTip" t WHERE t.id=f."creatorTipId" AND (t.currency IS DISTINCT FROM 'USD' OR NOT onlinod_usd_transaction_supported_v1(t."agencyId",t."creatorId",t."externalTransactionId")))
  OR EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" t WHERE t.id=f."financialTransactionId" AND NOT onlinod_usd_transaction_supported_v1(t."agencyId",t."creatorId",t."externalTransactionId"));

WITH affected AS (
 SELECT c.* FROM "TeamMoneyRollupContribution" c JOIN "TeamMoneyAttributionFact" f ON f.id=c."sourceFactId"
 WHERE c.active AND (c.currency IS DISTINCT FROM 'USD' OR f.currency IS DISTINCT FROM 'USD' OR f."financialStatus"='unsupported_currency')
), grouped AS (
 SELECT "agencyId","memberId","creatorKey","sourceType",currency,day,sum("amountCents") AS amount,count(*)::int AS facts
 FROM affected GROUP BY "agencyId","memberId","creatorKey","sourceType",currency,day
)
UPDATE "TeamMoneyDailyRollup" d SET "amountCents"=d."amountCents"-g.amount,"factCount"=d."factCount"-g.facts,"updatedAt"=CURRENT_TIMESTAMP
FROM grouped g WHERE (d."agencyId",d."memberId",d."creatorKey",d."sourceType",d.currency,d.day)=(g."agencyId",g."memberId",g."creatorKey",g."sourceType",g.currency,g.day);
WITH affected AS (
 SELECT c.* FROM "TeamMoneyRollupContribution" c JOIN "TeamMoneyAttributionFact" f ON f.id=c."sourceFactId"
 WHERE c.active AND (c.currency IS DISTINCT FROM 'USD' OR f.currency IS DISTINCT FROM 'USD' OR f."financialStatus"='unsupported_currency')
), grouped AS (
 SELECT "agencyId","memberId","creatorKey","sourceType",currency,sum("amountCents") AS amount,count(*)::int AS facts
 FROM affected GROUP BY "agencyId","memberId","creatorKey","sourceType",currency
)
UPDATE "TeamMoneyLifetimeRollup" d SET "amountCents"=d."amountCents"-g.amount,"factCount"=d."factCount"-g.facts,"updatedAt"=CURRENT_TIMESTAMP
FROM grouped g WHERE (d."agencyId",d."memberId",d."creatorKey",d."sourceType",d.currency)=(g."agencyId",g."memberId",g."creatorKey",g."sourceType",g.currency);
UPDATE "TeamMoneyRollupContribution" c SET active=false,"amountCents"=0,"updatedAt"=CURRENT_TIMESTAMP
FROM "TeamMoneyAttributionFact" f WHERE f.id=c."sourceFactId" AND c.active
 AND (c.currency IS DISTINCT FROM 'USD' OR f.currency IS DISTINCT FROM 'USD' OR f."financialStatus"='unsupported_currency');

-- Queue the installed bounded owner; no provider request or full synchronous
-- traffic-history rebuild is performed by installation.
SELECT onlinod_traffic_publish_fact_v3("agencyId","creatorId",'CreatorSubscriptionLedger',id)
FROM "CreatorSubscriptionLedger" WHERE currency IS DISTINCT FROM 'USD';

