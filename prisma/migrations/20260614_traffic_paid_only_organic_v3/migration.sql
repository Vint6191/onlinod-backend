-- Traffic paid-only organic cleanup.
-- CreatorSubscriptionLedger is a paid-subscription ledger only. Free organic/free-sub events
-- are noise at agency scale, but we must not delete anything that may still prove to be
-- a tracked campaign/link member.
--
-- SAFE RULE:
--   - NEVER delete TrafficSourceMember here; it is the attribution map.
--   - Delete zero/free ledger rows only after auto-repair already confirmed they are
--     organic/no-source several times, they are older than 24h, and there is still no
--     matching TrafficSourceMember.
--   - Source-linked/free rows are excluded from paid metrics in service queries and can be
--     cleaned later by retention if needed.

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

-- Stop hydrating value for non-paying campaign/free claimers that were created by older builds.
-- Keep TrafficSourceMember rows as the attribution map, but do not fetch fan value until a
-- paid/tip/PPV event marks the member dirty.
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
