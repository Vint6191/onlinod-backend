BEGIN;
SET LOCAL lock_timeout = '10s';

-- Constant defaults expand existing rows without replaying historical claims.
ALTER TABLE "DomainWorkItem"
  ADD COLUMN "failureRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastFailureAt" TIMESTAMP(3),
  ADD COLUMN "lastRepair" JSONB;
ALTER TABLE "DomainWorkItem" ADD CONSTRAINT "DomainWorkItem_failure_counter_check"
  CHECK ("failureRevision">=0 AND "consecutiveFailures">=0) NOT VALID;

-- Activate v6 through the existing topology activator, with normal old-claim
-- drain. Once activated, an old deploy script cannot silently lower the fence.
-- The BUILDING/v4 bridge remains legal during clean/rolling topology backfill.
CREATE FUNCTION "phase3_domain_executor_no_downgrade"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."scope"='DOMAIN_WORK_EXECUTOR'
     AND OLD."requiredGeneration"='phase3_domain_executor_v6_failure_policy'
     AND NEW."requiredGeneration" IS DISTINCT FROM OLD."requiredGeneration" THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='PHASE3_DOMAIN_EXECUTOR_DOWNGRADE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Phase2ReleaseCompatibilityAuthority_domain_no_downgrade"
BEFORE UPDATE OF "requiredGeneration" ON "Phase2ReleaseCompatibilityAuthority"
FOR EACH ROW EXECUTE FUNCTION "phase3_domain_executor_no_downgrade"();

-- Backend generation fence at the external-write permit boundary. A rolling
-- old replica must not grant a write using historical fan eligibility. Existing
-- COMMITTING/reconciliation work retains settlement authority and is not resent.
CREATE FUNCTION "phase3_fence_fan_consumer_commit"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."originKind"='AUTOMATION'
     AND NEW."moduleKey" IN ('follow_back','follow','bumps','likes','sfs')
     AND NEW."status"='COMMITTING'
     AND (TG_OP='INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
          OR OLD."writeCommitRevision" IS DISTINCT FROM NEW."writeCommitRevision")
     AND current_setting('onlinod.phase3_fan_consumer_generation',true)
           IS DISTINCT FROM 'phase3_fan_consumer_v1_current_bounded' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='PHASE3_INCOMPATIBLE_FAN_CONSUMER_COMMIT';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AutomationDelivery_phase3_fan_consumer_commit"
BEFORE INSERT OR UPDATE OF "status","writeCommitRevision" ON "AutomationDelivery"
FOR EACH ROW EXECUTE FUNCTION "phase3_fence_fan_consumer_commit"();

-- One cursor per live creator/consumer, independent of retained scan history.
-- runId is a publication ID or a stable consumer generation (SFS targets).
CREATE TABLE "FanConsumerCursor" (
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "consumerKey" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "afterKey" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("creatorId","consumerKey"),
  CONSTRAINT "FanConsumerCursor_creator_fkey" FOREIGN KEY ("agencyId","creatorId")
    REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "FanConsumerCursor_agency_creator_idx" ON "FanConsumerCursor"("agencyId","creatorId");
-- Populated installs build this concurrently in the existing online preflight.
-- Fresh schemas have no content history; IF NOT EXISTS reuses the verified index.
CREATE INDEX IF NOT EXISTS "AutomationContentCandidate_current_cursor_idx"
  ON "AutomationContentCandidate"("creatorId","contentType","snapshotRunId","contentId");
COMMIT;
