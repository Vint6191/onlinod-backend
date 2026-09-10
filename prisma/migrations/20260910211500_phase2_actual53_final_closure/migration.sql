-- Actual 53 Phase 2 final cohesive closure foundation.
-- Root A/F/B infrastructure: durable generation authority, physically current work locators,
-- live convergence state, temporal-signature correction, reminder/current projection support.

ALTER TABLE "DomainWorkItem"
  ADD COLUMN IF NOT EXISTS "isOutstanding" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "DomainWorkItem"
   SET "isOutstanding" = TRUE
 WHERE "state" <> 'DONE' OR "requestedRevision" > "completedRevision";

ALTER TABLE "DomainWorkItem" ALTER COLUMN "isOutstanding" SET DEFAULT TRUE;
ALTER TABLE "DomainWorkItem" ALTER COLUMN "activeGeneration" SET DEFAULT 'phase2_domain_work_v2_actual53';
ALTER TABLE "DomainWorkItem" ALTER COLUMN "projectionVersion" SET DEFAULT 'phase2_domain_work_v2_actual53';

CREATE TABLE IF NOT EXISTS "Phase2WorkGenerationAuthority" (
  "workClass" TEXT NOT NULL,
  "activeGeneration" TEXT NOT NULL,
  "projectionVersion" TEXT NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "previousGeneration" TEXT,
  "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Phase2WorkGenerationAuthority_pkey" PRIMARY KEY ("workClass")
);

CREATE TABLE IF NOT EXISTS "Phase2WorkFamilyState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "workClass" TEXT NOT NULL,
  "activeGeneration" TEXT NOT NULL,
  "outstandingCount" INTEGER NOT NULL DEFAULT 0,
  "requestedSequence" BIGINT NOT NULL DEFAULT 0,
  "convergedSequence" BIGINT NOT NULL DEFAULT 0,
  "lastRequestedAt" TIMESTAMP(3),
  "lastConvergedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Phase2WorkFamilyState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Phase2WorkFamilyState_identity_key"
  ON "Phase2WorkFamilyState"("agencyId","workClass");
CREATE INDEX IF NOT EXISTS "Phase2WorkFamilyState_outstanding_idx"
  ON "Phase2WorkFamilyState"("agencyId","outstandingCount","workClass");

CREATE TABLE IF NOT EXISTS "DomainWorkReadyPartition" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "workClass" TEXT NOT NULL,
  "partitionKey" TEXT NOT NULL,
  "activeGeneration" TEXT NOT NULL,
  "headWorkId" TEXT NOT NULL,
  "nextDueAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkReadyPartition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DomainWorkReadyPartition_identity_key"
  ON "DomainWorkReadyPartition"("agencyId","workClass","partitionKey");
CREATE INDEX IF NOT EXISTS "DomainWorkReadyPartition_due_idx"
  ON "DomainWorkReadyPartition"("agencyId","workClass","activeGeneration","nextDueAt","partitionKey");

CREATE TABLE IF NOT EXISTS "DomainWorkReadyAgency" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "workClass" TEXT NOT NULL,
  "activeGeneration" TEXT NOT NULL,
  "nextDueAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkReadyAgency_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DomainWorkReadyAgency_identity_key"
  ON "DomainWorkReadyAgency"("agencyId","workClass");
CREATE INDEX IF NOT EXISTS "DomainWorkReadyAgency_due_idx"
  ON "DomainWorkReadyAgency"("workClass","activeGeneration","nextDueAt","agencyId");

CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_partition_idx"
  ON "DomainWorkItem"("agencyId","workClass","partitionKey","activeGeneration","availableAt","id")
  WHERE "isOutstanding"=TRUE;
CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_class_idx"
  ON "DomainWorkItem"("agencyId","workClass","activeGeneration","id")
  WHERE "isOutstanding"=TRUE;

