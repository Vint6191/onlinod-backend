-- Team Administration V1
-- Reversible member deactivation and invitation function assignment.

ALTER TABLE "AgencyMember"
  ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AgencyMember_deactivatedAt_idx"
  ON "AgencyMember"("deactivatedAt");

ALTER TABLE "AgencyInvitation"
  ADD COLUMN IF NOT EXISTS "functions" JSONB;
