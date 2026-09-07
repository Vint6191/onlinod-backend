-- Historical creator-retirement adjudication for Custom/Telegram control-plane debt.
--
-- Prospective retirement is now blocked before these states can be created. This
-- migration only closes states produced by versions that allowed CreatorAccount
-- soft-delete first. It never invents a provider send or settles an unknown write.

ALTER TABLE "CustomOrder"
  ADD COLUMN "telegramCancellationWaivedAt" TIMESTAMP(3),
  ADD COLUMN "telegramCancellationWaiverReason" TEXT;

-- Proven precommit Telegram delivery has no external outcome and cannot execute
-- after its creator has already been retired. Terminalize only those states.
-- COMMITTING / RECONCILE_REQUIRED / CONFIRMED remain immutable evidence and must
-- be reconciled or preserved by the normal authority.
UPDATE "TelegramDeliveryIntent" AS i
SET
  "state" = 'CANCELLED',
  "deviceId" = NULL,
  "userId" = NULL,
  "memberId" = NULL,
  "accessEpoch" = NULL,
  "claimTokenHash" = NULL,
  "claimUntil" = NULL,
  "claimRevision" = i."claimRevision" + 1,
  "outcomeReason" = 'LEGACY_CREATOR_RETIRED_PRECOMMIT',
  "updatedAt" = NOW()
FROM "CreatorAccount" AS c
WHERE c."id" = i."creatorId"
  AND c."agencyId" = i."agencyId"
  AND c."deletedAt" IS NOT NULL
  AND i."state" IN ('PLANNED', 'CLAIMED', 'FAILED_PRECOMMIT')
  AND i."commitStartedAt" IS NULL;

-- A Custom that was already CANCELLED before this cutover can contain a proven
-- TASK but no cancellation follow-up because creator capability was destroyed by
-- legacy retirement. First project that provider fact monotonically; only then
-- record the historical non-delivery. A conflicting existing task projection or
-- unknown/committing cancellation outcome remains fail-closed for reconciliation.
UPDATE "CustomOrder" AS o
SET
  "telegramTaskMessageId" = COALESCE(o."telegramTaskMessageId", task."remoteMessageId"),
  "deliveredAt" = COALESCE(o."deliveredAt", task."remoteSentAt", task."confirmedAt"),
  "telegramCancellationWaivedAt" = NOW(),
  "telegramCancellationWaiverReason" = 'LEGACY_CREATOR_RETIRED_BEFORE_PIPELINE_AUTHORITY',
  "updatedAt" = NOW()
FROM "CreatorAccount" AS c, "TelegramDeliveryIntent" AS task
WHERE c."id" = o."creatorId"
  AND c."agencyId" = o."agencyId"
  AND c."deletedAt" IS NOT NULL
  AND o."status" = 'CANCELLED'
  AND task."agencyId" = o."agencyId"
  AND task."creatorId" = o."creatorId"
  AND task."customOrderId" = o."id"
  AND task."kind" = 'TASK'
  AND task."state" = 'CONFIRMED'
  AND task."remoteMessageId" IS NOT NULL
  AND (o."telegramTaskMessageId" IS NULL OR o."telegramTaskMessageId" = task."remoteMessageId")
  AND NOT EXISTS (
    SELECT 1 FROM "TelegramDeliveryIntent" AS cancellation
    WHERE cancellation."agencyId" = o."agencyId"
      AND cancellation."creatorId" = o."creatorId"
      AND cancellation."customOrderId" = o."id"
      AND cancellation."kind" = 'CANCELLATION'
      AND cancellation."state" IN ('COMMITTING', 'RECONCILE_REQUIRED', 'CONFIRMED')
  );
