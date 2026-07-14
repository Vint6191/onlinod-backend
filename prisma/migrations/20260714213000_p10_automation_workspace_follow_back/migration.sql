-- P10: generic write action delivery control plane + Follow Back projection.
-- JobInstance remains the orchestration queue. AutomationDelivery is upgraded
-- in place and becomes the only queue for short write actions.

ALTER TABLE "AutomationDelivery"
  ADD COLUMN IF NOT EXISTS "moduleKey" TEXT NOT NULL DEFAULT 'bumps',
  ADD COLUMN IF NOT EXISTS "actionType" TEXT NOT NULL DEFAULT 'SEND_MESSAGE',
  ADD COLUMN IF NOT EXISTS "targetId" TEXT,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "payload" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "leaseTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failureCode" TEXT,
  ADD COLUMN IF NOT EXISTS "lastError" TEXT,
  ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP(3);

UPDATE "AutomationDelivery"
SET
  "targetId" = COALESCE("targetId", "fanId"),
  "notBefore" = COALESCE("notBefore", "scheduledAt", "createdAt"),
  "lastError" = COALESCE("lastError", "error")
WHERE "targetId" IS NULL OR "lastError" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "AutomationDelivery_idempotencyKey_key"
  ON "AutomationDelivery"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_agencyId_moduleKey_actionType_status_idx"
  ON "AutomationDelivery"("agencyId", "moduleKey", "actionType", "status");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_creatorId_targetId_idx"
  ON "AutomationDelivery"("creatorId", "targetId");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_creatorId_status_notBefore_idx"
  ON "AutomationDelivery"("creatorId", "status", "notBefore");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_claimedByDeviceId_status_idx"
  ON "AutomationDelivery"("claimedByDeviceId", "status");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_finishedAt_idx"
  ON "AutomationDelivery"("finishedAt");

-- One target cannot have two active instances of the same action.
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationDelivery_active_target_unique"
  ON "AutomationDelivery"("creatorId", "moduleKey", "actionType", "targetId")
  WHERE "targetId" IS NOT NULL
    AND "status" IN ('QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_SCHEDULED');

-- Serialize all write actions for one creator across all devices.
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationDelivery_creator_write_lease_unique"
  ON "AutomationDelivery"("creatorId")
  WHERE "status" IN ('CLAIMED', 'RUNNING');

CREATE TABLE "AutomationControlState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "creatorId" TEXT,
  "moduleKey" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationControlState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AutomationControlState_agencyId_scopeKey_key" ON "AutomationControlState"("agencyId", "scopeKey");
CREATE INDEX "AutomationControlState_agencyId_creatorId_idx" ON "AutomationControlState"("agencyId", "creatorId");
CREATE INDEX "AutomationControlState_agencyId_moduleKey_idx" ON "AutomationControlState"("agencyId", "moduleKey");
ALTER TABLE "AutomationControlState" ADD CONSTRAINT "AutomationControlState_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationControlState" ADD CONSTRAINT "AutomationControlState_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FollowBackCandidate" (
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
  "canReceiveChatMessage" BOOLEAN,
  "subscribedByCreator" BOOLEAN,
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3),
  "eligibilityReason" TEXT,
  "ignored" BOOLEAN NOT NULL DEFAULT false,
  "blocked" BOOLEAN NOT NULL DEFAULT false,
  "state" TEXT NOT NULL DEFAULT 'CANDIDATE',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "cooldownUntil" TIMESTAMP(3),
  "snapshotRunId" TEXT,
  "latestDeliveryId" TEXT,
  "latestActionType" TEXT,
  "latestStatus" TEXT,
  "latestError" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FollowBackCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FollowBackCandidate_creatorId_fanId_key" ON "FollowBackCandidate"("creatorId", "fanId");
CREATE INDEX "FollowBackCandidate_agencyId_creatorId_state_idx" ON "FollowBackCandidate"("agencyId", "creatorId", "state");
CREATE INDEX "FollowBackCandidate_creatorId_eligibilityReason_idx" ON "FollowBackCandidate"("creatorId", "eligibilityReason");
CREATE INDEX "FollowBackCandidate_creatorId_cooldownUntil_idx" ON "FollowBackCandidate"("creatorId", "cooldownUntil");
CREATE INDEX "FollowBackCandidate_snapshotRunId_idx" ON "FollowBackCandidate"("snapshotRunId");
ALTER TABLE "FollowBackCandidate" ADD CONSTRAINT "FollowBackCandidate_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowBackCandidate" ADD CONSTRAINT "FollowBackCandidate_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Physically retire pending/running Alpha Follow Back work. The legacy routes
-- are no longer registered; keeping rows only preserves historical diagnostics.
UPDATE "FollowBackTask"
SET
  "status" = 'skipped',
  "reason" = 'p10_legacy_follow_back_disabled',
  "error" = NULL,
  "lastResultAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('pending', 'running');