-- Actual53 is a new immutable work-generation contract. A DB authority row, not a binary
-- constant, decides which generation is allowed to own newly published/executed work.
INSERT INTO "Phase2WorkGenerationAuthority"(
  "workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt"
)
SELECT v."workClass",'phase2_domain_work_v2_actual53','phase2_domain_work_v2_actual53',2,
       'phase2_domain_work_v1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM (VALUES
 ('CUSTOM_COMMUNICATION'),('CUSTOM_REMINDER'),('CUSTOM_SOURCE_PIPELINE'),
 ('TELEGRAM_CONFIRMED_PROJECTION'),('TELEGRAM_INBOUND_PROJECTION'),('CUSTOM_EXTERNAL_PROJECTION'),
 ('TEAM_DIALOG_PROJECTION'),('TEAM_RESPONSE_RANGE_REPAIR'),('TEAM_MONEY_RECONCILIATION'),
 ('TEAM_READ_SUMMARY'),('DEPENDENCY_FANOUT'),('HISTORICAL_ENUMERATION'),('RETENTION'),
 ('DESTRUCTIVE_CREATOR_CLEANUP')
) AS v("workClass")
ON CONFLICT ("workClass") DO UPDATE SET
  "previousGeneration"=CASE
    WHEN "Phase2WorkGenerationAuthority"."activeGeneration" <> EXCLUDED."activeGeneration"
    THEN "Phase2WorkGenerationAuthority"."activeGeneration"
    ELSE "Phase2WorkGenerationAuthority"."previousGeneration"
  END,
  "activeGeneration"=EXCLUDED."activeGeneration",
  "projectionVersion"=EXCLUDED."projectionVersion",
  "revision"=CASE
    WHEN "Phase2WorkGenerationAuthority"."activeGeneration" <> EXCLUDED."activeGeneration"
    THEN "Phase2WorkGenerationAuthority"."revision"+1
    ELSE "Phase2WorkGenerationAuthority"."revision"
  END,
  "activatedAt"=CASE
    WHEN "Phase2WorkGenerationAuthority"."activeGeneration" <> EXCLUDED."activeGeneration"
    THEN CURRENT_TIMESTAMP ELSE "Phase2WorkGenerationAuthority"."activatedAt" END,
  "updatedAt"=CURRENT_TIMESTAMP;

-- Fence only the physically current workset into the new generation. Historical DONE rows are
-- intentionally not rewritten: hot operations no longer depend on lifetime DONE history.
UPDATE "DomainWorkItem" d
   SET "activeGeneration"=a."activeGeneration",
       "projectionVersion"=a."projectionVersion",
       "state"=CASE WHEN d."state"='CLAIMED' THEN 'READY' ELSE d."state" END,
       "ownerToken"=NULL,
       "claimedRevision"=0,
       "claimFence"=d."claimFence"+1,
       "leaseUntil"=NULL,
       "nextAttemptAt"=CASE WHEN d."state"='CLAIMED' THEN NULL ELSE d."nextAttemptAt" END,
       "updatedAt"=CURRENT_TIMESTAMP
  FROM "Phase2WorkGenerationAuthority" a
 WHERE d."workClass"=a."workClass"
   AND d."isOutstanding"=TRUE
   AND d."activeGeneration" IS DISTINCT FROM a."activeGeneration";

CREATE OR REPLACE FUNCTION "phase2_current_domain_work_generation"(p_class TEXT)
RETURNS TEXT AS $$
DECLARE v_generation TEXT;
BEGIN
  SELECT "activeGeneration" INTO v_generation
    FROM "Phase2WorkGenerationAuthority"
   WHERE "workClass"=p_class;
  RETURN COALESCE(v_generation,'phase2_domain_work_v2_actual53');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "phase2_current_domain_work_projection"(p_class TEXT)
RETURNS TEXT AS $$
DECLARE v_projection TEXT;
BEGIN
  SELECT "projectionVersion" INTO v_projection
    FROM "Phase2WorkGenerationAuthority"
   WHERE "workClass"=p_class;
  RETURN COALESCE(v_projection,'phase2_domain_work_v2_actual53');
END;
$$ LANGUAGE plpgsql STABLE;

