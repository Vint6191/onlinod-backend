-- Phase 2 fresh-source closure hardening.
-- A48: exact CALL top-N is ranked by business end/start time before LIMIT.
-- The expression index keeps overdue lookup anchored to the same clamped
-- duration contract used by callPhaseSnapshot (1..1440 minutes).
CREATE INDEX IF NOT EXISTS "CustomOrder_call_pending_end_rank_idx"
  ON "CustomOrder" (
    "agencyId",
    ("scheduledAt" + (GREATEST(1, LEAST(1440, COALESCE("durationMinutes", 1))) * INTERVAL '1 minute')),
    "id"
  )
  WHERE "type" = 'CALL'
    AND "status" = 'PENDING'
    AND "scheduledAt" IS NOT NULL;


-- A46 rolling-deploy fence.
-- Actual 52 maintenance workers do not understand activeGeneration: when they see a
-- different generation they can overwrite the lane row and start the old executor.
-- Retire the exact old executable lane keys at the database boundary. An owner that
-- already held a lane when this migration committed may heartbeat/finish with the
-- same token, but no old/new replica can acquire a new owner token afterwards.
CREATE TABLE IF NOT EXISTS "Phase2LegacyExecutorFence" (
  "laneKey" TEXT NOT NULL,
  "retiredGeneration" TEXT,
  "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Phase2LegacyExecutorFence_pkey" PRIMARY KEY ("laneKey")
);

INSERT INTO "Phase2LegacyExecutorFence"("laneKey","retiredGeneration","reason") VALUES
  ('provider_operational_debt_backfill_v1','provider_operational_debt_v1','DOMAIN_WORK_CUTOVER'),
  ('provider_operational_dirty_v1','provider_operational_debt_v1','DOMAIN_WORK_CUTOVER'),
  ('custom_external_proof_backfill_v1','custom_external_proof_backfill_v1','DOMAIN_WORK_CUTOVER'),
  ('custom_external_projection_debt_v1','custom_external_projection_debt_v1','DOMAIN_WORK_CUTOVER'),
  ('telegram_inbound_projection_v1','telegram_inbound_projection_v1','DOMAIN_WORK_CUTOVER'),
  ('telegram_custom_convergence_v1','telegram_custom_convergence_v1','DOMAIN_WORK_CUTOVER'),
  ('team_pending_projection_v1','team_pending_projection_v1','DOMAIN_WORK_CUTOVER'),
  ('team_money_backfill_v1','team_money_backfill_v1','DOMAIN_WORK_CUTOVER')
ON CONFLICT ("laneKey") DO UPDATE SET
  "retiredGeneration"=EXCLUDED."retiredGeneration",
  "reason"=EXCLUDED."reason",
  "updatedAt"=CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "phase2_fence_retired_maintenance_claim"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."ownerToken" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "Phase2LegacyExecutorFence" f WHERE f."laneKey"=NEW."key")
     AND (TG_OP='INSERT' OR OLD."ownerToken" IS DISTINCT FROM NEW."ownerToken") THEN
    RAISE EXCEPTION 'PHASE2_LEGACY_EXECUTOR_RETIRED:%', NEW."key" USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "MaintenanceLaneState_phase2_legacy_executor_fence" ON "MaintenanceLaneState";
CREATE TRIGGER "MaintenanceLaneState_phase2_legacy_executor_fence"
BEFORE INSERT OR UPDATE OF "ownerToken","generation","activeGeneration"
ON "MaintenanceLaneState" FOR EACH ROW
EXECUTE FUNCTION "phase2_fence_retired_maintenance_claim"();

