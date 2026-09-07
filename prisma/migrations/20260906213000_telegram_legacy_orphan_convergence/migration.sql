BEGIN;

-- Legacy provider-ledger orphan convergence.
--
-- Older hard-delete implementations cascaded CustomOrder/CreatorAccount rows but
-- Telegram provider ledgers intentionally had no FK.  Preserve provider proof,
-- but terminalize only states that are provably precommit/no-effect so one old
-- orphan can never poison oldest-first work discovery.
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
  "outcomeReason" = 'LEGACY_ORPHAN_CUSTOM_ORDER_PRECOMMIT',
  "updatedAt" = NOW()
WHERE i."state" IN ('PLANNED', 'CLAIMED', 'FAILED_PRECOMMIT')
  AND i."commitStartedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "CustomOrder" AS o
    WHERE o."id" = i."customOrderId"
      AND o."agencyId" = i."agencyId"
  );

-- Unknown/confirmed outcomes are evidence and are deliberately preserved.  An
-- unresolved inbound observation with a historical business pointer that no
-- longer exists is not retryable runtime work; route it to the existing audited
-- manager review lane instead of letting it hot-loop forever or silently attach
-- to a different current thread.
UPDATE "TelegramInboundEvent" AS e
SET
  "projectionState" = 'REVIEW_REQUIRED',
  "projectionReason" = 'LEGACY_ORPHAN_BUSINESS_CONTEXT',
  "projectedAt" = COALESCE(e."projectedAt", NOW()),
  "updatedAt" = NOW()
WHERE e."submissionId" IS NULL
  AND e."projectionState" IN ('PENDING', 'FAILED_RETRYABLE')
  AND (
    (
      e."creatorId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "CreatorAccount" AS c
        WHERE c."id" = e."creatorId"
          AND c."agencyId" = e."agencyId"
      )
    )
    OR
    (
      e."customOrderId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "CustomOrder" AS o
        WHERE o."id" = e."customOrderId"
          AND o."agencyId" = e."agencyId"
      )
    )
  );

COMMIT;
