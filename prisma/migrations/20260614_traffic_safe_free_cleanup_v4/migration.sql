-- Safe cleanup for free/zero subscription ledger noise.
-- This migration intentionally does NOT touch TrafficSourceMember rows: those rows are the
-- fan -> source attribution map and are needed for the first future paid event.
--
-- Only remove zero/free ledger rows that auto-repair has already treated as organic/no-source
-- multiple times and that still have no matching TrafficSourceMember after 24h.
DELETE FROM "CreatorSubscriptionLedger" AS l
WHERE l."amountCents" <= 0
  AND l."sourceId" IS NULL
  AND l."createdAt" < (NOW() - INTERVAL '24 hours')
  AND (l."organicConfirmed" = true OR l."attributionAttempts" >= 5)
  AND NOT EXISTS (
    SELECT 1
    FROM "TrafficSourceMember" m
    WHERE m."agencyId" = l."agencyId"
      AND m."creatorId" = l."creatorId"
      AND m."fanId" = l."fanId"
  );

-- Keep campaign/free claimers as source map only, without automatic value hydrate, until a
-- real paid/tip/PPV event marks them dirty.
UPDATE "TrafficSourceMember" AS m
SET "needsValueRefresh" = false
WHERE m."lastRevenueAt" IS NULL
  AND m."needsValueRefresh" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "CreatorSubscriptionLedger" l
    WHERE l."agencyId" = m."agencyId"
      AND l."creatorId" = m."creatorId"
      AND l."fanId" = m."fanId"
      AND l."amountCents" > 0
  );
