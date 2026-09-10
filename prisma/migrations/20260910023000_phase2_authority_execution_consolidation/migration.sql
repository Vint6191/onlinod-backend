-- Phase 2 Customs / Team authority & execution consolidation — expansion foundation.
-- Canonical business facts stay in their domain tables. DomainWorkItem is a bounded
-- current executable locator with revision/fence semantics; it is never historical truth.

ALTER TABLE "MaintenanceLaneState"
  ADD COLUMN IF NOT EXISTS "activeGeneration" TEXT,
  ADD COLUMN IF NOT EXISTS "claimFence" BIGINT NOT NULL DEFAULT 0;

UPDATE "MaintenanceLaneState"
   SET "activeGeneration" = "generation"
 WHERE "activeGeneration" IS NULL;

CREATE TABLE IF NOT EXISTS "DomainWorkItem" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "workClass" TEXT NOT NULL,
  "objectType" TEXT NOT NULL,
  "objectId" TEXT NOT NULL,
  "parentObjectId" TEXT,
  "partitionKey" TEXT NOT NULL,
  "creatorId" TEXT,
  "accountId" TEXT,
  "requestedRevision" BIGINT NOT NULL DEFAULT 1,
  "completedRevision" BIGINT NOT NULL DEFAULT 0,
  "activeGeneration" TEXT NOT NULL DEFAULT 'phase2_domain_work_v1',
  "projectionVersion" TEXT NOT NULL DEFAULT 'phase2_domain_work_v1',
  "state" TEXT NOT NULL DEFAULT 'READY',
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMP(3),
  "ownerToken" TEXT,
  "claimFence" BIGINT NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "claimedRevision" BIGINT NOT NULL DEFAULT 0,
  "progressCursor" JSONB,
  "dependencyKind" TEXT,
  "dependencyKey" TEXT,
  "dependencyRevision" BIGINT NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "errorClass" TEXT,
  "lastError" TEXT,
  "terminalCause" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DomainWorkItem_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "DomainWorkItem_identity_key"
  ON "DomainWorkItem"("agencyId","workClass","objectType","objectId");
CREATE INDEX IF NOT EXISTS "DomainWorkItem_class_due_idx"
  ON "DomainWorkItem"("agencyId","workClass","state","availableAt","id");
CREATE INDEX IF NOT EXISTS "DomainWorkItem_parent_due_idx"
  ON "DomainWorkItem"("agencyId","workClass","parentObjectId","state","availableAt","id");
CREATE INDEX IF NOT EXISTS "DomainWorkItem_partition_due_idx"
  ON "DomainWorkItem"("agencyId","partitionKey","state","availableAt","id");
CREATE INDEX IF NOT EXISTS "DomainWorkItem_dependency_idx"
  ON "DomainWorkItem"("agencyId","dependencyKind","dependencyKey","dependencyRevision","id");
CREATE INDEX IF NOT EXISTS "DomainWorkItem_global_due_idx"
  ON "DomainWorkItem"("state","availableAt","id");
CREATE INDEX IF NOT EXISTS "DomainWorkItem_ready_due_partial_idx"
  ON "DomainWorkItem"("agencyId","partitionKey","availableAt","id")
  WHERE "state"='READY';
CREATE INDEX IF NOT EXISTS "DomainWorkItem_blocked_dependency_partial_idx"
  ON "DomainWorkItem"("agencyId","dependencyKind","dependencyKey","dependencyRevision","id")
  WHERE "state"='BLOCKED';

CREATE TABLE IF NOT EXISTS "Phase2WorkCoverage" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "family" TEXT NOT NULL,
  "generation" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT FALSE,
  "enumerationState" TEXT NOT NULL DEFAULT 'PENDING',
  "enumeratedThrough" TEXT,
  "projectedThrough" TEXT,
  "unresolvedCount" INTEGER NOT NULL DEFAULT 0,
  "retainedFrom" TIMESTAMP(3),
  "sourceWatermark" TEXT,
  "activatedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Phase2WorkCoverage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Phase2WorkCoverage_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Phase2WorkCoverage_identity_key"
  ON "Phase2WorkCoverage"("agencyId","family","generation");
CREATE INDEX IF NOT EXISTS "Phase2WorkCoverage_active_idx"
  ON "Phase2WorkCoverage"("agencyId","family","active");

