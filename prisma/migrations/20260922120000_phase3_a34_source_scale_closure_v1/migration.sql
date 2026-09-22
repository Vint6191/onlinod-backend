-- ONLINOD Phase 3 / A34 final source + scale closure.
--
-- 1. HiddenOnlineUser is the only active/ignored/blocked authority. The Bumps
--    flags are an atomic operational projection maintained by a DB trigger.
-- 2. Creator recurring planning is durable DomainWorkItem work. READY lifecycle
--    changes publish/revoke one creator identity without replica-wide scans.

CREATE INDEX IF NOT EXISTS "HiddenOnlineUser_fanId_idx"
  ON "HiddenOnlineUser"("fanId");

-- Preserve legacy Bumps-only ignore/block choices before constraining the one
-- canonical status vocabulary. Existing Hidden rows win on conflict.
INSERT INTO "HiddenOnlineUser"(
  "id","agencyId","creatorId","fanId","dialogId","status","signals","metadata",
  "lastSignalAt","createdAt","updatedAt"
)
SELECT
  'phase3_hidden_' || md5(b."creatorId" || E'\x1f' || b."fanId"),
  b."agencyId",b."creatorId",b."fanId",COALESCE(b."dialogId",b."fanId"),
  CASE WHEN b."blocked" IS TRUE THEN 'blocked' ELSE 'ignored' END,
  '[]'::jsonb,
  jsonb_build_object('source','a34_bump_status_migration','migratedAt',CURRENT_TIMESTAMP),
  b."updatedAt",CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM "AutomationBumpFanState" b
WHERE (b."ignored" IS TRUE OR b."blocked" IS TRUE)
ON CONFLICT ("creatorId","fanId") DO NOTHING;

UPDATE "HiddenOnlineUser"
SET "status"='active',"updatedAt"=CURRENT_TIMESTAMP
WHERE "status" NOT IN ('active','ignored','blocked') OR "status" IS NULL;

ALTER TABLE "HiddenOnlineUser"
  DROP CONSTRAINT IF EXISTS "HiddenOnlineUser_status_authority_check";
ALTER TABLE "HiddenOnlineUser"
  ADD CONSTRAINT "HiddenOnlineUser_status_authority_check"
  CHECK ("status" IN ('active','ignored','blocked'));

-- Backfill only actionable status projections. Active rows do not create a
-- Bumps state unless one already exists, keeping the hot table bounded.
INSERT INTO "AutomationBumpFanState"(
  "id","agencyId","creatorId","fanId","dialogId","ignored","blocked",
  "templateIds","counters","metadata","createdAt","updatedAt"
)
SELECT
  'phase3_bump_' || md5(h."creatorId" || E'\x1f' || h."fanId"),
  h."agencyId",h."creatorId",h."fanId",COALESCE(h."dialogId",h."fanId"),
  h."status"='ignored',h."status"='blocked',
  '[]'::jsonb,'{}'::jsonb,
  jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM "HiddenOnlineUser" h
WHERE h."status" IN ('ignored','blocked')
ON CONFLICT ("creatorId","fanId") DO UPDATE SET
  "ignored"=EXCLUDED."ignored",
  "blocked"=EXCLUDED."blocked",
  "dialogId"=COALESCE(EXCLUDED."dialogId","AutomationBumpFanState"."dialogId"),
  "metadata"=COALESCE("AutomationBumpFanState"."metadata",'{}'::jsonb)
    || jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
  "updatedAt"=CURRENT_TIMESTAMP;

UPDATE "AutomationBumpFanState" b
SET "ignored"=FALSE,
    "blocked"=FALSE,
    "metadata"=COALESCE(b."metadata",'{}'::jsonb)
      || jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
    "updatedAt"=CURRENT_TIMESTAMP
FROM "HiddenOnlineUser" h
WHERE h."creatorId"=b."creatorId"
  AND h."fanId"=b."fanId"
  AND h."status"='active'
  AND (b."ignored" IS TRUE OR b."blocked" IS TRUE);