-- The DB itself fences stale/rolling binaries. Old binaries may still pass v1 literals, but any
-- write to DomainWorkItem is rewritten to the durable active generation. Crossing a generation
-- invalidates old ownership before the mutation can become visible.
CREATE OR REPLACE FUNCTION "phase2_enforce_domain_work_generation"()
RETURNS TRIGGER AS $$
DECLARE v_generation TEXT;
DECLARE v_projection TEXT;
BEGIN
  v_generation := "phase2_current_domain_work_generation"(NEW."workClass");
  v_projection := "phase2_current_domain_work_projection"(NEW."workClass");

  IF TG_OP='INSERT' THEN
    NEW."activeGeneration" := v_generation;
    NEW."projectionVersion" := v_projection;
  ELSIF NEW."activeGeneration" IS DISTINCT FROM v_generation
     OR OLD."activeGeneration" IS DISTINCT FROM v_generation THEN
    NEW."activeGeneration" := v_generation;
    NEW."projectionVersion" := v_projection;
    NEW."requestedRevision" := GREATEST(NEW."requestedRevision",OLD."requestedRevision"+1);
    NEW."claimFence" := GREATEST(NEW."claimFence",OLD."claimFence"+1);
    NEW."claimedRevision" := 0;
    NEW."ownerToken" := NULL;
    NEW."leaseUntil" := NULL;
    NEW."nextAttemptAt" := NULL;
    NEW."progressCursor" := NULL;
    NEW."errorClass" := NULL;
    NEW."lastError" := NULL;
    NEW."terminalCause" := NULL;
    NEW."state" := CASE WHEN OLD."state"='BLOCKED' THEN 'BLOCKED' ELSE 'READY' END;
  END IF;

  NEW."isOutstanding" := (NEW."state" <> 'DONE' OR NEW."requestedRevision" > NEW."completedRevision");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_phase2_enforce_domain_work_generation" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase2_enforce_domain_work_generation"
BEFORE INSERT OR UPDATE ON "DomainWorkItem"
FOR EACH ROW EXECUTE FUNCTION "phase2_enforce_domain_work_generation"();

