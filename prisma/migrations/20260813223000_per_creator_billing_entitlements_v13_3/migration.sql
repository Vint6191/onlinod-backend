-- V13.3: immutable per-creator order lines + per-creator paid entitlements.
-- Additive only. Existing V13/V13.2 BillingOrder rows remain valid.

ALTER TABLE "BillingOrder" ADD COLUMN "requestHash" TEXT;

CREATE TYPE "BillingEntitlementSource" AS ENUM ('PAYMENT', 'ADMIN', 'LEGACY');

CREATE TABLE "BillingOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "creatorName" TEXT NOT NULL,
    "creatorUsername" TEXT,
    "tier" "CreatorBillingTier" NOT NULL,
    "corePriceCents" INTEGER NOT NULL,
    "aiChatterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiChatterPriceCents" INTEGER NOT NULL DEFAULT 0,
    "outreachEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outreachPriceCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyCents" INTEGER NOT NULL,
    "periodMonths" INTEGER NOT NULL,
    "lineTotalCents" INTEGER NOT NULL,
    "previousTier" "CreatorBillingTier",
    "corePreviousSource" "BillingEntitlementSource",
    "corePreviousPriceCents" INTEGER,
    "corePreviousValidUntil" TIMESTAMP(3),
    "coreGrantedUntil" TIMESTAMP(3),
    "aiPreviousSource" "BillingEntitlementSource",
    "aiPreviousPriceCents" INTEGER,
    "aiPreviousValidUntil" TIMESTAMP(3),
    "aiGrantedUntil" TIMESTAMP(3),
    "outreachPreviousSource" "BillingEntitlementSource",
    "outreachPreviousPriceCents" INTEGER,
    "outreachPreviousValidUntil" TIMESTAMP(3),
    "outreachGrantedUntil" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorBillingEntitlement" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "tier" "CreatorBillingTier" NOT NULL DEFAULT 'STARTER',
    "coreSource" "BillingEntitlementSource" NOT NULL DEFAULT 'LEGACY',
    "corePriceCents" INTEGER NOT NULL DEFAULT 0,
    "coreValidFrom" TIMESTAMP(3),
    "coreValidUntil" TIMESTAMP(3),
    "aiChatterSource" "BillingEntitlementSource" NOT NULL DEFAULT 'LEGACY',
    "aiChatterPriceCents" INTEGER NOT NULL DEFAULT 0,
    "aiChatterValidUntil" TIMESTAMP(3),
    "outreachSource" "BillingEntitlementSource" NOT NULL DEFAULT 'LEGACY',
    "outreachPriceCents" INTEGER NOT NULL DEFAULT 0,
    "outreachValidUntil" TIMESTAMP(3),
    "coreLastOrderId" TEXT,
    "aiLastOrderId" TEXT,
    "outreachLastOrderId" TEXT,
    "lastPaidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorBillingEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingOrderLine_orderId_creatorId_key" ON "BillingOrderLine"("orderId", "creatorId");
CREATE INDEX "BillingOrderLine_agencyId_creatorId_createdAt_idx" ON "BillingOrderLine"("agencyId", "creatorId", "createdAt");
CREATE INDEX "BillingOrderLine_creatorId_createdAt_idx" ON "BillingOrderLine"("creatorId", "createdAt");
CREATE UNIQUE INDEX "CreatorBillingEntitlement_creatorId_key" ON "CreatorBillingEntitlement"("creatorId");
CREATE INDEX "CreatorBillingEntitlement_agencyId_coreValidUntil_idx" ON "CreatorBillingEntitlement"("agencyId", "coreValidUntil");
CREATE INDEX "CreatorBillingEntitlement_coreValidUntil_idx" ON "CreatorBillingEntitlement"("coreValidUntil");
CREATE INDEX "CreatorBillingEntitlement_aiChatterValidUntil_idx" ON "CreatorBillingEntitlement"("aiChatterValidUntil");
CREATE INDEX "CreatorBillingEntitlement_outreachValidUntil_idx" ON "CreatorBillingEntitlement"("outreachValidUntil");
CREATE INDEX "BillingOrder_requestHash_idx" ON "BillingOrder"("requestHash");

