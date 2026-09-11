-- Phase 2 / Actual55 Root B closure.
-- One physical order supports modern cross-family Team chronology. Ledger id remains
-- storage identity; telemetryEventId is the comparable TeamActivityEvent identity.
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_temporal_order_v3_idx"
ON "TeamSentMessageLedger"("agencyId","creatorId","dialogId","sentAt","telemetryEventId","id");

-- A bounded pending-repair prefix is semantic state, not generic revision state.
-- Preserve only that cursor across ordinary TEAM_DIALOG_PROJECTION live publications;
-- the consumer revalidates replyBoundary before every resumed page and rebases if it changed.
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
    "progressCursor" = CASE
      WHEN "DomainWorkItem"."state"='CLAIMED' THEN "DomainWorkItem"."progressCursor"
      WHEN "DomainWorkItem"."workClass"='TEAM_DIALOG_PROJECTION'
        AND ("DomainWorkItem"."progressCursor"->'pendingRepair') IS NOT NULL
        THEN "DomainWorkItem"."progressCursor"
      ELSE NULL
    END,
    "errorClass" = NULL,
    "lastError" = NULL,
    "terminalCause" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  RETURNING "requestedRevision" INTO v_revision;
  RETURN v_revision;
END;
$$ LANGUAGE plpgsql;