CREATE OR REPLACE FUNCTION "phase2_adjust_work_family_state"(
  p_agency TEXT,p_class TEXT,p_generation TEXT,p_outstanding_delta INTEGER,p_requested_delta BIGINT,p_requested_at TIMESTAMP(3)
) RETURNS VOID AS $$
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL THEN RETURN; END IF;
  v_id := 'p2wfs_' || md5(p_agency || E'\x1f' || p_class);
  INSERT INTO "Phase2WorkFamilyState"(
    "id","agencyId","workClass","activeGeneration","outstandingCount","requestedSequence","convergedSequence",
    "lastRequestedAt","lastConvergedAt","createdAt","updatedAt"
  ) VALUES (
    v_id,p_agency,p_class,COALESCE(p_generation,"phase2_current_domain_work_generation"(p_class)),
    GREATEST(0,COALESCE(p_outstanding_delta,0)),GREATEST(0,COALESCE(p_requested_delta,0)),
    CASE WHEN COALESCE(p_outstanding_delta,0) <= 0 THEN GREATEST(0,COALESCE(p_requested_delta,0)) ELSE 0 END,
    CASE WHEN COALESCE(p_requested_delta,0)>0 THEN COALESCE(p_requested_at,CURRENT_TIMESTAMP) ELSE NULL END,
    CASE WHEN COALESCE(p_outstanding_delta,0)<=0 THEN CURRENT_TIMESTAMP ELSE NULL END,
    CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId","workClass") DO UPDATE SET
    "activeGeneration"=COALESCE(p_generation,"Phase2WorkFamilyState"."activeGeneration"),
    "outstandingCount"=GREATEST(0,"Phase2WorkFamilyState"."outstandingCount"+COALESCE(p_outstanding_delta,0)),
    "requestedSequence"="Phase2WorkFamilyState"."requestedSequence"+GREATEST(0,COALESCE(p_requested_delta,0)),
    "convergedSequence"=CASE
      WHEN GREATEST(0,"Phase2WorkFamilyState"."outstandingCount"+COALESCE(p_outstanding_delta,0))=0
      THEN "Phase2WorkFamilyState"."requestedSequence"+GREATEST(0,COALESCE(p_requested_delta,0))
      ELSE "Phase2WorkFamilyState"."convergedSequence" END,
    "lastRequestedAt"=CASE WHEN COALESCE(p_requested_delta,0)>0 THEN COALESCE(p_requested_at,CURRENT_TIMESTAMP)
                           ELSE "Phase2WorkFamilyState"."lastRequestedAt" END,
    "lastConvergedAt"=CASE
      WHEN GREATEST(0,"Phase2WorkFamilyState"."outstandingCount"+COALESCE(p_outstanding_delta,0))=0
      THEN CURRENT_TIMESTAMP ELSE "Phase2WorkFamilyState"."lastConvergedAt" END,
    "updatedAt"=CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- Seed live convergence only from current work. Absence of a row means no live work has ever been
-- requested for that family since this generation; readers combine this with historical coverage.
INSERT INTO "Phase2WorkFamilyState"(
  "id","agencyId","workClass","activeGeneration","outstandingCount","requestedSequence","convergedSequence",
  "lastRequestedAt","lastConvergedAt","createdAt","updatedAt"
)
SELECT 'p2wfs_' || md5(d."agencyId" || E'\x1f' || d."workClass"),
       d."agencyId",d."workClass",MAX(d."activeGeneration"),
       COUNT(*)::integer,GREATEST(COUNT(*)::bigint,1),0,
       MAX(d."updatedAt"),NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  FROM "DomainWorkItem" d
 WHERE d."isOutstanding"=TRUE
 GROUP BY d."agencyId",d."workClass"
ON CONFLICT ("agencyId","workClass") DO UPDATE SET
  "activeGeneration"=EXCLUDED."activeGeneration",
  "outstandingCount"=EXCLUDED."outstandingCount",
  "requestedSequence"=GREATEST("Phase2WorkFamilyState"."requestedSequence",EXCLUDED."requestedSequence"),
  "updatedAt"=CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "phase2_domain_work_family_state_trigger"()
RETURNS TRIGGER AS $$
DECLARE old_out INTEGER := 0;
DECLARE new_out INTEGER := 0;
DECLARE req_delta BIGINT := 0;
BEGIN
  IF TG_OP='INSERT' THEN
    new_out := CASE WHEN NEW."isOutstanding" THEN 1 ELSE 0 END;
    req_delta := GREATEST(NEW."requestedRevision",0);
    PERFORM "phase2_adjust_work_family_state"(NEW."agencyId",NEW."workClass",NEW."activeGeneration",new_out,req_delta,NEW."updatedAt");
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    old_out := CASE WHEN OLD."isOutstanding" THEN 1 ELSE 0 END;
    IF old_out<>0 THEN
      PERFORM "phase2_adjust_work_family_state"(OLD."agencyId",OLD."workClass",OLD."activeGeneration",-old_out,0,NULL);
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."agencyId" IS DISTINCT FROM NEW."agencyId" OR OLD."workClass" IS DISTINCT FROM NEW."workClass" THEN
    old_out := CASE WHEN OLD."isOutstanding" THEN 1 ELSE 0 END;
    new_out := CASE WHEN NEW."isOutstanding" THEN 1 ELSE 0 END;
    IF old_out<>0 THEN
      PERFORM "phase2_adjust_work_family_state"(OLD."agencyId",OLD."workClass",OLD."activeGeneration",-old_out,0,NULL);
    END IF;
    PERFORM "phase2_adjust_work_family_state"(NEW."agencyId",NEW."workClass",NEW."activeGeneration",new_out,GREATEST(NEW."requestedRevision",0),NEW."updatedAt");
    RETURN NEW;
  END IF;

  old_out := CASE WHEN OLD."isOutstanding" THEN 1 ELSE 0 END;
  new_out := CASE WHEN NEW."isOutstanding" THEN 1 ELSE 0 END;
  req_delta := GREATEST(NEW."requestedRevision"-OLD."requestedRevision",0);
  IF old_out<>new_out OR req_delta>0 OR OLD."activeGeneration" IS DISTINCT FROM NEW."activeGeneration" THEN
    PERFORM "phase2_adjust_work_family_state"(
      NEW."agencyId",NEW."workClass",NEW."activeGeneration",new_out-old_out,req_delta,
      CASE WHEN req_delta>0 THEN NEW."updatedAt" ELSE NULL END
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_phase2_domain_work_family_state" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase2_domain_work_family_state"
AFTER INSERT OR UPDATE OR DELETE ON "DomainWorkItem"
FOR EACH ROW EXECUTE FUNCTION "phase2_domain_work_family_state_trigger"();

CREATE OR REPLACE FUNCTION "phase2_refresh_domain_work_agency_head"(p_agency TEXT,p_class TEXT)
RETURNS VOID AS $$
DECLARE v_generation TEXT;
DECLARE v_due TIMESTAMP(3);
DECLARE v_id TEXT;
BEGIN
  v_generation := "phase2_current_domain_work_generation"(p_class);
  SELECT MIN(p."nextDueAt") INTO v_due
    FROM "DomainWorkReadyPartition" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_class AND p."activeGeneration"=v_generation;
  v_id := 'dwra_' || md5(p_agency || E'\x1f' || p_class);
  IF v_due IS NULL THEN
    DELETE FROM "DomainWorkReadyAgency" WHERE "agencyId"=p_agency AND "workClass"=p_class;
  ELSE
    INSERT INTO "DomainWorkReadyAgency"("id","agencyId","workClass","activeGeneration","nextDueAt","createdAt","updatedAt")
    VALUES(v_id,p_agency,p_class,v_generation,v_due,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT ("agencyId","workClass") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration","nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "phase2_refresh_domain_work_partition_head"(p_agency TEXT,p_class TEXT,p_partition TEXT)
RETURNS VOID AS $$
DECLARE v_generation TEXT;
DECLARE v_work TEXT;
DECLARE v_due TIMESTAMP(3);
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_partition IS NULL THEN RETURN; END IF;
  v_generation := "phase2_current_domain_work_generation"(p_class);
  SELECT d."id",
         GREATEST(
           d."availableAt",
           COALESCE(d."nextAttemptAt",d."availableAt"),
           CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
         )
    INTO v_work,v_due
    FROM "DomainWorkItem" d
   WHERE d."agencyId"=p_agency
     AND d."workClass"=p_class
     AND d."partitionKey"=p_partition
     AND d."activeGeneration"=v_generation
     AND d."isOutstanding"=TRUE
     AND d."state" IN ('READY','CLAIMED')
   ORDER BY GREATEST(
           d."availableAt",
           COALESCE(d."nextAttemptAt",d."availableAt"),
           CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
         ),d."id"
   LIMIT 1;

  v_id := 'dwrp_' || md5(p_agency || E'\x1f' || p_class || E'\x1f' || p_partition);
  IF v_work IS NULL THEN
    DELETE FROM "DomainWorkReadyPartition"
     WHERE "agencyId"=p_agency AND "workClass"=p_class AND "partitionKey"=p_partition;
  ELSE
    INSERT INTO "DomainWorkReadyPartition"(
      "id","agencyId","workClass","partitionKey","activeGeneration","headWorkId","nextDueAt","createdAt","updatedAt"
    ) VALUES(v_id,p_agency,p_class,p_partition,v_generation,v_work,v_due,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration","headWorkId"=EXCLUDED."headWorkId",
      "nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;
  END IF;
  PERFORM "phase2_refresh_domain_work_agency_head"(p_agency,p_class);
END;
$$ LANGUAGE plpgsql;

-- Seed physically current ready heads from current outstanding work only.
INSERT INTO "DomainWorkReadyPartition"(
  "id","agencyId","workClass","partitionKey","activeGeneration","headWorkId","nextDueAt","createdAt","updatedAt"
)
SELECT 'dwrp_' || md5(x."agencyId" || E'\x1f' || x."workClass" || E'\x1f' || x."partitionKey"),
       x."agencyId",x."workClass",x."partitionKey",x."activeGeneration",x."id",x."nextDueAt",CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (d."agencyId",d."workClass",d."partitionKey")
         d."agencyId",d."workClass",d."partitionKey",d."activeGeneration",d."id",
         GREATEST(
           d."availableAt",COALESCE(d."nextAttemptAt",d."availableAt"),
           CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
         ) AS "nextDueAt"
    FROM "DomainWorkItem" d
   WHERE d."isOutstanding"=TRUE AND d."state" IN ('READY','CLAIMED')
   ORDER BY d."agencyId",d."workClass",d."partitionKey",
            GREATEST(
              d."availableAt",COALESCE(d."nextAttemptAt",d."availableAt"),
              CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
            ),d."id"
) x
ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
  "activeGeneration"=EXCLUDED."activeGeneration","headWorkId"=EXCLUDED."headWorkId",
  "nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;

INSERT INTO "DomainWorkReadyAgency"("id","agencyId","workClass","activeGeneration","nextDueAt","createdAt","updatedAt")
SELECT 'dwra_' || md5(p."agencyId" || E'\x1f' || p."workClass"),
       p."agencyId",p."workClass",MAX(p."activeGeneration"),MIN(p."nextDueAt"),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  FROM "DomainWorkReadyPartition" p
 GROUP BY p."agencyId",p."workClass"
ON CONFLICT ("agencyId","workClass") DO UPDATE SET
  "activeGeneration"=EXCLUDED."activeGeneration","nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "phase2_domain_work_ready_head_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM "phase2_refresh_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE'
     AND (OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
       OR OLD."workClass" IS DISTINCT FROM NEW."workClass"
       OR OLD."partitionKey" IS DISTINCT FROM NEW."partitionKey") THEN
    PERFORM "phase2_refresh_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
  END IF;
  PERFORM "phase2_refresh_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_phase2_domain_work_ready_head" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase2_domain_work_ready_head"
AFTER INSERT OR UPDATE OR DELETE ON "DomainWorkItem"
FOR EACH ROW EXECUTE FUNCTION "phase2_domain_work_ready_head_trigger"();

-- F53-01: remove the timestamp-without-time-zone overload before installing the exact
-- timestamptz signature used by CURRENT_TIMESTAMP trigger callers.
DROP FUNCTION IF EXISTS "phase2_publish_domain_work"(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TIMESTAMP WITHOUT TIME ZONE
);

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
  p_available_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
) RETURNS BIGINT AS $$
DECLARE v_revision BIGINT;
DECLARE v_generation TEXT;
DECLARE v_projection TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_type IS NULL OR p_object IS NULL THEN RETURN 0; END IF;
  v_generation := "phase2_current_domain_work_generation"(p_class);
  v_projection := "phase2_current_domain_work_projection"(p_class);

  INSERT INTO "DomainWorkItem"(
    "id","agencyId","workClass","objectType","objectId","partitionKey","creatorId","accountId",
    "requestedRevision","completedRevision","activeGeneration","projectionVersion","state","isOutstanding","availableAt",
    "dependencyKind","dependencyKey","dependencyRevision","createdAt","updatedAt"
  ) VALUES (
    "phase2_domain_work_id"(p_agency,p_class,p_type,p_object),p_agency,p_class,p_type,p_object,
    COALESCE(NULLIF(p_partition,''),p_agency),NULLIF(p_creator,''),NULLIF(p_account,''),
    1,0,v_generation,v_projection,'READY',TRUE,COALESCE(p_available_at,CURRENT_TIMESTAMP),
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
    "isOutstanding"=TRUE,
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

-- Current Team projection needs incremental order state, not an ever-growing unanswered-history
-- scan for every normal live event.
ALTER TABLE "TeamPendingDialogStateCurrent"
  ADD COLUMN IF NOT EXISTS "lastAppliedEventAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastAppliedEventId" TEXT;

UPDATE "TeamPendingDialogStateCurrent" p
   SET "lastAppliedEventAt"=e."ts",
       "lastAppliedEventId"=e."id"
  FROM "TeamActivityEvent" e
 WHERE p."lastAppliedEventAt" IS NULL
   AND p."lastProjectionSourceId"=e."id"
   AND p."agencyId"=e."agencyId";

CREATE INDEX IF NOT EXISTS "TeamActivityEvent_dialog_kind_order_idx"
  ON "TeamActivityEvent"("agencyId","creatorId","dialogId","eventKind","ts","id");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_dialog_message_identity_idx"
  ON "TeamActivityEvent"("agencyId","creatorId","dialogId","eventKind","messageId","ts","id");

-- ---------------------------------------------------------------------------
-- Actual53 ROOT C / F53-09: canonical Team money classification is a peer-set
-- property. A live root update must never turn one historical AMBIGUOUS member
-- into CANONICAL merely because that one ledger row was reprojected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "phase2_reclassify_team_money_peer_set"(
  p_agency_id TEXT,
  p_source_type TEXT,
  p_business_key TEXT
) RETURNS VOID AS $$
DECLARE
  peer_count INTEGER := 0;
  next_state TEXT;
  next_reason TEXT;
BEGIN
  IF p_business_key IS NULL OR btrim(p_business_key) = '' THEN
    RETURN;
  END IF;

  -- The peer lock is acquired by the caller before the fact mutation. Counting
  -- two rows is sufficient to distinguish the only supported states while the
  -- business-key index keeps discovery bounded in the normal case.
  SELECT count(*) INTO peer_count
  FROM (
    SELECT "id"
    FROM "TeamMoneyAttributionFact"
    WHERE "agencyId" = p_agency_id
      AND "sourceType" = p_source_type
      AND "canonicalBusinessKey" = p_business_key
    ORDER BY "id" ASC
    LIMIT 2
  ) AS peers;

  IF peer_count = 1 THEN
    next_state := 'CANONICAL';
    next_reason := NULL;
  ELSIF peer_count > 1 THEN
    next_state := 'AMBIGUOUS';
    next_reason := 'MULTIPLE_FACT_GENERATIONS:' || peer_count::TEXT || '+';
  ELSE
    RETURN;
  END IF;

  UPDATE "TeamMoneyAttributionFact"
  SET "classificationState" = next_state,
      "classificationReason" = next_reason,
      "classificationVersion" = 'team_money_root_classification_v1',
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "agencyId" = p_agency_id
    AND "sourceType" = p_source_type
    AND "canonicalBusinessKey" = p_business_key
    AND (
      "classificationState" IS DISTINCT FROM next_state
      OR "classificationReason" IS DISTINCT FROM next_reason
      OR "classificationVersion" IS DISTINCT FROM 'team_money_root_classification_v1'
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION onlinod_project_team_ppv_fact_v2()
RETURNS TRIGGER AS $$
DECLARE
  business_key TEXT;
  previous_business_key TEXT;
  first_lock_key TEXT;
  second_lock_key TEXT;
BEGIN
  business_key := CASE
    WHEN NEW."creatorSaleId" IS NOT NULL THEN 'sale:' || NEW."creatorSaleId"
    WHEN NEW."financialTransactionId" IS NOT NULL THEN 'financial:' || NEW."financialTransactionId"
    ELSE NULL
  END;

  SELECT "canonicalBusinessKey" INTO previous_business_key
  FROM "TeamMoneyAttributionFact"
  WHERE "agencyId" = NEW."agencyId" AND "sourceType" = 'PPV' AND "sourceRowId" = NEW."id";

  -- Lock both the former and current peer-set identities in deterministic
  -- lexical order. Concurrent duplicate generations therefore cannot each see
  -- themselves as the sole canonical peer and commit two CANONICAL facts.
  IF previous_business_key IS NOT NULL AND business_key IS NOT NULL AND previous_business_key <> business_key THEN
    first_lock_key := LEAST(previous_business_key, business_key);
    second_lock_key := GREATEST(previous_business_key, business_key);
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || first_lock_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || second_lock_key, 0));
  ELSIF COALESCE(business_key, previous_business_key) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || COALESCE(business_key, previous_business_key), 0));
  END IF;

  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "canonicalBusinessKey",
    "classificationState", "classificationReason", "classificationVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'ppv_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'PPV', NEW."id", NEW."purchaseId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", COALESCE(NEW."fanId", NEW."buyerFanId"), NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."purchasedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    COALESCE(NEW."financialTransactionId", NEW."creatorSaleId"), NEW."creatorSaleId", NEW."financialTransactionId", NULL,
    NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP), NEW."id", 'team_money_root_v2', business_key,
    CASE WHEN business_key IS NULL THEN 'INCOMPLETE' ELSE 'PENDING' END,
    CASE WHEN business_key IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING' ELSE 'PEER_SET_RECLASSIFICATION_PENDING' END,
    'team_money_root_classification_v1', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId"=EXCLUDED."externalId", "creatorId"=EXCLUDED."creatorId", "memberId"=EXCLUDED."memberId",
    "userId"=EXCLUDED."userId", "fanId"=EXCLUDED."fanId", "dialogId"=EXCLUDED."dialogId",
    "amountCents"=EXCLUDED."amountCents", "currency"=EXCLUDED."currency", "occurredAt"=EXCLUDED."occurredAt",
    "businessStatus"=EXCLUDED."businessStatus", "financialStatus"=EXCLUDED."financialStatus",
    "attributionActive"=EXCLUDED."attributionActive", "canonicalMoneyId"=EXCLUDED."canonicalMoneyId",
    "creatorSaleId"=EXCLUDED."creatorSaleId", "financialTransactionId"=EXCLUDED."financialTransactionId",
    "creatorTipId"=EXCLUDED."creatorTipId", "attributionBasis"=EXCLUDED."attributionBasis",
    "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt", "rootId"=EXCLUDED."rootId", "rootVersion"='team_money_root_v2',
    "canonicalBusinessKey"=EXCLUDED."canonicalBusinessKey",
    "classificationState"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'INCOMPLETE'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationState"
    END,
    "classificationReason"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PEER_SET_RECLASSIFICATION_PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationReason"
    END,
    "classificationVersion"='team_money_root_classification_v1',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;

  PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'PPV', business_key);
  IF previous_business_key IS NOT NULL AND previous_business_key IS DISTINCT FROM business_key THEN
    PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'PPV', previous_business_key);
  END IF;

  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION onlinod_project_team_tip_fact_v2()
