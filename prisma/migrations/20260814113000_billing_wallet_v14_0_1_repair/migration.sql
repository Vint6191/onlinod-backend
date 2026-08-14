-- V14.0.1 billing repair.
-- Fail closed: automatic wallet renewal must never be inferred for ADMIN/LEGACY
-- grants or for V13 PAYMENT periods. A legacy payment bought a dated period; it
-- did not consent to future wallet debits. V14 wallet auto-renew starts only after
-- an explicit Start/Resume action and then uses coreSource=WALLET after renewal.
-- This migration is intentionally additive/repair-only and does not rewrite the
-- already-issued V14 migration, avoiding Prisma checksum conflicts.

-- Preserve the intended monthly billing anniversary across short months.
-- Example: Jan 31 -> Feb 28 -> Mar 31 instead of drifting permanently to the 28th.
ALTER TABLE "CreatorBillingEntitlement"
  ADD COLUMN "billingAnchorDay" INTEGER;

UPDATE "CreatorBillingEntitlement" e
SET
  "billingAnchorDay" = EXTRACT(DAY FROM COALESCE(e."currentPeriodStartedAt", e."coreValidFrom", e."subscriptionStartedAt"))::INTEGER,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE e."billingAnchorDay" IS NULL
  AND COALESCE(e."currentPeriodStartedAt", e."coreValidFrom", e."subscriptionStartedAt") IS NOT NULL;

UPDATE "CreatorBillingEntitlement" e
SET
  "autoRenewEnabled" = false,
  "nextRenewalAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE e."autoRenewEnabled" = true
  AND e."coreSource" IN (
    'ADMIN'::"BillingEntitlementSource",
    'LEGACY'::"BillingEntitlementSource",
    'PAYMENT'::"BillingEntitlementSource"
  );


-- ADMIN/LEGACY access with no payment provenance has no wallet environment.
-- Leaving this NULL prevents an inferred sandbox/live identity from becoming
-- monetary authority later.
UPDATE "CreatorBillingEntitlement" e
SET
  "walletTestMode" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE e."coreLastOrderId" IS NULL
  AND e."coreSource" IN ('ADMIN'::"BillingEntitlementSource", 'LEGACY'::"BillingEntitlementSource");
