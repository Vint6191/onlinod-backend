-- Team Claims audit v1.
-- Manual PPV conflict decisions get an immutable, queryable audit row that
-- separates the manager/actor from the member who receives attribution.
CREATE TABLE IF NOT EXISTS "TeamPpvClaimAudit" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "jobId" TEXT,
  "purchaseId" TEXT NOT NULL,
  "messageId" TEXT,
  "action" TEXT NOT NULL,
  "actorMemberId" TEXT NOT NULL,
  "selectedMemberId" TEXT,
  "reason" TEXT,
  "evidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamPpvClaimAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamPpvClaimAudit_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TeamPpvClaimAudit_agencyId_createdAt_idx"
  ON "TeamPpvClaimAudit"("agencyId", "createdAt");
CREATE INDEX IF NOT EXISTS "TeamPpvClaimAudit_agencyId_jobId_createdAt_idx"
  ON "TeamPpvClaimAudit"("agencyId", "jobId", "createdAt");
CREATE INDEX IF NOT EXISTS "TeamPpvClaimAudit_agencyId_purchaseId_createdAt_idx"
  ON "TeamPpvClaimAudit"("agencyId", "purchaseId", "createdAt");
CREATE INDEX IF NOT EXISTS "TeamPpvClaimAudit_agencyId_actorMemberId_createdAt_idx"
  ON "TeamPpvClaimAudit"("agencyId", "actorMemberId", "createdAt");
CREATE INDEX IF NOT EXISTS "TeamPpvClaimAudit_agencyId_selectedMemberId_createdAt_idx"
  ON "TeamPpvClaimAudit"("agencyId", "selectedMemberId", "createdAt");