-- A46 rolling HTTP/projector compatibility.
-- Actual52 Prisma generated an UPSERT against UNIQUE(agencyId,replyMessageId) and
-- writes Team pending/response projections inline inside the raw telemetry TX. The
-- current generation requires creator-scoped response identity and must not be
-- writable/deletable by that old binary. A trigger cannot repair the ON CONFLICT
-- contract after the old unique index has changed, so use an expand/contract table
-- split instead of a fragile field-level quarantine:
--   * metadata-rename the already-populated current tables (no history copy/scan),
--   * keep the current Prisma model mapped to the renamed physical table,
--   * recreate the old physical names as compatibility sinks with Actual52 schema.
-- Old replicas can therefore finish raw telemetry without touching current v2 roots.
-- Every relevant raw TeamActivityEvent independently publishes current DomainWork,
-- so compatibility rows are not execution authority and need no historical fanout.
DO $$
BEGIN
  IF to_regclass('"TeamResponseCaseCurrent"') IS NULL AND to_regclass('"TeamResponseCase"') IS NOT NULL THEN
    ALTER TABLE "TeamResponseCase" RENAME TO "TeamResponseCaseCurrent";
  END IF;
  IF to_regclass('"TeamPendingDialogStateCurrent"') IS NULL AND to_regclass('"TeamPendingDialogState"') IS NOT NULL THEN
    ALTER TABLE "TeamPendingDialogState" RENAME TO "TeamPendingDialogStateCurrent";
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS "TeamResponseCase" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "fanId" TEXT,
  "replyMessageId" TEXT NOT NULL,
  "firstIncomingMessageId" TEXT,
  "incomingCount" INTEGER NOT NULL DEFAULT 1,
  "incomingAt" TIMESTAMP(3) NOT NULL,
  "lastIncomingAt" TIMESTAMP(3) NOT NULL,
  "replyAt" TIMESTAMP(3) NOT NULL,
  "seenAt" TIMESTAMP(3),
  "coverageId" TEXT,
  "coverageStartedAt" TIMESTAMP(3),
  "handoffFromMemberId" TEXT,
  "classification" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "wallClockSeconds" INTEGER NOT NULL DEFAULT 0,
  "coverageResponseSeconds" INTEGER,
  "seenResponseSeconds" INTEGER,
  "slaEligible" BOOLEAN NOT NULL DEFAULT FALSE,
  "sla5Pass" BOOLEAN,
  "sla15Pass" BOOLEAN,
  "derivationVersion" TEXT NOT NULL DEFAULT 'team_response_v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamResponseCaseLegacy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamResponseCaseLegacy_agency_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamResponseCaseLegacy_creator_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamResponseCaseLegacy_member_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TeamResponseCase_agencyId_replyMessageId_key"
  ON "TeamResponseCase"("agencyId","replyMessageId");
CREATE INDEX IF NOT EXISTS "TeamResponseCaseLegacy_member_reply_idx"
  ON "TeamResponseCase"("agencyId","memberId","replyAt");
CREATE INDEX IF NOT EXISTS "TeamResponseCaseLegacy_creator_dialog_reply_idx"
  ON "TeamResponseCase"("agencyId","creatorId","dialogId","replyAt");

CREATE TABLE IF NOT EXISTS "TeamPendingDialogState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "fanId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'CLEAR',
  "episodeKey" TEXT,
  "firstIncomingEventId" TEXT,
  "lastIncomingEventId" TEXT,
  "firstIncomingMessageId" TEXT,
  "lastIncomingMessageId" TEXT,
  "firstIncomingAt" TIMESTAMP(3),
  "lastIncomingAt" TIMESTAMP(3),
  "incomingCount" INTEGER NOT NULL DEFAULT 0,
  "firstSeenAt" TIMESTAMP(3),
  "firstSeenMemberId" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "lastSeenMemberId" TEXT,
  "ownerMemberId" TEXT,
  "ownerAssignedAt" TIMESTAMP(3),
  "ownerReason" TEXT,
  "replyAt" TIMESTAMP(3),
  "replyMessageId" TEXT,
  "repliedByMemberId" TEXT,
  "derivationVersion" TEXT NOT NULL DEFAULT 'team_pending_v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamPendingDialogStateLegacy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamPendingDialogStateLegacy_agency_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamPendingDialogStateLegacy_creator_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TeamPendingDialogStateLegacy_identity_key"
  ON "TeamPendingDialogState"("agencyId","creatorId","dialogId");
CREATE INDEX IF NOT EXISTS "TeamPendingDialogStateLegacy_status_age_idx"
  ON "TeamPendingDialogState"("agencyId","status","firstIncomingAt");
CREATE INDEX IF NOT EXISTS "TeamPendingDialogStateLegacy_owner_status_idx"
  ON "TeamPendingDialogState"("agencyId","ownerMemberId","status");
