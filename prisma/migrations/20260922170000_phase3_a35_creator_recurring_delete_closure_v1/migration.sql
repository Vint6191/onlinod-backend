-- ONLINOD Phase 3 / A35 creator recurring-work delete closure.
--
-- A34 revoked recurring work with UPDATE from an AFTER DELETE CreatorAccount
-- trigger. The Phase2 indirect-owner fence correctly rejects that UPDATE after
-- the Creator identity is gone (SQLSTATE 23503). Physical deletion owns no
-- historical recurring-work fact, so remove that operational identity instead.

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
  -- DELETE must not UPDATE a creator-owned DomainWorkItem: its mandatory
  -- Phase2 owner fence resolves CreatorAccount and the identity is already absent
  -- inside an AFTER DELETE trigger. DELETE is also the correct lifecycle for this
  -- operational work root and lets the current-partition trigger conserve counts.
  IF TG_OP='DELETE' THEN
    DELETE FROM "DomainWorkItem"
     WHERE "agencyId"=OLD."agencyId"
       AND "workClass"=v_work_class
       AND "objectType"='CreatorAccount'
       AND "objectId"=OLD."id";
    RETURN OLD;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    v_old_eligible := OLD."status"='READY' AND OLD."deletedAt" IS NULL;
  END IF;
  v_new_eligible := NEW."status"='READY' AND NEW."deletedAt" IS NULL
    AND EXISTS (SELECT 1 FROM "Agency" a WHERE a."id"=NEW."agencyId" AND a."deletedAt" IS NULL);
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

  RETURN NEW;
END;
$$;