CREATE OR REPLACE FUNCTION "phase3_project_hidden_status_to_bump"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_creator_id TEXT;
  v_fan_id TEXT;
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE "AutomationBumpFanState"
       SET "ignored"=FALSE,
           "blocked"=FALSE,
           "metadata"=COALESCE("metadata",'{}'::jsonb)
             || jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
           "updatedAt"=CURRENT_TIMESTAMP
     WHERE "creatorId"=OLD."creatorId" AND "fanId"=OLD."fanId";
    RETURN OLD;
  END IF;

  IF TG_OP='UPDATE' AND OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
    RETURN NEW;
  END IF;

  IF NEW."status" IN ('ignored','blocked') THEN
    INSERT INTO "AutomationBumpFanState"(
      "id","agencyId","creatorId","fanId","dialogId","ignored","blocked",
      "templateIds","counters","metadata","createdAt","updatedAt"
    ) VALUES (
      'phase3_bump_' || md5(NEW."creatorId" || E'\x1f' || NEW."fanId"),
      NEW."agencyId",NEW."creatorId",NEW."fanId",COALESCE(NEW."dialogId",NEW."fanId"),
      NEW."status"='ignored',NEW."status"='blocked',
      '[]'::jsonb,'{}'::jsonb,
      jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    )
    ON CONFLICT ("creatorId","fanId") DO UPDATE SET
      "ignored"=EXCLUDED."ignored",
      "blocked"=EXCLUDED."blocked",
      "dialogId"=COALESCE(EXCLUDED."dialogId","AutomationBumpFanState"."dialogId"),
      "metadata"=COALESCE("AutomationBumpFanState"."metadata",'{}'::jsonb)
        || jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
      "updatedAt"=CURRENT_TIMESTAMP;
  ELSE
    UPDATE "AutomationBumpFanState"
       SET "ignored"=FALSE,
           "blocked"=FALSE,
           "metadata"=COALESCE("metadata",'{}'::jsonb)
             || jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
           "updatedAt"=CURRENT_TIMESTAMP
     WHERE "creatorId"=NEW."creatorId" AND "fanId"=NEW."fanId";
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_phase3_hidden_status_projection" ON "HiddenOnlineUser";
CREATE TRIGGER "trg_phase3_hidden_status_projection"
AFTER INSERT OR DELETE OR UPDATE OF "status" ON "HiddenOnlineUser"
FOR EACH ROW
EXECUTE FUNCTION "phase3_project_hidden_status_to_bump"();

