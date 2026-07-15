-- P11: Bumps Core. AutomationDelivery remains the only short write queue.
-- AutomationTask(type=bump_online) remains the template store for compatibility
-- with the approved Alpha UI; fan lifecycle state is expanded in place.

ALTER TABLE "AutomationBumpFanState"
  ADD COLUMN IF NOT EXISTS "lastAnySentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastAnyRepliedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastBumpSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastTemplateSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastReplyMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingDeliveryId" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingCancelAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cooldownUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "templateCooldownUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastOnlineAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sendGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ignored" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "blocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';

UPDATE "AutomationBumpFanState"
SET
  "lastAnySentAt" = COALESCE("lastAnySentAt", "lastSentAt"),
  "lastBumpSentAt" = COALESCE("lastBumpSentAt", "lastSentAt"),
  "lastTemplateSentAt" = COALESCE("lastTemplateSentAt", "lastSentAt"),
  "pendingMessageId" = COALESCE("pendingMessageId", CASE WHEN "lastStatus" IN ('sent', 'pending_reply', 'checking_reply') THEN "lastMessageId" ELSE NULL END),
  "sendGeneration" = GREATEST(
    "sendGeneration",
    COALESCE((
      SELECT MAX(d."generation")
      FROM "AutomationDelivery" d
      WHERE d."creatorId" = "AutomationBumpFanState"."creatorId"
        AND d."fanId" = "AutomationBumpFanState"."fanId"
        AND d."moduleKey" = 'bumps'
        AND d."actionType" = 'SEND_MESSAGE'
    ), 0)
  );

CREATE INDEX IF NOT EXISTS "AutomationBumpFanState_creatorId_pendingCancelAt_idx"
  ON "AutomationBumpFanState"("creatorId", "pendingCancelAt");
CREATE INDEX IF NOT EXISTS "AutomationBumpFanState_creatorId_cooldownUntil_idx"
  ON "AutomationBumpFanState"("creatorId", "cooldownUntil");
CREATE INDEX IF NOT EXISTS "AutomationBumpFanState_creatorId_lastOnlineAt_idx"
  ON "AutomationBumpFanState"("creatorId", "lastOnlineAt");

-- Old Alpha bump rows used lower-case lifecycle statuses and a separate claim
-- path. Preserve history but stop them from being executable by the P11 worker.
UPDATE "AutomationDelivery"
SET
  "status" = 'SKIPPED',
  "failureCode" = 'p11_legacy_bump_delivery_disabled',
  "lastError" = 'Legacy Alpha bump delivery retired by P11',
  "finishedAt" = COALESCE("finishedAt", CURRENT_TIMESTAMP),
  "claimedByDeviceId" = NULL,
  "claimedAt" = NULL,
  "claimUntil" = NULL,
  "leaseTokenHash" = NULL,
  "leaseRevision" = "leaseRevision" + 1
WHERE "moduleKey" = 'bumps'
  AND "status" IN ('scheduled', 'online_queued', 'online_claimed', 'send_reserved', 'sending', 'sent', 'pending_reply', 'checking_reply', 'cancel_claimed');