ALTER TABLE "BillingOrderLine" ADD CONSTRAINT "BillingOrderLine_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "BillingOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingOrderLine" ADD CONSTRAINT "BillingOrderLine_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorBillingEntitlement" ADD CONSTRAINT "CreatorBillingEntitlement_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorBillingEntitlement" ADD CONSTRAINT "CreatorBillingEntitlement_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Materialize the exact creator lines from existing V13/V13.2 immutable pricing
-- snapshots so current payment history becomes relational too. Do not require the
-- creator to still exist: BillingOrderLine is financial history and intentionally
-- keeps its creator identity snapshot after a hard creator deletion.
INSERT INTO "BillingOrderLine" (
  "id", "orderId", "agencyId", "creatorId", "creatorName", "creatorUsername", "tier",
  "corePriceCents", "aiChatterEnabled", "aiChatterPriceCents", "outreachEnabled",
  "outreachPriceCents", "monthlyCents", "periodMonths", "lineTotalCents", "createdAt", "updatedAt"
)
SELECT
  'v13line_' || md5(o."id" || ':' || (line->>'creatorId')),
  o."id",
  o."agencyId",
  line->>'creatorId',
  COALESCE(NULLIF(line->>'creatorName', ''), NULLIF(line->>'creatorUsername', ''), line->>'creatorId'),
  NULLIF(line->>'creatorUsername', ''),
  CASE
    WHEN UPPER(COALESCE(line->>'tier', '')) IN ('STARTER','GROWTH','PRO','ELITE','CUSTOM')
      THEN UPPER(line->>'tier')::"CreatorBillingTier"
    ELSE 'STARTER'::"CreatorBillingTier"
  END,
  GREATEST(0, COALESCE((line->>'corePriceCents')::integer, 0)),
  (line @> '{"aiChatterEnabled":true}'::jsonb),
  CASE WHEN line @> '{"aiChatterEnabled":true}'::jsonb
    THEN GREATEST(0, COALESCE((line->>'aiChatterPriceCents')::integer, 0)) ELSE 0 END,
  (line @> '{"outreachEnabled":true}'::jsonb),
  CASE WHEN line @> '{"outreachEnabled":true}'::jsonb
    THEN GREATEST(0, COALESCE((line->>'outreachPriceCents')::integer, 0)) ELSE 0 END,
  GREATEST(0, COALESCE(
    (line->>'monthlyCents')::integer,
    (line->>'lineTotalCents')::integer,
    COALESCE((line->>'corePriceCents')::integer, 0)
      + CASE WHEN line @> '{"aiChatterEnabled":true}'::jsonb THEN COALESCE((line->>'aiChatterPriceCents')::integer, 0) ELSE 0 END
      + CASE WHEN line @> '{"outreachEnabled":true}'::jsonb THEN COALESCE((line->>'outreachPriceCents')::integer, 0) ELSE 0 END
  )),
  GREATEST(1, COALESCE(o."periodMonths", 1)),
  GREATEST(0, COALESCE(
    (line->>'monthlyCents')::integer,
    (line->>'lineTotalCents')::integer,
    COALESCE((line->>'corePriceCents')::integer, 0)
      + CASE WHEN line @> '{"aiChatterEnabled":true}'::jsonb THEN COALESCE((line->>'aiChatterPriceCents')::integer, 0) ELSE 0 END
      + CASE WHEN line @> '{"outreachEnabled":true}'::jsonb THEN COALESCE((line->>'outreachPriceCents')::integer, 0) ELSE 0 END
  )) * GREATEST(1, COALESCE(o."periodMonths", 1)),
  COALESCE(o."createdAt", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM "BillingOrder" o
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o."pricingSnapshot"->'lines', '[]'::jsonb)) AS line
WHERE NULLIF(line->>'creatorId', '') IS NOT NULL
ON CONFLICT ("orderId", "creatorId") DO NOTHING;

-- Preserve current paid access without reviving already-expired test data.
-- Priority 1: activated V13/V13.2 PAID orders are the strongest evidence because
-- their immutable pricingSnapshot contains the exact creators that were charged.
WITH latest_subscription AS (
  SELECT DISTINCT ON (s."agencyId")
    s."id", s."agencyId", s."status", s."billingMode", s."currentPeriodStart", s."currentPeriodEnd"
  FROM "AgencySubscription" s
  ORDER BY s."agencyId", s."createdAt" DESC
), paid_order_lines AS (
  SELECT DISTINCT ON (o."agencyId", line->>'creatorId')
    o."id" AS "orderId",
    o."agencyId",
    line->>'creatorId' AS "creatorId",
    CASE
      WHEN UPPER(COALESCE(line->>'tier', '')) IN ('STARTER','GROWTH','PRO','ELITE','CUSTOM')
        THEN UPPER(line->>'tier')::"CreatorBillingTier"
      ELSE 'STARTER'::"CreatorBillingTier"
    END AS "tier",
    GREATEST(0, COALESCE((line->>'corePriceCents')::integer, 0)) AS "corePriceCents",
    (line @> '{"aiChatterEnabled":true}'::jsonb) AS "aiEnabled",
    GREATEST(0, COALESCE((line->>'aiChatterPriceCents')::integer, 0)) AS "aiPriceCents",
    (line @> '{"outreachEnabled":true}'::jsonb) AS "outreachEnabled",
    GREATEST(0, COALESCE((line->>'outreachPriceCents')::integer, 0)) AS "outreachPriceCents",
    COALESCE(o."paidAt", o."activatedAt", o."createdAt") AS "paidAt"
  FROM "BillingOrder" o
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o."pricingSnapshot"->'lines', '[]'::jsonb)) AS line
  WHERE o."status" = 'PAID'
    AND o."activatedAt" IS NOT NULL
    AND NULLIF(line->>'creatorId', '') IS NOT NULL
  ORDER BY o."agencyId", line->>'creatorId', o."activatedAt" DESC, o."createdAt" DESC
)
INSERT INTO "CreatorBillingEntitlement" (
  "id", "agencyId", "creatorId", "tier", "coreSource", "corePriceCents", "coreValidFrom", "coreValidUntil",
  "aiChatterSource", "aiChatterPriceCents", "aiChatterValidUntil", "outreachSource", "outreachPriceCents", "outreachValidUntil", "coreLastOrderId", "aiLastOrderId",
  "outreachLastOrderId", "lastPaidAt", "createdAt", "updatedAt"
)
SELECT
  'v13_' || md5(pol."creatorId" || ':' || pol."orderId"),
  pol."agencyId",
  pol."creatorId",
  pol."tier",
  'PAYMENT'::"BillingEntitlementSource",
  pol."corePriceCents",
  COALESCE(ls."currentPeriodStart", pol."paidAt", CURRENT_TIMESTAMP),
  ls."currentPeriodEnd",
  'PAYMENT'::"BillingEntitlementSource",
  CASE WHEN pol."aiEnabled" THEN pol."aiPriceCents" ELSE 0 END,
  CASE WHEN pol."aiEnabled" THEN ls."currentPeriodEnd" ELSE NULL END,
  'PAYMENT'::"BillingEntitlementSource",
  CASE WHEN pol."outreachEnabled" THEN pol."outreachPriceCents" ELSE 0 END,
  CASE WHEN pol."outreachEnabled" THEN ls."currentPeriodEnd" ELSE NULL END,
  pol."orderId",
  CASE WHEN pol."aiEnabled" THEN pol."orderId" ELSE NULL END,
  CASE WHEN pol."outreachEnabled" THEN pol."orderId" ELSE NULL END,
  pol."paidAt",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM paid_order_lines pol