-- One bounded recurring work identity per READY creator. The existing
-- DomainWork claim indexes provide cross-agency fairness and SKIP LOCKED
-- multi-replica admission without O(all creators) scheduler scans.
INSERT INTO "Phase2WorkGenerationAuthority"(
  "workClass","activeGeneration","projectionVersion","revision",
  "previousGeneration","activatedAt","createdAt","updatedAt"
) VALUES (
  'CREATOR_RECURRING_PLANNING','phase2_domain_work_v3_actual55',
  'phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
)
ON CONFLICT ("workClass") DO UPDATE SET
  "activeGeneration"=EXCLUDED."activeGeneration",
  "projectionVersion"=EXCLUDED."projectionVersion",
  "updatedAt"=CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "phase3_sync_creator_recurring_work"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_eligible BOOLEAN := FALSE;
  v_new_eligible BOOLEAN := FALSE;
  v_same_identity BOOLEAN := FALSE;
  v_work_class CONSTANT TEXT := 'CREATOR_RECURRING_PLANNING';
  v_generation CONSTANT TEXT := 'phase2_domain_work_v3_actual55';
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_eligible := OLD."status"='READY' AND OLD."deletedAt" IS NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_eligible := NEW."status"='READY' AND NEW."deletedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "Agency" a WHERE a."id"=NEW."agencyId" AND a."deletedAt" IS NULL);
  END IF;
  IF TG_OP='UPDATE' THEN
    v_same_identity := OLD."id"=NEW."id" AND OLD."agencyId"=NEW."agencyId";
  END IF;

  IF v_old_eligible AND NOT (v_new_eligible AND v_same_identity) THEN
    UPDATE "DomainWorkItem"
       SET "requestedRevision"="requestedRevision"+1,
           "completedRevision"="requestedRevision"+1,
           "state"='DONE',"isOutstanding"=FALSE,
           "ownerToken"=NULL,"leaseUntil"=CURRENT_TIMESTAMP,"nextAttemptAt"=NULL,
           "progressCursor"=NULL,"errorClass"=NULL,"lastError"=NULL,
           "terminalCause"='CREATOR_NOT_READY',"updatedAt"=CURRENT_TIMESTAMP
     WHERE "agencyId"=OLD."agencyId"
       AND "workClass"=v_work_class
       AND "objectType"='CreatorAccount'
       AND "objectId"=OLD."id";
  END IF;

  IF v_new_eligible AND NOT (v_old_eligible AND v_same_identity) THEN
    INSERT INTO "DomainWorkItem"(
      "id","agencyId","workClass","objectType","objectId","partitionKey","creatorId",
      "requestedRevision","completedRevision","activeGeneration","projectionVersion",
      "state","isOutstanding","availableAt","claimedRevision","claimFence","attempts",
      "dependencyRevision","createdAt","updatedAt"
    ) VALUES (
      'dwi_' || md5(NEW."agencyId" || E'\x1f' || v_work_class || E'\x1f' || 'CreatorAccount' || E'\x1f' || NEW."id"),
      NEW."agencyId",v_work_class,'CreatorAccount',NEW."id",NEW."id",NEW."id",
      1,0,v_generation,v_generation,'READY',TRUE,CURRENT_TIMESTAMP,0,0,0,0,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agencyId","workClass","objectType","objectId") DO UPDATE SET
      "requestedRevision"="DomainWorkItem"."requestedRevision"+1,
      "partitionKey"=EXCLUDED."partitionKey","creatorId"=EXCLUDED."creatorId",
      "activeGeneration"=EXCLUDED."activeGeneration","projectionVersion"=EXCLUDED."projectionVersion",
      "state"='READY',"isOutstanding"=TRUE,"availableAt"=CURRENT_TIMESTAMP,
      "ownerToken"=NULL,"leaseUntil"=CURRENT_TIMESTAMP,"nextAttemptAt"=NULL,
      "progressCursor"=NULL,"errorClass"=NULL,"lastError"=NULL,"terminalCause"=NULL,
      "updatedAt"=CURRENT_TIMESTAMP;
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_phase3_creator_recurring_work" ON "CreatorAccount";
CREATE TRIGGER "trg_phase3_creator_recurring_work"
AFTER INSERT OR DELETE OR UPDATE OF "status","deletedAt","agencyId" ON "CreatorAccount"
FOR EACH ROW
EXECUTE FUNCTION "phase3_sync_creator_recurring_work"();

INSERT INTO "DomainWorkItem"(
  "id","agencyId","workClass","objectType","objectId","partitionKey","creatorId",
  "requestedRevision","completedRevision","activeGeneration","projectionVersion",
  "state","isOutstanding","availableAt","claimedRevision","claimFence","attempts",
  "dependencyRevision","createdAt","updatedAt"
)
SELECT
  'dwi_' || md5(c."agencyId" || E'\x1f' || 'CREATOR_RECURRING_PLANNING' || E'\x1f' || 'CreatorAccount' || E'\x1f' || c."id"),
  c."agencyId",'CREATOR_RECURRING_PLANNING','CreatorAccount',c."id",c."id",c."id",
  1,0,'phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',
  'READY',TRUE,CURRENT_TIMESTAMP,0,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM "CreatorAccount" c
JOIN "Agency" a ON a."id"=c."agencyId" AND a."deletedAt" IS NULL
WHERE c."status"='READY' AND c."deletedAt" IS NULL
ON CONFLICT ("agencyId","workClass","objectType","objectId") DO UPDATE SET
  "partitionKey"=EXCLUDED."partitionKey","creatorId"=EXCLUDED."creatorId",
  "activeGeneration"=EXCLUDED."activeGeneration","projectionVersion"=EXCLUDED."projectionVersion",
  "state"=CASE WHEN "DomainWorkItem"."state"='CLAIMED' THEN 'CLAIMED' ELSE 'READY' END,
  "isOutstanding"=TRUE,
  "availableAt"=LEAST("DomainWorkItem"."availableAt",CURRENT_TIMESTAMP),
  "terminalCause"=NULL,"updatedAt"=CURRENT_TIMESTAMP;
