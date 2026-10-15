-- Each creator owns one provider timeline across every task, device and replica.
-- Retain the old row only for acknowledgements of already issued permits.
-- Prisma does not implicitly wrap PostgreSQL migration files in a transaction.
-- Hold the cutover locks until the carry-over clocks and all fences are installed.
BEGIN;
ALTER TABLE "OfProviderRequestGateState" ADD COLUMN "scopeCreatorId" TEXT;
ALTER TABLE "OfProviderRequestGateState" ADD CONSTRAINT "OfProviderRequestGateState_scope_creator_fkey"
  FOREIGN KEY ("scopeCreatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "OfProviderRequestGateState_scope_creator_key" ON "OfProviderRequestGateState"("scopeCreatorId");
CREATE INDEX "OfProviderRequestGateWaiter_creator_bucket_ticket_idx"
  ON "OfProviderRequestGateWaiter"("creatorId","priority","category","ticket");

-- Lock out old grants before transferring the latest possible start boundary.
-- Late old /started and /cancel remain safe; the new creator clock conservatively
-- waits through any old unacknowledged permit's expiry plus its spacing interval.
SELECT 1 FROM "OfProviderRequestGateState" WHERE "id"='of-global' FOR UPDATE;
INSERT INTO "OfProviderRequestGateState" ("id","scopeCreatorId","fairnessGeneration","fairnessActivationState","nextAllowedAt","updatedAt")
SELECT 'of-creator:'||c."id",c."id",'creator_provider_gate_v1','ACTIVE',
  GREATEST(
    CASE WHEN g."lastStartedCreatorId"=c."id" THEN g."nextAllowedAt" END,
    CASE WHEN g."activeCreatorId"=c."id" AND g."activePermitId" IS NOT NULL
      THEN GREATEST(COALESCE(g."activeExpiresAt",clock_timestamp() AT TIME ZONE 'UTC'),clock_timestamp() AT TIME ZONE 'UTC')
        + GREATEST(COALESCE(g."activeIntervalMs",700),700)*interval '1 millisecond' END
  ),clock_timestamp() AT TIME ZONE 'UTC'
FROM "OfProviderRequestGateState" g JOIN "CreatorAccount" c
  ON c."id" IN (g."lastStartedCreatorId",g."activeCreatorId") WHERE g."id"='of-global';
UPDATE "OfProviderRequestGateState" SET "fairnessActivationState"='QUIESCING',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC'
WHERE "id"='of-global';

CREATE OR REPLACE FUNCTION public.onlinod_enforce_provider_gate_waiter_registration() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='UPDATE' AND (NEW."scopeCreatorId" IS DISTINCT FROM OLD."scopeCreatorId" OR NEW."id" IS DISTINCT FROM OLD."id") THEN
    RAISE EXCEPTION 'ONLINOD_PROVIDER_GATE_SCOPE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  -- An old replica calls INSERT ... ON CONFLICT DO NOTHING before /started.
  -- Preserve that no-op so it can finish an existing permit. It still cannot
  -- change QUIESCING or grant a new global permit in the UPDATE below.
  IF TG_OP='INSERT' AND NEW."id"='of-global' AND NEW."scopeCreatorId" IS NULL
    AND NEW."activePermitId" IS NULL AND EXISTS (
      SELECT 1 FROM "OfProviderRequestGateState" WHERE "id"='of-global' AND "fairnessActivationState"='QUIESCING'
    ) THEN RETURN NULL; END IF;
  IF NEW."scopeCreatorId" IS NULL THEN
    IF NEW."id"<>'of-global' OR NEW."fairnessActivationState"<>'QUIESCING' THEN
      RAISE EXCEPTION 'ONLINOD_PROVIDER_GATE_CREATOR_SCOPE_REQUIRED' USING ERRCODE='23514';
    END IF;
    IF NEW."activePermitId" IS NOT NULL AND (TG_OP='INSERT' OR NEW."activePermitId" IS DISTINCT FROM OLD."activePermitId") THEN
      RAISE EXCEPTION 'ONLINOD_PROVIDER_GATE_GLOBAL_WRITER_RETIRED' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM 'of-creator:'||NEW."scopeCreatorId"
      OR NEW."fairnessGeneration"<>'creator_provider_gate_v1' OR NEW."fairnessActivationState"<>'ACTIVE'
      OR (NEW."activePermitId" IS NOT NULL AND (NEW."activeCreatorId" IS DISTINCT FROM NEW."scopeCreatorId" OR COALESCE(NEW."activeIntervalMs",0)<700)) THEN
      RAISE EXCEPTION 'ONLINOD_PROVIDER_GATE_CREATOR_SCOPE_MISMATCH' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW."activePermitId" IS NOT NULL AND (TG_OP='INSERT' OR NEW."activePermitId" IS DISTINCT FROM OLD."activePermitId") AND NOT EXISTS (
    SELECT 1 FROM "OfProviderRequestGateWaiter" w WHERE w."waiterId"=NEW."activePermitId"
      AND w."ownerInstanceId"=NEW."activeOwnerInstanceId"
      AND w."agencyId"=NEW."activeAgencyId" AND w."creatorId"=NEW."activeCreatorId"
      AND w."deviceId"=NEW."activeDeviceId" AND w."capability"=NEW."activeCapability"
      AND w."leaseUntil">clock_timestamp() AT TIME ZONE 'UTC'
  ) THEN RAISE EXCEPTION 'ONLINOD_PROVIDER_GATE_WAITER_REQUIRED' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER onlinod_provider_gate_waiter_registration ON "OfProviderRequestGateState";
CREATE TRIGGER onlinod_provider_gate_waiter_registration BEFORE INSERT OR UPDATE ON "OfProviderRequestGateState"
FOR EACH ROW EXECUTE FUNCTION public.onlinod_enforce_provider_gate_waiter_registration();

-- A model's periodic directory scan cannot consume another model's admission.
ALTER TABLE "AnalyticsPlanningBudget" ADD COLUMN "creatorId" TEXT;
ALTER TABLE "AnalyticsPlanningBudget" ADD CONSTRAINT "AnalyticsPlanningBudget_creator_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AnalyticsPlanningBudget_creator_idx" ON "AnalyticsPlanningBudget"("creatorId");

-- Keep capacity publication derived from each creator's own debt. The existing
-- bounded backfill fills these small buckets without scanning fan history on reads.
ALTER TABLE "ProviderCapacityContribution" ADD COLUMN "creatorId" TEXT;
CREATE TABLE "ProviderCapacityCreatorBucket" (
  "creatorId" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "itemCount" BIGINT NOT NULL DEFAULT 0,
  "overdueCount" BIGINT NOT NULL DEFAULT 0,
  "requiredCalls" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "ProviderCapacityCreatorBucket_pkey" PRIMARY KEY ("creatorId","bucket"),
  CONSTRAINT "ProviderCapacityCreatorBucket_nonnegative" CHECK ("itemCount">=0 AND "overdueCount">=0 AND "requiredCalls">=0)
);
UPDATE "ProviderCapacityProjectionState" SET
  "generation"='creator_provider_capacity_projection_v3',"directoryCursor"=NULL,"directoryComplete"=FALSE,"fanCursor"=NULL,"fanComplete"=FALSE,"jobCursor"=NULL,"jobComplete"=FALSE;
ALTER TABLE "ProviderCapacityDebtState" DROP CONSTRAINT "ProviderCapacityDebtState_topology_v1_check";
ALTER TABLE "ProviderCapacityDebtState" ALTER COLUMN "topologyVersion" SET DEFAULT 'creator_provider_capacity_v2';
ALTER TABLE "ProviderCapacityDebtState" ALTER COLUMN "topologyId" SET DEFAULT 'of-creator';
ALTER TABLE "ProviderCapacityDebtState" ALTER COLUMN "topologyScope" SET DEFAULT 'CREATOR_PARALLEL';
ALTER TABLE "ProviderCapacityDebtState" ALTER COLUMN "topologyShardCount" SET DEFAULT 0;
ALTER TABLE "ProviderCapacityDebtState" ALTER COLUMN "topologyShardingAllowed" SET DEFAULT TRUE;
-- Old samples describe the retired topology; publish a fresh sample from the
-- existing canonical sources, preserving all jobs and demand records.
DELETE FROM "ProviderCapacityDebtState";
ALTER TABLE "ProviderCapacityDebtState" ADD CONSTRAINT "ProviderCapacityDebtState_topology_v1_check" CHECK (
  "topologyId"='of-creator' AND "topologyScope"='CREATOR_PARALLEL' AND "topologyShardCount">=0 AND "topologyShardingAllowed"=TRUE
  AND "controlMode" IN ('NORMAL','OVERLOAD_PROTECTED','CONSERVATIVE')
  AND "campaignDirectoryAdmissionBudgetCalls">=1 AND "campaignDirectoryGuaranteedCallsPerSweep">=1);
CREATE OR REPLACE FUNCTION public.onlinod_capacity_publication_fence() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."sourceVersion" <> 'creator_provider_capacity_debt_v2' THEN RETURN NULL; END IF;
  IF current_setting('onlinod.capacity_projection_revision',true) IS DISTINCT FROM NEW."projectionRevision"::text
    OR NOT EXISTS (SELECT 1 FROM "ProviderCapacityProjectionState" WHERE "id"=NEW."id"
      AND "generation"='creator_provider_capacity_projection_v3' AND "revision"=NEW."projectionRevision") THEN
    RAISE EXCEPTION 'CAPACITY_PUBLICATION_OWNER_REQUIRED';
  END IF;
  IF TG_OP='UPDATE' AND (NEW."projectionRevision" <= OLD."projectionRevision" OR NEW."sampledAt" < OLD."sampledAt") THEN
    RAISE EXCEPTION 'CAPACITY_PUBLICATION_STALE';
  END IF;
  RETURN NEW;
END $function$;
COMMIT;
