-- Phase 2 Team projection/read identity convergence.
-- Per-dialog projection metadata is additive; raw evidence remains canonical until retention consumers are proven.
ALTER TABLE "TeamPendingDialogState"
  ADD COLUMN IF NOT EXISTS "projectionRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "projectionState" TEXT NOT NULL DEFAULT 'FULL',
  ADD COLUMN IF NOT EXISTS "lastProjectionSourceId" TEXT;

ALTER TABLE "TeamResponseCase"
  ADD COLUMN IF NOT EXISTS "projectionRevision" BIGINT NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "TeamResponseCase_agencyId_replyMessageId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "TeamResponseCase_agencyId_creatorId_replyMessageId_key"
  ON "TeamResponseCase"("agencyId","creatorId","replyMessageId");
CREATE INDEX IF NOT EXISTS "TeamResponseCase_agency_replyMessage_lookup_idx"
  ON "TeamResponseCase"("agencyId","replyMessageId");

ALTER TABLE "TeamPendingDialogState" ALTER COLUMN "derivationVersion" SET DEFAULT 'team_pending_v2';
ALTER TABLE "TeamResponseCase" ALTER COLUMN "derivationVersion" SET DEFAULT 'team_response_v2';