RETURNS TRIGGER AS $$
DECLARE
  business_key TEXT;
  previous_business_key TEXT;
  first_lock_key TEXT;
  second_lock_key TEXT;
BEGIN
  business_key := CASE WHEN NEW."creatorTipId" IS NOT NULL THEN 'tip:' || NEW."creatorTipId" ELSE NULL END;

  SELECT "canonicalBusinessKey" INTO previous_business_key
  FROM "TeamMoneyAttributionFact"
  WHERE "agencyId" = NEW."agencyId" AND "sourceType" = 'TIP' AND "sourceRowId" = NEW."id";

  IF previous_business_key IS NOT NULL AND business_key IS NOT NULL AND previous_business_key <> business_key THEN
    first_lock_key := LEAST(previous_business_key, business_key);
    second_lock_key := GREATEST(previous_business_key, business_key);
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || first_lock_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || second_lock_key, 0));
  ELSIF COALESCE(business_key, previous_business_key) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || COALESCE(business_key, previous_business_key), 0));
  END IF;

  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "canonicalBusinessKey",
    "classificationState", "classificationReason", "classificationVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'tip_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'TIP', NEW."id", NEW."tipId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", NEW."fanId", NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."receivedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'claimed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    NEW."creatorTipId", NULL, NULL, NEW."creatorTipId", NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    NEW."id", 'team_money_root_v2', business_key,
    CASE WHEN business_key IS NULL THEN 'INCOMPLETE' ELSE 'PENDING' END,
    CASE WHEN business_key IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING' ELSE 'PEER_SET_RECLASSIFICATION_PENDING' END,
    'team_money_root_classification_v1', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId"=EXCLUDED."externalId", "creatorId"=EXCLUDED."creatorId", "memberId"=EXCLUDED."memberId",
    "userId"=EXCLUDED."userId", "fanId"=EXCLUDED."fanId", "dialogId"=EXCLUDED."dialogId",
    "amountCents"=EXCLUDED."amountCents", "currency"=EXCLUDED."currency", "occurredAt"=EXCLUDED."occurredAt",
    "businessStatus"=EXCLUDED."businessStatus", "financialStatus"=EXCLUDED."financialStatus",
    "attributionActive"=EXCLUDED."attributionActive", "canonicalMoneyId"=EXCLUDED."canonicalMoneyId",
    "creatorSaleId"=EXCLUDED."creatorSaleId", "financialTransactionId"=EXCLUDED."financialTransactionId",
    "creatorTipId"=EXCLUDED."creatorTipId", "attributionBasis"=EXCLUDED."attributionBasis",
    "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt", "rootId"=EXCLUDED."rootId", "rootVersion"='team_money_root_v2',
    "canonicalBusinessKey"=EXCLUDED."canonicalBusinessKey",
    "classificationState"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'INCOMPLETE'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationState"
    END,
    "classificationReason"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PEER_SET_RECLASSIFICATION_PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationReason"
    END,
    "classificationVersion"='team_money_root_classification_v1',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;

  PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'TIP', business_key);
  IF previous_business_key IS NOT NULL AND previous_business_key IS DISTINCT FROM business_key THEN
    PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'TIP', previous_business_key);
  END IF;

  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Actual53 ROOT D / F53-10: runtime demand no longer scans every visible
-- creator just to discard creators without a Telegram contact in Node.
CREATE INDEX IF NOT EXISTS "CreatorAccount_telegram_runtime_demand_idx"
  ON "CreatorAccount"("agencyId", "id")
  WHERE "deletedAt" IS NULL AND "telegramContact" IS NOT NULL AND btrim("telegramContact") <> '';
