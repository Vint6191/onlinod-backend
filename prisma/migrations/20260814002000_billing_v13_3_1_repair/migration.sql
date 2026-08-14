-- V13.3.1 repair: make migrated V13/V13.2 order lines refund-aware.
-- Additive/data-repair only. Do not rewrite the already-deployable V13.3 migration.
-- This migration is safe both after an existing V13.3 deploy and on a fresh DB
-- where V13.3 and V13.3.1 are applied consecutively.

-- V13.3 relationalized historic order lines but did not copy BillingOrder.activatedAt.
-- Without this, refund processing skips an otherwise activated historic line.
UPDATE "BillingOrderLine" l
SET
  "activatedAt" = o."activatedAt",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "BillingOrder" o
WHERE l."orderId" = o."id"
  AND l."activatedAt" IS NULL
  AND o."activatedAt" IS NOT NULL;

-- Preserve the currently known grant end on the line that owns each live
-- entitlement component. Historic V13/V13.2 rows did not have per-line grant
-- dates before V13.3, so only the currently authoritative owner can be repaired
-- without inventing history.
UPDATE "BillingOrderLine" l
SET
  "coreGrantedUntil" = e."coreValidUntil",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "CreatorBillingEntitlement" e
WHERE e."coreLastOrderId" = l."orderId"
  AND e."creatorId" = l."creatorId"
  AND l."coreGrantedUntil" IS NULL;

UPDATE "BillingOrderLine" l
SET
  "aiGrantedUntil" = e."aiChatterValidUntil",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "CreatorBillingEntitlement" e
WHERE e."aiLastOrderId" = l."orderId"
  AND e."creatorId" = l."creatorId"
  AND l."aiGrantedUntil" IS NULL;

UPDATE "BillingOrderLine" l
SET
  "outreachGrantedUntil" = e."outreachValidUntil",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "CreatorBillingEntitlement" e
WHERE e."outreachLastOrderId" = l."orderId"
  AND e."creatorId" = l."creatorId"
  AND l."outreachGrantedUntil" IS NULL;

-- If an already-refunded historic order was present before this repair, never
-- leave it as the authoritative access owner. We intentionally fail closed
-- rather than guessing a predecessor whose exact pre-V13 grant dates were not
-- recorded relationally.
UPDATE "CreatorBillingEntitlement" e
SET
  "coreSource" = 'LEGACY'::"BillingEntitlementSource",
  "corePriceCents" = 0,
  "coreValidUntil" = NULL,
  "coreLastOrderId" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "BillingOrder" o
WHERE e."coreLastOrderId" = o."id"
  AND o."status" = 'REFUNDED';

UPDATE "CreatorBillingEntitlement" e
SET
  "aiChatterSource" = 'LEGACY'::"BillingEntitlementSource",
  "aiChatterPriceCents" = 0,
  "aiChatterValidUntil" = NULL,
  "aiLastOrderId" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "BillingOrder" o
WHERE e."aiLastOrderId" = o."id"
  AND o."status" = 'REFUNDED';

UPDATE "CreatorBillingEntitlement" e
SET
  "outreachSource" = 'LEGACY'::"BillingEntitlementSource",
  "outreachPriceCents" = 0,
  "outreachValidUntil" = NULL,
  "outreachLastOrderId" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "BillingOrder" o
WHERE e."outreachLastOrderId" = o."id"
  AND o."status" = 'REFUNDED';

UPDATE "BillingOrderLine" l
SET
  "refundedAt" = COALESCE(l."refundedAt", o."updatedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "BillingOrder" o
WHERE l."orderId" = o."id"
  AND o."status" = 'REFUNDED'
  AND l."activatedAt" IS NOT NULL
  AND l."refundedAt" IS NULL;
