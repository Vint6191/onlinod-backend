-- Audit16 product-surface access / permission / device cutover.
--
-- This migration has two jobs:
--   1) persist the actor fields required by the new long-lived Telegram and
--      Customs reminder lease fences; and
--   2) translate only decisions that the retired analytics evaluator actually
--      honored into the canonical Team permission keys.
--
-- Permission compatibility rule: any explicit TRUE among aliases wins. If no
-- alias is TRUE but at least one alias is explicitly FALSE, the canonical
-- decision is FALSE. If there was no explicit boolean decision at all, no
-- member override is created; the canonical role/access defaults remain the
-- authority. This matches creator-analytics-permissions.js exactly and avoids
-- manufacturing permissions from stale/non-boolean JSON.

ALTER TABLE "AgencyTelegramMtprotoAccount"
  ADD COLUMN IF NOT EXISTS "runtimeLeaseUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "runtimeLeaseMemberId" TEXT,
  ADD COLUMN IF NOT EXISTS "runtimeLeaseAccessEpoch" INTEGER,
  ADD COLUMN IF NOT EXISTS "runtimeLeaseCreatorId" TEXT;

ALTER TABLE "CustomOrder"
  ADD COLUMN IF NOT EXISTS "reminderClaimedByDeviceId" TEXT,
  ADD COLUMN IF NOT EXISTS "reminderLeaseUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "reminderLeaseMemberId" TEXT,
  ADD COLUMN IF NOT EXISTS "reminderLeaseAccessEpoch" INTEGER;

-- Custom roles never participated in the old senior-role analytics fallback:
-- roleKeyToLegacy(custom) is OPERATOR. Persisting the new zone as hidden keeps
-- that old behavior stable instead of letting a future default widen it.
UPDATE "AgencyCustomRole"
SET "access" = (
  CASE
    WHEN jsonb_typeof(COALESCE("access", '{}'::jsonb)) = 'object'
      THEN COALESCE("access", '{}'::jsonb)
    ELSE '{}'::jsonb
  END
) || jsonb_build_object('analytics', 'hidden')
WHERE NOT (
  CASE
    WHEN jsonb_typeof(COALESCE("access", '{}'::jsonb)) = 'object'
      THEN COALESCE("access", '{}'::jsonb)
    ELSE '{}'::jsonb
  END ? 'analytics'
);

WITH source AS (
  SELECT
    "id",
    CASE
      WHEN jsonb_typeof(COALESCE("permissions", '{}'::jsonb)) = 'object'
        THEN COALESCE("permissions", '{}'::jsonb)
      ELSE '{}'::jsonb
    END AS p
  FROM "AgencyMember"
), decisions AS (
  SELECT
    "id",
    p,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'money.view_earnings',
          'creator_analytics.view_money',
          'creatorAnalytics.viewMoney'
        ]) AS k
        WHERE p ? k AND p ->> k = 'true'
      ) THEN TRUE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'money.view_earnings',
          'creator_analytics.view_money',
          'creatorAnalytics.viewMoney'
        ]) AS k
        WHERE p ? k AND p ->> k = 'false'
      ) THEN FALSE
      ELSE NULL
    END AS money_view,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'creator_analytics.refresh',
          'creatorAnalytics.refresh',
          'stats.refresh'
        ]) AS k
        WHERE p ? k AND p ->> k = 'true'
      ) THEN TRUE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'creator_analytics.refresh',
          'creatorAnalytics.refresh',
          'stats.refresh'
        ]) AS k
        WHERE p ? k AND p ->> k = 'false'
      ) THEN FALSE
      ELSE NULL
    END AS analytics_refresh,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'traffic.view',
          'money.view_earnings',
          'creator_analytics.view_money',
          'creatorAnalytics.viewMoney',
          'traffic.manage_costs',
          'traffic.manageCosts',
          'creator_analytics.manage_traffic_costs'
        ]) AS k
        WHERE p ? k AND p ->> k = 'true'
      ) THEN TRUE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'traffic.view',
          'money.view_earnings',
          'creator_analytics.view_money',
          'creatorAnalytics.viewMoney',
          'traffic.manage_costs',
          'traffic.manageCosts',
          'creator_analytics.manage_traffic_costs'
        ]) AS k
        WHERE p ? k AND p ->> k = 'false'
      ) THEN FALSE
      ELSE NULL
    END AS traffic_view,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'traffic.refresh',
          'creator_analytics.refresh',
          'creatorAnalytics.refresh',
          'stats.refresh'
        ]) AS k
        WHERE p ? k AND p ->> k = 'true'
      ) THEN TRUE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'traffic.refresh',
          'creator_analytics.refresh',
          'creatorAnalytics.refresh',
          'stats.refresh'
        ]) AS k
        WHERE p ? k AND p ->> k = 'false'
      ) THEN FALSE
      ELSE NULL
    END AS traffic_refresh,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'traffic.manage_costs',
          'traffic.manageCosts',
          'creator_analytics.manage_traffic_costs'
        ]) AS k
        WHERE p ? k AND p ->> k = 'true'
      ) THEN TRUE
      WHEN EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'traffic.manage_costs',
          'traffic.manageCosts',
          'creator_analytics.manage_traffic_costs'
        ]) AS k
        WHERE p ? k AND p ->> k = 'false'
      ) THEN FALSE
      ELSE NULL
    END AS traffic_costs
  FROM source
), canonicalized AS (
  SELECT
    "id",
    -- Retire only the non-canonical member aliases after their effective
    -- decision has been captured. Canonical keys are then written below.
    p
      - 'creator_analytics.view_money'
      - 'creatorAnalytics.viewMoney'
      - 'creatorAnalytics.refresh'
      - 'stats.refresh'
      - 'traffic.manageCosts'
      - 'creator_analytics.manage_traffic_costs'
      AS cleaned,
    money_view,
    analytics_refresh,
    traffic_view,
    traffic_refresh,
    traffic_costs
  FROM decisions
)
UPDATE "AgencyMember" AS m
SET "permissions" =
    canonicalized.cleaned
    || CASE WHEN canonicalized.money_view IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('money.view_earnings', canonicalized.money_view) END
    || CASE WHEN canonicalized.analytics_refresh IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('creator_analytics.refresh', canonicalized.analytics_refresh) END
    || CASE WHEN canonicalized.traffic_view IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('traffic.view', canonicalized.traffic_view) END
    || CASE WHEN canonicalized.traffic_refresh IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('traffic.refresh', canonicalized.traffic_refresh) END
    || CASE WHEN canonicalized.traffic_costs IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('traffic.manage_costs', canonicalized.traffic_costs) END
FROM canonicalized
WHERE m."id" = canonicalized."id"
  AND (
    canonicalized.money_view IS NOT NULL
    OR canonicalized.analytics_refresh IS NOT NULL
    OR canonicalized.traffic_view IS NOT NULL
    OR canonicalized.traffic_refresh IS NOT NULL
    OR canonicalized.traffic_costs IS NOT NULL
  );

-- Legacy AgencySubPermissionOverride alias rows are intentionally retained as
-- historical configuration. They never participated in the retired per-member
-- analytics evaluator, so promoting them into canonical overrides here would
-- create permissions that were not effective before Audit16.
