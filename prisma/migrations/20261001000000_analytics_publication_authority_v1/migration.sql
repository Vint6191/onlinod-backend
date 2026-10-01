BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "AnalyticsPublication" (
  "id" TEXT PRIMARY KEY,
  "jobId" TEXT NOT NULL REFERENCES "JobInstance"("id") ON DELETE CASCADE,
  "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
  "userId" TEXT NOT NULL, "deviceId" TEXT NOT NULL,
  "leaseRevision" INTEGER NOT NULL, "leaseTokenHash" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING', "stage" TEXT NOT NULL,
  "cursor" JSONB NOT NULL DEFAULT '{}', "proof" JSONB NOT NULL DEFAULT '{}',
  "inputRevision" BIGINT NOT NULL DEFAULT 0,
  "response" JSONB, "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsPublication_state_check" CHECK ("state" IN ('PENDING','COMMITTED','REJECTED','CANCELLED')),
  CONSTRAINT "AnalyticsPublication_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "AnalyticsPublication_execution_key" ON "AnalyticsPublication"("jobId","leaseRevision");
CREATE UNIQUE INDEX "AnalyticsPublication_one_pending_job" ON "AnalyticsPublication"("jobId") WHERE "state"='PENDING';
CREATE INDEX "AnalyticsPublication_due_idx" ON "AnalyticsPublication"("state","availableAt","jobId");
CREATE INDEX "AnalyticsPublication_scope_idx" ON "AnalyticsPublication"("agencyId","creatorId","state");

CREATE TABLE "AnalyticsPublicationInputClock" (
  "jobId" TEXT PRIMARY KEY REFERENCES "JobInstance"("id") ON DELETE CASCADE,
  "revision" BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE "AnalyticsScanProof" ADD COLUMN "proofVersion" INTEGER NOT NULL DEFAULT 1;

-- A different earnings run can supersede individual days between publication
-- pages. Track the affected input identities; a publisher restarts its bounded
-- proof walk when this clock changes. Linking a proof is not an input mutation.
CREATE FUNCTION "onlinod_analytics_publication_input_clock_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_job TEXT; next_job TEXT; target_job TEXT;
BEGIN
  IF TG_TABLE_NAME = 'CreatorEarningsDaily' THEN
    IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'scanProofId' - 'updatedAt') = (to_jsonb(NEW) - 'scanProofId' - 'updatedAt') THEN RETURN NEW; END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" AND OLD."receivedRows" = NEW."receivedRows"
      AND OLD."rejectedRows" = NEW."rejectedRows" AND OLD."payloadChecksum" = NEW."payloadChecksum" THEN RETURN NEW; END IF;
    IF TG_OP <> 'DELETE' AND (NEW."dataType" <> 'EARNINGS' OR NEW."idempotencyKey" NOT LIKE '%:daily:%') THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' AND (OLD."dataType" <> 'EARNINGS' OR OLD."idempotencyKey" NOT LIKE '%:daily:%') THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN previous_job := OLD."sourceJobId"; END IF;
  IF TG_OP <> 'DELETE' THEN next_job := NEW."sourceJobId"; END IF;
  FOR target_job IN SELECT DISTINCT j FROM unnest(ARRAY[previous_job,next_job]) j WHERE j IS NOT NULL ORDER BY j LOOP
    UPDATE "AnalyticsPublicationInputClock" SET "revision"="revision"+1 WHERE "jobId"=target_job;
    IF NOT FOUND THEN
      INSERT INTO "AnalyticsPublicationInputClock"("jobId","revision")
        SELECT target_job,1 WHERE EXISTS (SELECT 1 FROM "JobInstance" WHERE "id"=target_job)
        ON CONFLICT ("jobId") DO UPDATE SET "revision"="AnalyticsPublicationInputClock"."revision"+1;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "analytics_earnings_publication_input_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorEarningsDaily"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_analytics_publication_input_clock_v1"();
CREATE TRIGGER "analytics_batch_publication_input_v1" AFTER INSERT OR UPDATE OR DELETE ON "AnalyticsIngestBatch"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_analytics_publication_input_clock_v1"();

-- Mixed-generation servers may ingest accepted pages, but may not publish a new
-- earnings proof through the retired reserve/root/finalize protocol.
CREATE FUNCTION "onlinod_analytics_proof_publication_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'COMMITTED' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."payloadChecksum" IS DISTINCT FROM NEW."payloadChecksum") THEN
    IF NEW."proofVersion" <> 2 OR NOT EXISTS (
      SELECT 1 FROM "JobInstance" j JOIN "AnalyticsPublication" p ON p."jobId"=j."id"
      WHERE j."id"=NEW."sourceJobId" AND j."status"='PUBLISHING' AND p."state"='PENDING'
        AND p."stage"='FINALIZE' AND p."creatorId"=NEW."creatorId" AND p."agencyId"=NEW."agencyId"
    ) THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_AUTHORITY_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "analytics_proof_publication_guard_v1" BEFORE INSERT OR UPDATE ON "AnalyticsScanProof"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_analytics_proof_publication_guard_v1"();
CREATE FUNCTION "onlinod_analytics_collector_publication_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed BOOLEAN;
BEGIN
  changed:=NEW."baselineVerifiedAt" IS NOT NULL AND (TG_OP='INSERT' OR OLD."baselineVerifiedAt" IS DISTINCT FROM NEW."baselineVerifiedAt")
    OR NEW."lastCatchupCompletedAt" IS NOT NULL AND (TG_OP='INSERT' OR OLD."lastCatchupCompletedAt" IS DISTINCT FROM NEW."lastCatchupCompletedAt");
  IF TG_TABLE_NAME='CreatorCampaignCollectionState' THEN
    changed:=changed OR NEW."membershipCoverageCompletedAt" IS NOT NULL AND (TG_OP='INSERT' OR OLD."membershipCoverageCompletedAt" IS DISTINCT FROM NEW."membershipCoverageCompletedAt");
  END IF;
  IF changed AND NOT EXISTS(
    SELECT 1 FROM "AnalyticsPublication" p JOIN "JobInstance" j ON j."id"=p."jobId"
    WHERE p."jobId"=NEW."sourceJobId" AND p."agencyId"=NEW."agencyId" AND p."creatorId"=NEW."creatorId"
      AND p."payload"->>'scanRunId'=NEW."activeGeneration"
      AND ((p."state"='PENDING' AND p."stage"='FINALIZE' AND j."status"='PUBLISHING')
        OR (TG_TABLE_NAME='CreatorCampaignCollectionState' AND p."state"='COMMITTED' AND j."status"='DONE'))
  ) THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_AUTHORITY_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "analytics_campaign_publication_guard_v1" BEFORE INSERT OR UPDATE ON "CreatorCampaignCollectionState"
 FOR EACH ROW EXECUTE FUNCTION "onlinod_analytics_collector_publication_guard_v1"();
CREATE TRIGGER "analytics_financial_publication_guard_v1" BEFORE INSERT OR UPDATE ON "CreatorFinancialCollectionState"
 FOR EACH ROW EXECUTE FUNCTION "onlinod_analytics_collector_publication_guard_v1"();
CREATE FUNCTION "onlinod_analytics_publishing_job_guard_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."status"='PUBLISHING' AND NEW."status"<>'CANCELLED'
   AND EXISTS(SELECT 1 FROM "AnalyticsPublication" WHERE "jobId"=OLD."id" AND "state"='PENDING') AND (NEW."params" IS DISTINCT FROM OLD."params"
   OR NEW."leaseRevision" IS DISTINCT FROM OLD."leaseRevision" OR NEW."status" NOT IN ('PUBLISHING','DONE','FAILED','CANCELLED')) THEN
   RAISE EXCEPTION 'ANALYTICS_ACCEPTED_JOB_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "analytics_publishing_job_guard_v1" BEFORE UPDATE ON "JobInstance"
 FOR EACH ROW EXECUTE FUNCTION "onlinod_analytics_publishing_job_guard_v1"();
CREATE FUNCTION "onlinod_analytics_publication_immutable_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW."jobId",NEW."agencyId",NEW."creatorId",NEW."userId",NEW."deviceId",NEW."leaseRevision",NEW."leaseTokenHash",NEW."payloadHash",NEW."payload")
   IS DISTINCT FROM (OLD."jobId",OLD."agencyId",OLD."creatorId",OLD."userId",OLD."deviceId",OLD."leaseRevision",OLD."leaseTokenHash",OLD."payloadHash",OLD."payload") THEN
   RAISE EXCEPTION 'ANALYTICS_PUBLICATION_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "analytics_publication_immutable_v1" BEFORE UPDATE ON "AnalyticsPublication"
 FOR EACH ROW EXECUTE FUNCTION "onlinod_analytics_publication_immutable_v1"();
-- Preserve dispatch progress; old replicas can finish their old catalog while
-- new replicas additionally admit the two durable server-owned work classes.
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount","lastAdmittedAt")
 SELECT 'phase6_maintenance_analytics_traffic_v2',"laneName","ordinal","turnCount","lastAdmittedAt"
 FROM "MaintenanceAdmissionClassState" WHERE "generation"='phase6_maintenance_progress_v1';
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount")
 SELECT 'phase6_maintenance_analytics_traffic_v2',v.name,v.ordinal,COALESCE((SELECT min("turnCount") FROM "MaintenanceAdmissionClassState" WHERE "generation"='phase6_maintenance_progress_v1'),0)
 FROM (VALUES ('analyticsPublication',22),('trafficProjection',23)) v(name,ordinal);
COMMIT;