CREATE TABLE IF NOT EXISTS "Phase2DependencyState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "dependencyKind" TEXT NOT NULL,
  "dependencyKey" TEXT NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Phase2DependencyState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Phase2DependencyState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Phase2DependencyState_identity_key"
  ON "Phase2DependencyState"("agencyId","dependencyKind","dependencyKey");
CREATE INDEX IF NOT EXISTS "Phase2DependencyState_revision_idx"
  ON "Phase2DependencyState"("agencyId","dependencyKind","revision");

CREATE OR REPLACE FUNCTION "phase2_domain_work_id"(p_agency TEXT, p_class TEXT, p_type TEXT, p_object TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN 'dwi_' || md5(COALESCE(p_agency,'') || E'\\x1f' || COALESCE(p_class,'') || E'\\x1f' || COALESCE(p_type,'') || E'\\x1f' || COALESCE(p_object,''));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION "phase2_publish_domain_work"(
  p_agency TEXT,
  p_class TEXT,
  p_type TEXT,
  p_object TEXT,
  p_partition TEXT DEFAULT NULL,
  p_creator TEXT DEFAULT NULL,
  p_account TEXT DEFAULT NULL,
  p_dependency_kind TEXT DEFAULT NULL,
  p_dependency_key TEXT DEFAULT NULL,
  p_dependency_revision BIGINT DEFAULT 0,
  p_available_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP
) RETURNS BIGINT AS $$
DECLARE v_revision BIGINT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_type IS NULL OR p_object IS NULL THEN RETURN 0; END IF;
  INSERT INTO "DomainWorkItem"(
    "id","agencyId","workClass","objectType","objectId","partitionKey","creatorId","accountId",
    "requestedRevision","completedRevision","activeGeneration","projectionVersion","state","availableAt",
    "dependencyKind","dependencyKey","dependencyRevision","createdAt","updatedAt"
  ) VALUES (
    "phase2_domain_work_id"(p_agency,p_class,p_type,p_object),p_agency,p_class,p_type,p_object,
    COALESCE(NULLIF(p_partition,''),p_agency),NULLIF(p_creator,''),NULLIF(p_account,''),
    1,0,'phase2_domain_work_v1','phase2_domain_work_v1','READY',COALESCE(p_available_at,CURRENT_TIMESTAMP),
    NULLIF(p_dependency_kind,''),NULLIF(p_dependency_key,''),COALESCE(p_dependency_revision,0),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId","workClass","objectType","objectId") DO UPDATE SET
    "requestedRevision" = "DomainWorkItem"."requestedRevision" + 1,
    "partitionKey" = EXCLUDED."partitionKey",
    "creatorId" = COALESCE(EXCLUDED."creatorId","DomainWorkItem"."creatorId"),
    "accountId" = COALESCE(EXCLUDED."accountId","DomainWorkItem"."accountId"),
    "dependencyKind" = EXCLUDED."dependencyKind",
    "dependencyKey" = EXCLUDED."dependencyKey",
    "dependencyRevision" = GREATEST("DomainWorkItem"."dependencyRevision",EXCLUDED."dependencyRevision"),
    "state" = CASE WHEN "DomainWorkItem"."state"='CLAIMED' THEN 'CLAIMED' ELSE 'READY' END,
    "availableAt" = LEAST("DomainWorkItem"."availableAt",EXCLUDED."availableAt"),
    "nextAttemptAt" = NULL,
    "progressCursor" = CASE WHEN "DomainWorkItem"."state"='CLAIMED' THEN "DomainWorkItem"."progressCursor" ELSE NULL END,
    "errorClass" = NULL,
    "lastError" = NULL,
    "terminalCause" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  RETURNING "requestedRevision" INTO v_revision;
  RETURN v_revision;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "phase2_bump_dependency"(p_agency TEXT,p_kind TEXT,p_key TEXT)
RETURNS BIGINT AS $$
DECLARE v_revision BIGINT;
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_kind IS NULL OR p_key IS NULL THEN RETURN 0; END IF;
  v_id := 'p2dep_' || md5(p_agency || E'\\x1f' || p_kind || E'\\x1f' || p_key);
  INSERT INTO "Phase2DependencyState"("id","agencyId","dependencyKind","dependencyKey","revision","changedAt","createdAt","updatedAt")
  VALUES(v_id,p_agency,p_kind,p_key,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT ("agencyId","dependencyKind","dependencyKey") DO UPDATE SET
    "revision"="Phase2DependencyState"."revision"+1,
    "changedAt"=CURRENT_TIMESTAMP,
    "updatedAt"=CURRENT_TIMESTAMP
  RETURNING "revision" INTO v_revision;
  UPDATE "DomainWorkItem"
     SET "state"='READY',"availableAt"=CURRENT_TIMESTAMP,"nextAttemptAt"=NULL,"errorClass"=NULL,"lastError"=NULL,"updatedAt"=CURRENT_TIMESTAMP
   WHERE "agencyId"=p_agency AND "state"='BLOCKED' AND "dependencyKind"=p_kind AND "dependencyKey"=p_key AND "dependencyRevision" < v_revision;
  RETURN v_revision;
END;
$$ LANGUAGE plpgsql;

-- Exact Custom order work publication. Metadata-only providerOperationalDirty remains rolling compatibility,
-- but the new executable authority is revisioned DomainWorkItem.
CREATE OR REPLACE FUNCTION "phase2_custom_order_domain_work_trigger"()
RETURNS TRIGGER AS $$
DECLARE v_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP='INSERT' THEN v_changed := TRUE;
  ELSE
    v_changed := OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."type" IS DISTINCT FROM NEW."type"
      OR OLD."scheduledAt" IS DISTINCT FROM NEW."scheduledAt"
      OR OLD."dueAt" IS DISTINCT FROM NEW."dueAt"
      OR OLD."physicalStatus" IS DISTINCT FROM NEW."physicalStatus"
      OR OLD."priceCents" IS DISTINCT FROM NEW."priceCents"
      OR OLD."paidAmountCents" IS DISTINCT FROM NEW."paidAmountCents"
      OR OLD."fanDeliveredAt" IS DISTINCT FROM NEW."fanDeliveredAt"
      OR OLD."telegramCancellationWaivedAt" IS DISTINCT FROM NEW."telegramCancellationWaivedAt"
      OR OLD."reminderConfig" IS DISTINCT FROM NEW."reminderConfig";
  END IF;
  IF v_changed THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."id",NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "CustomOrder_phase2_domain_work" ON "CustomOrder";
CREATE TRIGGER "CustomOrder_phase2_domain_work"
AFTER INSERT OR UPDATE OF "status","type","scheduledAt","dueAt","physicalStatus","priceCents","paidAmountCents","fanDeliveredAt","telegramCancellationWaivedAt","reminderConfig"
ON "CustomOrder" FOR EACH ROW EXECUTE FUNCTION "phase2_custom_order_domain_work_trigger"();

CREATE OR REPLACE FUNCTION "phase2_intent_domain_work_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."customOrderId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
      IF OLD."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER') THEN
        PERFORM "phase2_bump_dependency"(OLD."agencyId",'REMINDER_OUTCOME',OLD."customOrderId");
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."customOrderId" IS NOT NULL THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."customOrderId",NEW."creatorId",NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    IF NEW."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER') AND
       (TG_OP='INSERT' OR OLD."state" IS DISTINCT FROM NEW."state" OR OLD."outcomeReason" IS DISTINCT FROM NEW."outcomeReason" OR OLD."remoteMessageId" IS DISTINCT FROM NEW."remoteMessageId" OR OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt") THEN
      PERFORM "phase2_bump_dependency"(NEW."agencyId",'REMINDER_OUTCOME',NEW."customOrderId");
    END IF;
    IF NEW."state"='CONFIRMED' OR NEW."projectionBlockedAt" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(NEW."agencyId",'TELEGRAM_CONFIRMED_PROJECTION','TelegramDeliveryIntent',NEW."id",COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD."customOrderId" IS NOT NULL AND
     (OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "TelegramDeliveryIntent_phase2_domain_work" ON "TelegramDeliveryIntent";
CREATE TRIGGER "TelegramDeliveryIntent_phase2_domain_work"
AFTER INSERT OR DELETE OR UPDATE OF "customOrderId","accountId","kind","state","commitStartedAt","remoteMessageId","remoteSentAt","confirmedAt","projectionBlockedAt","providerBindingRetryAt","outcomeReason"
ON "TelegramDeliveryIntent" FOR EACH ROW EXECUTE FUNCTION "phase2_intent_domain_work_trigger"();

CREATE OR REPLACE FUNCTION "phase2_submission_domain_work_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."customOrderId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    END IF;
    RETURN OLD;
  END IF;

  PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_SOURCE_PIPELINE','CustomContentSubmission',NEW."id",NEW."creatorId",NEW."creatorId",NEW."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  IF NEW."customOrderId" IS NOT NULL THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."customOrderId",NEW."creatorId",NEW."creatorId",NEW."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;

  IF TG_OP='UPDATE' AND OLD."customOrderId" IS NOT NULL AND
     (OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "CustomContentSubmission_phase2_domain_work" ON "CustomContentSubmission";
CREATE TRIGGER "CustomContentSubmission_phase2_domain_work"
AFTER INSERT OR DELETE OR UPDATE OF "customOrderId","bindingRevision","reviewDecisionRevision","telegramSourceAccountId","telegramSourceUserId","telegramMessageIds","ofMediaIds","pipelineDisposition","reviewStatus"
ON "CustomContentSubmission" FOR EACH ROW EXECUTE FUNCTION "phase2_submission_domain_work_trigger"();

-- Creator binding/topology publication is a small dependency event. It does not synchronously
-- enumerate every affected Custom order under the config row lock.
CREATE OR REPLACE FUNCTION "phase2_creator_binding_dependency_trigger"()
RETURNS TRIGGER AS $$
DECLARE v_revision BIGINT;
BEGIN
  IF TG_OP='UPDATE' AND NOT (
      OLD."telegramContact" IS DISTINCT FROM NEW."telegramContact" OR
      OLD."telegramUserId" IS DISTINCT FROM NEW."telegramUserId" OR
      OLD."telegramAccountId" IS DISTINCT FROM NEW."telegramAccountId" OR
      OLD."status" IS DISTINCT FROM NEW."status" OR
      OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt") THEN RETURN NEW; END IF;
  v_revision := "phase2_bump_dependency"(NEW."agencyId",'CREATOR_BINDING',NEW."id");
  PERFORM "phase2_publish_domain_work"(NEW."agencyId",'DEPENDENCY_FANOUT','CreatorAccount',NEW."id",NEW."id",NEW."id",NEW."telegramAccountId",'CREATOR_BINDING',NEW."id",v_revision,CURRENT_TIMESTAMP);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "CreatorAccount_phase2_binding_dependency" ON "CreatorAccount";
CREATE TRIGGER "CreatorAccount_phase2_binding_dependency"
AFTER UPDATE OF "telegramContact","telegramUserId","telegramAccountId","status","deletedAt"
ON "CreatorAccount" FOR EACH ROW EXECUTE FUNCTION "phase2_creator_binding_dependency_trigger"();

CREATE OR REPLACE FUNCTION "phase2_account_topology_dependency_trigger"()
RETURNS TRIGGER AS $$
DECLARE
  v_agency TEXT;
  v_account TEXT;
  v_auto_revision BIGINT;
  v_account_revision BIGINT;
BEGIN
  IF TG_OP='UPDATE' AND OLD."lifecycleState" IS NOT DISTINCT FROM NEW."lifecycleState" THEN
    RETURN NEW;
  END IF;

  IF TG_OP='DELETE' THEN
    v_agency := OLD."agencyId";
    v_account := OLD."id";
  ELSE
    v_agency := NEW."agencyId";
    v_account := NEW."id";
  END IF;

  v_auto_revision := "phase2_bump_dependency"(v_agency,'AUTO_PROVIDER',v_agency);
  v_account_revision := "phase2_bump_dependency"(v_agency,'ACCOUNT_LIFECYCLE',v_account);
  PERFORM "phase2_publish_domain_work"(v_agency,'DEPENDENCY_FANOUT','AgencyTelegramMtprotoAccount',v_account,v_agency,NULL,v_account,'AUTO_PROVIDER',v_agency,v_auto_revision,CURRENT_TIMESTAMP);

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "AgencyTelegramMtprotoAccount_phase2_topology_dependency" ON "AgencyTelegramMtprotoAccount";
CREATE TRIGGER "AgencyTelegramMtprotoAccount_phase2_topology_dependency"
AFTER INSERT OR DELETE OR UPDATE OF "lifecycleState"
ON "AgencyTelegramMtprotoAccount" FOR EACH ROW EXECUTE FUNCTION "phase2_account_topology_dependency_trigger"();

-- Stop turning a row-lock no-op into a semantic lifecycle fanout in the old compatibility trigger.
CREATE OR REPLACE FUNCTION "phase2_provider_account_lifecycle_dirty_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."lifecycleState" IS NOT DISTINCT FROM NEW."lifecycleState" THEN RETURN NEW; END IF;
  UPDATE "CustomOrder" co
     SET "providerOperationalDirty" = TRUE
    FROM "CreatorAccount" ca
   WHERE ca."agencyId" = NEW."agencyId"
     AND ca."telegramAccountId" = NEW."id"
     AND co."agencyId" = ca."agencyId"
     AND co."creatorId" = ca."id"
     AND co."type" = 'CONTENT'
     AND co."status" = 'PENDING'
     AND co."providerOperationalDirty" IS DISTINCT FROM TRUE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Bootstrap current pending orders into the new executable work generation. This is not a recurring scan.
INSERT INTO "DomainWorkItem"(
  "id","agencyId","workClass","objectType","objectId","partitionKey","creatorId",
  "requestedRevision","completedRevision","activeGeneration","projectionVersion","state","availableAt","createdAt","updatedAt"
)
SELECT "phase2_domain_work_id"(co."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',co."id"),
       co."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',co."id",co."creatorId",co."creatorId",
       1,0,'phase2_domain_work_v1','phase2_domain_work_v1','READY',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  FROM "CustomOrder" co
 WHERE co."status"='PENDING'
ON CONFLICT ("agencyId","workClass","objectType","objectId") DO NOTHING;

-- R2: CustomOrder cleanup/reconciliation owns only provider capability/current-thread classes.
-- External proof debt survives order deletion until its exact proof projector classifies it.
CREATE OR REPLACE FUNCTION "phase2_provider_order_delete_cleanup_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "ProviderOperationalDebt"
   WHERE "agencyId" = OLD."agencyId" AND "customOrderId" = OLD."id"
     AND "debtClass" IN (
       'UNKNOWN_EXTERNAL_OUTCOME','PINNED_CANCELLATION_FOLLOWUP','CURRENT_PROVIDER_THREAD_CAPABILITY',
       'CANCELLATION_FOLLOWUP_DEBT','INCOMPLETE_SOURCE_RELAY','CONFIRMED_PROJECTION_DEBT','PROVIDER_BINDING_RETRY'
     );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- New dependency fanout is bounded and durable; retire the synchronous config->all-orders
-- compatibility triggers so creator/account locks no longer perform mass CustomOrder writes.
DROP TRIGGER IF EXISTS "CreatorAccount_provider_operational_dirty" ON "CreatorAccount";
DROP TRIGGER IF EXISTS "AgencyTelegramMtprotoAccount_provider_operational_dirty" ON "AgencyTelegramMtprotoAccount";

-- Agencies created after this generation has no pre-cutover Phase2 history. Once the
-- migration's live producers are installed, their current changes are captured transactionally,
-- so both historical-enumeration families can start active without a platform-global seeder.
CREATE OR REPLACE FUNCTION "phase2_new_agency_coverage_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "Phase2WorkCoverage"(
    "id","agencyId","family","generation","active","enumerationState",
    "unresolvedCount","sourceWatermark","activatedAt","completedAt","createdAt","updatedAt"
  ) VALUES
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'PROVIDER_OPERATIONAL' || E'\\x1f' || 'phase2_provider_operational_coverage_v1'),
      NEW."id",'PROVIDER_OPERATIONAL','phase2_provider_operational_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\\x1f' || 'CUSTOM_EXTERNAL_PROJECTION' || E'\\x1f' || 'phase2_custom_external_coverage_v1'),
      NEW."id",'CUSTOM_EXTERNAL_PROJECTION','phase2_custom_external_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT ("agencyId","family","generation") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Agency_phase2_initial_coverage" ON "Agency";
CREATE TRIGGER "Agency_phase2_initial_coverage"
AFTER INSERT ON "Agency" FOR EACH ROW EXECUTE FUNCTION "phase2_new_agency_coverage_trigger"();
