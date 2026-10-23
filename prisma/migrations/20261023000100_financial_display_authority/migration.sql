BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL TimeZone = 'UTC';

-- Displayed money, status counts and category totals share the published
-- earnings generation. Unverified mutable payout rows are never a read model.
ALTER TABLE "CreatorEarningsGenerationEntry" ADD COLUMN "grossCents" bigint;
ALTER TABLE "CreatorEarningsLedgerEntry" ADD COLUMN "grossCents" bigint;
ALTER TABLE "CreatorEarningsGenerationDay" ADD COLUMN "financialMetrics" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "CreatorEarningsLedgerHour" ADD COLUMN "financialMetrics" jsonb NOT NULL DEFAULT '{}';

CREATE FUNCTION onlinod_earnings_metrics_delta_v1(metrics jsonb, status text, net bigint, gross bigint, direction bigint)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $body$
DECLARE value jsonb := metrics;
BEGIN
 IF status NOT IN ('done','loading','undo') THEN RAISE EXCEPTION 'EARNINGS_METRIC_STATUS_INVALID'; END IF;
 value := jsonb_set(value,ARRAY[status||'_count'],to_jsonb(COALESCE((value->>(status||'_count'))::bigint,0)+direction));
 value := jsonb_set(value,ARRAY[status||'_net'],to_jsonb(COALESCE((value->>(status||'_net'))::bigint,0)+direction*net));
 value := jsonb_set(value,ARRAY[status||'_gross'],to_jsonb(COALESCE((value->>(status||'_gross'))::bigint,0)+direction*COALESCE(gross,0)));
 value := jsonb_set(value,ARRAY[status||'_grossKnown'],to_jsonb(COALESCE((value->>(status||'_grossKnown'))::bigint,0)+direction*CASE WHEN gross IS NULL THEN 0 ELSE 1 END));
 RETURN value;
END $body$;

CREATE OR REPLACE FUNCTION onlinod_earnings_generation_delta_v1() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE r record;
BEGIN
 IF TG_OP='DELETE' THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND (OLD."occurredAt",OLD.category,OLD."netCents",OLD."grossCents",OLD.status,OLD."observedAt")
   IS NOT DISTINCT FROM (NEW."occurredAt",NEW.category,NEW."netCents",NEW."grossCents",NEW.status,NEW."observedAt") THEN RETURN NULL; END IF;
 FOR r IN SELECT * FROM (VALUES
   (CASE WHEN TG_OP='UPDATE' THEN OLD.generation END,OLD."occurredAt",OLD.category,OLD."netCents",OLD."grossCents",OLD.status,OLD."observedAt",-1::bigint),
   (NEW.generation,NEW."occurredAt",NEW.category,NEW."netCents",NEW."grossCents",NEW.status,NEW."observedAt",1::bigint)
 ) AS v(g,at,cat,net,gross,status,observed,sign) WHERE g IS NOT NULL LOOP
   INSERT INTO "CreatorEarningsGenerationHour"(generation,hour,category,"netCents","observedAt")
    VALUES(r.g,date_trunc('hour',r.at),r.cat,r.sign*CASE WHEN r.status='undo' THEN 0 ELSE r.net END,r.observed)
    ON CONFLICT(generation,hour,category) DO UPDATE SET
      "netCents"="CreatorEarningsGenerationHour"."netCents"+EXCLUDED."netCents",
      "observedAt"=GREATEST("CreatorEarningsGenerationHour"."observedAt",EXCLUDED."observedAt");
   INSERT INTO "CreatorEarningsGenerationDay"(generation,date,category,"netCents","observedAt","financialMetrics")
    VALUES(r.g,r.at::date,r.cat,r.sign*CASE WHEN r.status='undo' THEN 0 ELSE r.net END,r.observed,
      onlinod_earnings_metrics_delta_v1('{}',r.status,r.net,r.gross,r.sign))
    ON CONFLICT(generation,date,category) DO UPDATE SET
      "netCents"="CreatorEarningsGenerationDay"."netCents"+EXCLUDED."netCents",
      "financialMetrics"=onlinod_earnings_metrics_delta_v1("CreatorEarningsGenerationDay"."financialMetrics",r.status,r.net,r.gross,r.sign),
      "observedAt"=GREATEST("CreatorEarningsGenerationDay"."observedAt",EXCLUDED."observedAt");
 END LOOP;
 RETURN NULL;
END $body$;

