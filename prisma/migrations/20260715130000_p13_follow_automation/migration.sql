-- P13: Follow Automation. Refollow is a server-coordinated two-step saga:
-- UNFOLLOW_FAN -> FOLLOW_FAN. The existing AutomationDelivery table remains
-- the only short write queue; this table is only the subscriber projection.

CREATE TABLE "FollowAutomationCandidate" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "dialogId" TEXT,
  "username" TEXT,
  "displayName" TEXT,
  "avatarUrl" TEXT,
  "subscriptionType" TEXT,
  "isActive" BOOLEAN,
  "subscribedByCreator" BOOLEAN,
  "subscribedOn" BOOLEAN,
  "subscribePriceCents" INTEGER NOT NULL DEFAULT 0,
  "ofBlocked" BOOLEAN NOT NULL DEFAULT false,
  "restricted" BOOLEAN NOT NULL DEFAULT false,
  "performer" BOOLEAN NOT NULL DEFAULT false,
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3),
  "eligibilityReason" TEXT,
  "ignored" BOOLEAN NOT NULL DEFAULT false,
  "blocked" BOOLEAN NOT NULL DEFAULT false,
  "state" TEXT NOT NULL DEFAULT 'CANDIDATE',
  "phase" TEXT NOT NULL DEFAULT 'IDLE',
  "generation" INTEGER NOT NULL DEFAULT 0,
  "nudgeCount" INTEGER NOT NULL DEFAULT 0,
  "cooldownUntil" TIMESTAMP(3),
  "waitReturnUntil" TIMESTAMP(3),
  "snapshotRunId" TEXT,
  "latestDeliveryId" TEXT,
  "latestActionType" TEXT,
  "latestStatus" TEXT,
  "latestError" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FollowAutomationCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FollowAutomationCandidate_creatorId_fanId_key" ON "FollowAutomationCandidate"("creatorId", "fanId");
CREATE INDEX "FollowAutomationCandidate_agencyId_creatorId_state_idx" ON "FollowAutomationCandidate"("agencyId", "creatorId", "state");
CREATE INDEX "FollowAutomationCandidate_creatorId_phase_idx" ON "FollowAutomationCandidate"("creatorId", "phase");
CREATE INDEX "FollowAutomationCandidate_creatorId_cooldownUntil_idx" ON "FollowAutomationCandidate"("creatorId", "cooldownUntil");
CREATE INDEX "FollowAutomationCandidate_creatorId_waitReturnUntil_idx" ON "FollowAutomationCandidate"("creatorId", "waitReturnUntil");
CREATE INDEX "FollowAutomationCandidate_snapshotRunId_idx" ON "FollowAutomationCandidate"("snapshotRunId");
ALTER TABLE "FollowAutomationCandidate" ADD CONSTRAINT "FollowAutomationCandidate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowAutomationCandidate" ADD CONSTRAINT "FollowAutomationCandidate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
