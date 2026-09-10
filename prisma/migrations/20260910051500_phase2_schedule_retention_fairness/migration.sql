-- Phase 2 final source scale: bounded projection-retention selectors.
CREATE INDEX IF NOT EXISTS "TeamCoverageSession_agency_endedAt_idx"
  ON "TeamCoverageSession"("agencyId", "endedAt");
CREATE INDEX IF NOT EXISTS "TeamDialogSession_agency_endedAt_idx"
  ON "TeamDialogSession"("agencyId", "endedAt");
CREATE INDEX IF NOT EXISTS "TeamResponseCase_agency_creator_member_replyAt_idx"
  ON "TeamResponseCase"("agencyId", "creatorId", "memberId", "replyAt");