CREATE OR REPLACE FUNCTION onlinod_live_earnings_hour_v1() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
   (CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD."creatorId" END,OLD."agencyId",OLD."occurredAt",OLD.category,OLD."netCents",OLD."grossCents",OLD.status,OLD."observedAt",-1::bigint),
   (CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW."creatorId" END,NEW."agencyId",NEW."occurredAt",NEW.category,NEW."netCents",NEW."grossCents",NEW.status,NEW."observedAt",1::bigint)
 ) AS v(creator,agency,at,cat,net,gross,status,observed,sign)
 WHERE creator IS NOT NULL AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=creator AND "agencyId"=agency) LOOP
  INSERT INTO "CreatorEarningsLedgerHour"("agencyId","creatorId",hour,category,"netCents","observedAt","financialMetrics")
  VALUES(r.agency,r.creator,date_trunc('hour',r.at),r.cat,r.sign*CASE WHEN r.status='undo' THEN 0 ELSE r.net END,r.observed,
    onlinod_earnings_metrics_delta_v1('{}',r.status,r.net,r.gross,r.sign))
  ON CONFLICT("creatorId",hour,category) DO UPDATE SET
    "netCents"="CreatorEarningsLedgerHour"."netCents"+EXCLUDED."netCents",
    "financialMetrics"=onlinod_earnings_metrics_delta_v1("CreatorEarningsLedgerHour"."financialMetrics",r.status,r.net,r.gross,r.sign),
    "observedAt"=GREATEST("CreatorEarningsLedgerHour"."observedAt",EXCLUDED."observedAt");
 END LOOP;
 RETURN NULL;
END $body$;

-- One installation-time aggregation of already verified rows. No gross value
-- is inferred for older entries. Runtime readers stay bounded by days/categories.
UPDATE "CreatorEarningsGenerationDay" d SET "financialMetrics"=b.metrics FROM (
 SELECT generation,"occurredAt"::date AS bucket,category,jsonb_build_object('done_count',COUNT(*) FILTER (WHERE status='done'),'done_net',COALESCE(SUM("netCents") FILTER (WHERE status='done'),0),'done_gross',COALESCE(SUM("grossCents") FILTER (WHERE status='done'),0),'done_grossKnown',COUNT("grossCents") FILTER (WHERE status='done'),'loading_count',COUNT(*) FILTER (WHERE status='loading'),'loading_net',COALESCE(SUM("netCents") FILTER (WHERE status='loading'),0),'loading_gross',COALESCE(SUM("grossCents") FILTER (WHERE status='loading'),0),'loading_grossKnown',COUNT("grossCents") FILTER (WHERE status='loading'),'undo_count',COUNT(*) FILTER (WHERE status='undo'),'undo_net',COALESCE(SUM("netCents") FILTER (WHERE status='undo'),0),'undo_gross',COALESCE(SUM("grossCents") FILTER (WHERE status='undo'),0),'undo_grossKnown',COUNT("grossCents") FILTER (WHERE status='undo')) AS metrics
 FROM "CreatorEarningsGenerationEntry" GROUP BY generation,"occurredAt"::date,category
 ) b WHERE d.generation=b.generation AND d.date=b.bucket AND d.category=b.category;
UPDATE "CreatorEarningsLedgerHour" d SET "financialMetrics"=b.metrics FROM (
 SELECT "creatorId",date_trunc('hour',"occurredAt") AS bucket,category,jsonb_build_object('done_count',COUNT(*) FILTER (WHERE status='done'),'done_net',COALESCE(SUM("netCents") FILTER (WHERE status='done'),0),'done_gross',COALESCE(SUM("grossCents") FILTER (WHERE status='done'),0),'done_grossKnown',COUNT("grossCents") FILTER (WHERE status='done'),'loading_count',COUNT(*) FILTER (WHERE status='loading'),'loading_net',COALESCE(SUM("netCents") FILTER (WHERE status='loading'),0),'loading_gross',COALESCE(SUM("grossCents") FILTER (WHERE status='loading'),0),'loading_grossKnown',COUNT("grossCents") FILTER (WHERE status='loading'),'undo_count',COUNT(*) FILTER (WHERE status='undo'),'undo_net',COALESCE(SUM("netCents") FILTER (WHERE status='undo'),0),'undo_gross',COALESCE(SUM("grossCents") FILTER (WHERE status='undo'),0),'undo_grossKnown',COUNT("grossCents") FILTER (WHERE status='undo')) AS metrics
 FROM "CreatorEarningsLedgerEntry" GROUP BY "creatorId",date_trunc('hour',"occurredAt"),category
 ) b WHERE d."creatorId"=b."creatorId" AND d.hour=b.bucket AND d.category=b.category;
-- Gross is optional provider evidence. Confirmed NET never implies a tax/fee
-- rate and cannot be reconstructed as gross multiplied by an assumed factor.
ALTER TABLE "CreatorFinancialTransaction" ALTER COLUMN "amountCents" DROP NOT NULL;
ALTER TABLE "CreatorSale" ALTER COLUMN "amountCents" DROP NOT NULL;
ALTER TABLE "CreatorTip" ALTER COLUMN "amountCents" DROP NOT NULL;
-- Reuse the existing durable adoption owner. The immutable upper bound makes
-- this one upgrade pass, with bounded per-creator repair in the runtime.
INSERT INTO "MaintenanceLaneState"(key,generation,"activeGeneration",cursor,"updatedAt")
SELECT 'analytics_publication_adoption_v2','analytics_publication_adoption_v2','analytics_publication_adoption_v2',
  jsonb_build_object('upperId',COALESCE(MAX(id),''),'afterId',''),clock_timestamp() FROM "CreatorAccount"
ON CONFLICT(key) DO NOTHING;
COMMIT;
