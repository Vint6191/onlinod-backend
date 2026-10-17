BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL TimeZone = 'UTC';
ALTER TABLE "CreatorEarningsLedgerProof" ADD COLUMN "confirmedThroughAt" timestamp(3);
ALTER TABLE "CreatorEarningsGeneration" ADD COLUMN mode text NOT NULL DEFAULT 'SNAPSHOT' CHECK(mode IN ('SNAPSHOT','DELTA'));
ALTER TABLE "CreatorMoneyObservation" ADD COLUMN "resolutionBlockedAt" timestamp(3), ADD COLUMN "resolutionError" text;
CREATE INDEX "MoneyObservation_resolution_due" ON "CreatorMoneyObservation"("creatorId","occurredAt",id) WHERE status='PENDING' AND "resolutionBlockedAt" IS NULL;
ALTER TABLE "CreatorFinancialCollectionState" ADD COLUMN "lastResolutionGeneration" text;
CREATE INDEX "EarningsGenerationEntry_window" ON "CreatorEarningsGenerationEntry"(generation,"occurredAt","transactionId");
CREATE INDEX "MoneyObservation_pending_adoption" ON "CreatorMoneyObservation"(id) WHERE status='PENDING';
CREATE TABLE "CreatorMoneyResolutionRequest" (
 "creatorId" text PRIMARY KEY, "agencyId" text NOT NULL, queued boolean NOT NULL DEFAULT true,
 "targetId" text, attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6), "jobId" text, "lastError" text,
 "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "MoneyResolutionAdoption" (id text PRIMARY KEY,cursor text NOT NULL DEFAULT '',complete boolean NOT NULL DEFAULT false);
INSERT INTO "MoneyResolutionAdoption"(id) VALUES('v7');
INSERT INTO "Phase2WorkGenerationAuthority"("workClass","activeGeneration","projectionVersion",revision,"activatedAt","createdAt","updatedAt")
 VALUES('MONEY_RESOLUTION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
CREATE INDEX "DomainWorkItem_hot_ready" ON "DomainWorkItem"("workClass","availableAt",id) WHERE state='READY' AND "isOutstanding";
CREATE INDEX "DomainWorkItem_hot_expired" ON "DomainWorkItem"("workClass","leaseUntil",id) WHERE state='CLAIMED' AND "isOutstanding";
-- V6 writers do not understand sparse manifests. Reject before their delivery
-- ACK or publication commit; transport will replay through a current writer.
CREATE OR REPLACE FUNCTION onlinod_earnings_writer_fence_v6() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE creator text;
BEGIN
 creator := CASE WHEN TG_OP='DELETE' THEN OLD."creatorId" ELSE NEW."creatorId" END;
 IF current_setting('onlinod.earnings_writer_generation',true) IS DISTINCT FROM 'v7'
   AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=creator AND "deletedAt" IS NULL)
   AND EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" WHERE "creatorId"=creator AND state IN ('BUILDING','READY','ACTIVE'))
 THEN RAISE EXCEPTION 'EARNINGS_WRITER_UPGRADE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;
CREATE FUNCTION onlinod_earnings_writer_fence_v7() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE creator text; rowdata jsonb;
BEGIN
 rowdata := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 creator := rowdata->>'creatorId';
 IF creator IS NULL THEN SELECT "creatorId" INTO creator FROM "CreatorEarningsGeneration" WHERE id=rowdata->>'generation'; END IF;
 IF current_setting('onlinod.earnings_writer_generation',true) IS DISTINCT FROM 'v7'
   AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=creator AND "deletedAt" IS NULL)
 THEN RAISE EXCEPTION 'EARNINGS_WRITER_UPGRADE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;
CREATE TRIGGER onlinod_earnings_writer_fence_v7 BEFORE INSERT OR UPDATE OR DELETE ON "CreatorEarningsGeneration"
 FOR EACH ROW EXECUTE FUNCTION onlinod_earnings_writer_fence_v7();
CREATE TRIGGER onlinod_earnings_writer_fence_v7 BEFORE INSERT OR UPDATE OR DELETE ON "CreatorEarningsGenerationEntry"
 FOR EACH ROW EXECUTE FUNCTION onlinod_earnings_writer_fence_v7();
CREATE TRIGGER onlinod_earnings_writer_fence_v7 BEFORE INSERT OR UPDATE OR DELETE ON "CreatorMoneyObservation"
 FOR EACH ROW EXECUTE FUNCTION onlinod_earnings_writer_fence_v7();
CREATE FUNCTION onlinod_money_coverage_monotonic_v7() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF OLD.status IN ('APPLIED','COVERED') AND NEW.status='PENDING' THEN RAISE EXCEPTION 'MONEY_COVERAGE_REGRESSION'; END IF;
 IF NEW.status='PENDING' AND OLD."coveredGeneration" IS DISTINCT FROM NEW."coveredGeneration"
   AND EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" WHERE id=OLD."coveredGeneration" AND "publishedAt" IS NOT NULL)
 THEN RAISE EXCEPTION 'MONEY_COVERAGE_REGRESSION'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER onlinod_money_coverage_monotonic_v7 BEFORE UPDATE ON "CreatorMoneyObservation"
 FOR EACH ROW EXECUTE FUNCTION onlinod_money_coverage_monotonic_v7();
CREATE FUNCTION onlinod_resolution_publication_guard_v7() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF NEW."lastResolutionGeneration" IS NOT NULL AND (TG_OP='INSERT' OR OLD."lastResolutionGeneration" IS DISTINCT FROM NEW."lastResolutionGeneration")
   AND NOT EXISTS(SELECT 1 FROM "AnalyticsPublication" p JOIN "JobInstance" j ON j.id=p."jobId"
     WHERE p."jobId"=NEW."sourceJobId" AND p."creatorId"=NEW."creatorId" AND p."agencyId"=NEW."agencyId"
       AND p.payload->>'scanRunId'=NEW."lastResolutionGeneration" AND p.state='PENDING' AND p.stage='FINALIZE' AND j.status='PUBLISHING')
 THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_AUTHORITY_REQUIRED'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER onlinod_resolution_publication_guard_v7 BEFORE INSERT OR UPDATE ON "CreatorFinancialCollectionState"
 FOR EACH ROW EXECUTE FUNCTION onlinod_resolution_publication_guard_v7();
COMMIT;
