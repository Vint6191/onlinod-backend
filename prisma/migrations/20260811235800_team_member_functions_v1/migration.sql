-- Team member functions v1.
-- Performance function is intentionally independent from RBAC role/access.
CREATE TABLE IF NOT EXISTS "TeamMemberFunction" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "functionKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMemberFunction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamMemberFunction_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamMemberFunction_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "AgencyMember"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamMemberFunction_agencyId_memberId_functionKey_key"
  ON "TeamMemberFunction"("agencyId", "memberId", "functionKey");
CREATE INDEX IF NOT EXISTS "TeamMemberFunction_agencyId_functionKey_memberId_idx"
  ON "TeamMemberFunction"("agencyId", "functionKey", "memberId");
CREATE INDEX IF NOT EXISTS "TeamMemberFunction_memberId_idx"
  ON "TeamMemberFunction"("memberId");