JOIN latest_subscription ls ON ls."agencyId" = pol."agencyId"
JOIN "CreatorAccount" c ON c."id" = pol."creatorId" AND c."agencyId" = pol."agencyId" AND c."deletedAt" IS NULL
WHERE ls."status" IN ('ACTIVE', 'GRACE')
  AND ls."currentPeriodEnd" IS NOT NULL
  AND ls."currentPeriodEnd" > CURRENT_TIMESTAMP
ON CONFLICT ("creatorId") DO NOTHING;

-- Priority 2: pre-provider/manual legacy periods have no immutable order lines.
-- Fail closed: only explicit non-excluded CreatorBillingProfile rows are evidence
-- that a particular creator was part of that manual subscription. FREE_INTERNAL
-- remains free product-test mode and does not need a paid entitlement backfill.
WITH latest_subscription AS (
  SELECT DISTINCT ON (s."agencyId")
    s."id", s."agencyId", s."status", s."billingMode", s."currentPeriodStart", s."currentPeriodEnd"
  FROM "AgencySubscription" s
  ORDER BY s."agencyId", s."createdAt" DESC
)
INSERT INTO "CreatorBillingEntitlement" (
  "id", "agencyId", "creatorId", "tier", "coreSource", "corePriceCents", "coreValidFrom", "coreValidUntil",
  "aiChatterSource", "aiChatterPriceCents", "aiChatterValidUntil", "outreachSource", "outreachPriceCents", "outreachValidUntil", "lastPaidAt", "createdAt", "updatedAt"
)
SELECT
  'legacy_' || md5(bp."creatorId" || ':' || ls."id"),
  bp."agencyId",
  bp."creatorId",
  bp."tier",
  'LEGACY'::"BillingEntitlementSource",
  bp."corePriceCents",
  COALESCE(ls."currentPeriodStart", CURRENT_TIMESTAMP),
  ls."currentPeriodEnd",
  'LEGACY'::"BillingEntitlementSource",
  CASE WHEN bp."aiChatterEnabled" THEN bp."aiChatterPriceCents" ELSE 0 END,
  CASE WHEN bp."aiChatterEnabled" THEN ls."currentPeriodEnd" ELSE NULL END,
  'LEGACY'::"BillingEntitlementSource",
  CASE WHEN bp."outreachEnabled" THEN bp."outreachPriceCents" ELSE 0 END,
  CASE WHEN bp."outreachEnabled" THEN ls."currentPeriodEnd" ELSE NULL END,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM latest_subscription ls
JOIN "CreatorBillingProfile" bp ON bp."agencyId" = ls."agencyId" AND bp."billingExcluded" = false
JOIN "CreatorAccount" c ON c."id" = bp."creatorId" AND c."agencyId" = ls."agencyId" AND c."deletedAt" IS NULL
WHERE ls."status" IN ('ACTIVE', 'GRACE')
  AND ls."billingMode" <> 'FREE_INTERNAL'
  AND ls."currentPeriodEnd" IS NOT NULL
  AND ls."currentPeriodEnd" > CURRENT_TIMESTAMP
  AND NOT EXISTS (
    SELECT 1 FROM "BillingOrder" o
    WHERE o."agencyId" = ls."agencyId" AND o."status" = 'PAID' AND o."activatedAt" IS NOT NULL
  )
ON CONFLICT ("creatorId") DO NOTHING;
