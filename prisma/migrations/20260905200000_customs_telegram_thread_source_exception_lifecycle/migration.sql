BEGIN;

-- Customs Telegram thread / provider source / exception lifecycle cutover.
-- This migration is intentionally additive and fail-closed. Historical ambiguity is
-- preserved as explicit legacy provenance; it is never upgraded into stronger provider
-- proof merely because the new runtime knows how to produce that proof going forward.

ALTER TABLE "AgencyTelegramMtprotoAccount"
  ADD COLUMN IF NOT EXISTS "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "retirementRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retirementDrainCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "runtimeClaimGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "runtimeDrainedGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "runtimeClaimInboundEligible" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "AgencyTelegramMtprotoAccount"
SET "lifecycleState" = 'ACTIVE'
WHERE "lifecycleState" IS NULL OR BTRIM("lifecycleState") = '';

-- A live/pre-existing runtime owner may have a durable local inbound outbox that the backend
-- cannot inspect. Backfill such rows as explicitly NOT drained so a rolling deployment can
-- never transfer or retire their local provider capability merely because the new generation
-- counters did not exist before this migration.
UPDATE "AgencyTelegramMtprotoAccount"
SET "runtimeClaimGeneration" = GREATEST("runtimeClaimGeneration", 1),
    "runtimeDrainedGeneration" = 0
WHERE "runtimeClaimedByDeviceId" IS NOT NULL
  AND "runtimeClaimGeneration" = 0;

-- Preserve replay capability for a rolling live owner only when that runtime generation is
-- demonstrably inbound-capable from current server facts: either the account is the creator's
-- current Telegram assignment or it owns a still-PENDING confirmed Custom TASK thread. Source-
-- read/follow-up-only runtimes must not be upgraded into provider-observation authority.
UPDATE "AgencyTelegramMtprotoAccount" AS a
SET "runtimeClaimInboundEligible" = TRUE
WHERE a."runtimeClaimedByDeviceId" IS NOT NULL
  AND (
    EXISTS (
      SELECT 1
      FROM "CreatorAccount" c
      WHERE c."id" = a."runtimeLeaseCreatorId"
        AND c."agencyId" = a."agencyId"
        AND c."deletedAt" IS NULL
        AND c."telegramAccountId" = a."id"
        AND c."telegramContact" IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM "TelegramDeliveryIntent" t
      JOIN "CustomOrder" o ON o."id" = t."customOrderId" AND o."agencyId" = t."agencyId"
      WHERE t."agencyId" = a."agencyId"
        AND t."accountId" = a."id"
        AND t."creatorId" = a."runtimeLeaseCreatorId"
        AND t."kind" = 'TASK'
        AND t."state" = 'CONFIRMED'
        AND t."remoteMessageId" IS NOT NULL
        AND t."remoteRecipientTelegramUserId" IS NOT NULL
        AND o."status" = 'PENDING'
    )
  );

ALTER TABLE "CustomContentSubmission"
  ADD COLUMN IF NOT EXISTS "sourceAuthority" TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
  ADD COLUMN IF NOT EXISTS "sourceThreadIntentId" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceResolutionEventId" TEXT;

-- Existing inbound-linked rows were already backed by the durable TelegramInboundEvent
-- ledger, but pre-cutover data did not persist whether it was DIRECT_REPLY vs ACTIVE_THREAD.
-- Keep that weaker fact explicit instead of inventing a stronger current-thread proof.
UPDATE "CustomContentSubmission"
SET "sourceAuthority" = CASE
  WHEN COALESCE(array_length("telegramInboundEventIds", 1), 0) > 0
    THEN 'LEGACY_PROVEN_TELEGRAM_INBOUND'
  WHEN "telegramSourceAccountId" IS NOT NULL
    OR "telegramSourceUserId" IS NOT NULL
    OR COALESCE(array_length("telegramMessageIds", 1), 0) > 0
    THEN 'LEGACY_MANUAL_IMPORT'
  ELSE 'LEGACY_UNCLASSIFIED'
END
WHERE "sourceAuthority" = 'LEGACY_UNCLASSIFIED';

ALTER TABLE "TelegramInboundEvent"
  ADD COLUMN IF NOT EXISTS "intakeAuthority" TEXT NOT NULL DEFAULT 'PROVIDER_OBSERVATION',
  ADD COLUMN IF NOT EXISTS "threadResolutionType" TEXT,
  ADD COLUMN IF NOT EXISTS "threadAnchorIntentId" TEXT,
  ADD COLUMN IF NOT EXISTS "resolutionAuthority" TEXT;

ALTER TABLE "TelegramDeliveryIntent"
  ADD COLUMN IF NOT EXISTS "confirmationAuthority" TEXT;

-- Historical automatic receipts remain historical provider receipts. Human reconciliation
-- must never masquerade as generic provider/current-thread proof after this cutover.
UPDATE "TelegramDeliveryIntent"
SET "confirmationAuthority" = CASE
  WHEN "outcomeReason" LIKE 'MANUAL_CONFIRMED:%' THEN 'MANUAL_RECONCILIATION'
  ELSE 'PROVIDER_RECEIPT'
END
WHERE "state" = 'CONFIRMED'
  AND "remoteMessageId" IS NOT NULL
  AND "confirmationAuthority" IS NULL;

-- Direct Reply uses (agency, Telegram account, provider message id) as a canonical outgoing
-- receipt identity. Old source allowed findFirst ambiguity, so refuse to deploy if history
-- already contains duplicates: an operator must adjudicate them before this invariant can be
-- made unique. Because this check is inside BEGIN/COMMIT, the whole schema change rolls back.
DO $$
DECLARE
  conflict_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO conflict_count
  FROM (
    SELECT "agencyId", "accountId", "remoteMessageId"
    FROM "TelegramDeliveryIntent"
    WHERE "remoteMessageId" IS NOT NULL
    GROUP BY "agencyId", "accountId", "remoteMessageId"
    HAVING COUNT(*) > 1
  ) AS conflicts;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Custom Telegram thread cutover blocked: % duplicate (agencyId, accountId, remoteMessageId) outgoing receipt identity group(s) require explicit reconciliation before migration', conflict_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TelegramDeliveryIntent_provider_message_key"
ON "TelegramDeliveryIntent"("agencyId", "accountId", "remoteMessageId");

COMMIT;
