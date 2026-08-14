-- V14 Billing Wallet + Automatic Pricing
-- Additive migration: keeps every V13/V13.3 order and entitlement valid.
-- Existing prepaid access is honored until its current coreValidUntil; only
-- future wallet renewals are forced to one-month automatic-pricing periods.

ALTER TYPE "BillingEntitlementSource" ADD VALUE IF NOT EXISTS 'WALLET';

CREATE TYPE "BillingOrderPurpose" AS ENUM ('SUBSCRIPTION', 'WALLET_TOP_UP');
CREATE TYPE "BillingWalletTransactionType" AS ENUM ('TOP_UP', 'SUBSCRIPTION_DEBIT', 'TOP_UP_REFUND', 'ADMIN_ADJUSTMENT');
CREATE TYPE "CreatorBillingPeriodStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'LEGACY');

ALTER TABLE "BillingOrder"
  ADD COLUMN "purpose" "BillingOrderPurpose" NOT NULL DEFAULT 'SUBSCRIPTION';

ALTER TABLE "CreatorBillingProfile"
  ALTER COLUMN "tierMode" SET DEFAULT 'AUTO';

ALTER TABLE "CreatorBillingEntitlement"
  ADD COLUMN "subscriptionStartedAt" TIMESTAMP(3),
  ADD COLUMN "currentPeriodStartedAt" TIMESTAMP(3),
  ADD COLUMN "currentPeriodEndsAt" TIMESTAMP(3),
  ADD COLUMN "nextRenewalAt" TIMESTAMP(3),
  ADD COLUMN "tierAtPeriodStart" "CreatorBillingTier",
  ADD COLUMN "amountChargedForPeriodCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "autoRenewEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastRenewalAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastRenewalErrorCode" TEXT,
  ADD COLUMN "lastRevenue30dCents" INTEGER,
  ADD COLUMN "lastRevenueCapturedAt" TIMESTAMP(3),
  ADD COLUMN "walletTestMode" BOOLEAN;

CREATE TABLE "AgencyBillingWallet" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "testMode" BOOLEAN NOT NULL DEFAULT false,
  "balanceCents" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgencyBillingWallet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingWalletTransaction" (
  "id" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT,
  "orderId" TEXT,
  "testMode" BOOLEAN NOT NULL DEFAULT false,
  "periodId" TEXT,
  "type" "BillingWalletTransactionType" NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "balanceAfterCents" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "idempotencyKey" TEXT NOT NULL,
  "description" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingWalletTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorBillingPeriod" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "testMode" BOOLEAN NOT NULL DEFAULT false,
  "tier" "CreatorBillingTier" NOT NULL,
  "revenue30dCents" INTEGER NOT NULL,
  "revenueCapturedAt" TIMESTAMP(3),
  "pricingSource" TEXT NOT NULL DEFAULT 'AUTO_30D',
  "corePriceCents" INTEGER NOT NULL,
  "aiChatterEnabled" BOOLEAN NOT NULL DEFAULT false,
  "aiChatterPriceCents" INTEGER NOT NULL DEFAULT 0,
  "outreachEnabled" BOOLEAN NOT NULL DEFAULT false,
  "outreachPriceCents" INTEGER NOT NULL DEFAULT 0,
  "totalCents" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "status" "CreatorBillingPeriodStatus" NOT NULL DEFAULT 'ACTIVE',
  "renewalKey" TEXT NOT NULL,
  "walletTransactionId" TEXT,
  "sourceOrderId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorBillingPeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgencyBillingWallet_agencyId_testMode_key" ON "AgencyBillingWallet"("agencyId", "testMode");
CREATE INDEX "AgencyBillingWallet_updatedAt_idx" ON "AgencyBillingWallet"("updatedAt");
CREATE UNIQUE INDEX "BillingWalletTransaction_idempotencyKey_key" ON "BillingWalletTransaction"("idempotencyKey");
CREATE INDEX "BillingWalletTransaction_agencyId_createdAt_idx" ON "BillingWalletTransaction"("agencyId", "createdAt");
CREATE INDEX "BillingWalletTransaction_agencyId_creatorId_createdAt_idx" ON "BillingWalletTransaction"("agencyId", "creatorId", "createdAt");
CREATE INDEX "BillingWalletTransaction_orderId_idx" ON "BillingWalletTransaction"("orderId");
CREATE INDEX "BillingWalletTransaction_periodId_idx" ON "BillingWalletTransaction"("periodId");
CREATE UNIQUE INDEX "CreatorBillingPeriod_renewalKey_key" ON "CreatorBillingPeriod"("renewalKey");
CREATE UNIQUE INDEX "CreatorBillingPeriod_walletTransactionId_key" ON "CreatorBillingPeriod"("walletTransactionId");
CREATE INDEX "CreatorBillingPeriod_agencyId_creatorId_startedAt_idx" ON "CreatorBillingPeriod"("agencyId", "creatorId", "startedAt");
CREATE INDEX "CreatorBillingPeriod_creatorId_endsAt_idx" ON "CreatorBillingPeriod"("creatorId", "endsAt");
CREATE INDEX "CreatorBillingPeriod_status_endsAt_idx" ON "CreatorBillingPeriod"("status", "endsAt");

ALTER TABLE "AgencyBillingWallet" ADD CONSTRAINT "AgencyBillingWallet_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingWalletTransaction" ADD CONSTRAINT "BillingWalletTransaction_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "AgencyBillingWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingWalletTransaction" ADD CONSTRAINT "BillingWalletTransaction_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorBillingPeriod" ADD CONSTRAINT "CreatorBillingPeriod_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing agency gets a zero-balance wallet. This is not a payment and
-- therefore intentionally creates no wallet ledger transaction.
INSERT INTO "AgencyBillingWallet" ("id", "agencyId", "testMode", "balanceCents", "currency", "createdAt", "updatedAt")
SELECT 'wallet_' || md5(a."id" || 'live'), a."id", false, 0, 'USD', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Agency" a
ON CONFLICT ("agencyId", "testMode") DO NOTHING;

-- V13 checkout wrote MANUAL on every customer-selected non-custom tier. V14
-- removes customer tier selection, so all ordinary profiles return to AUTO.
-- CUSTOM remains an explicit administrator override.
UPDATE "CreatorBillingProfile"
SET "tierMode" = 'AUTO', "updatedAt" = CURRENT_TIMESTAMP
WHERE "tier" <> 'CUSTOM'::"CreatorBillingTier"
  AND "tierMode" <> 'AUTO';

-- Preserve exact existing prepaid access. We do not split a historic 3/6 month
-- payment into invented monthly rows; V14 monthly periods begin only after this
-- already-paid end date.
UPDATE "CreatorBillingEntitlement" e
SET
  "subscriptionStartedAt" = COALESCE(e."subscriptionStartedAt", e."coreValidFrom"),
  "currentPeriodStartedAt" = COALESCE(e."currentPeriodStartedAt", e."coreValidFrom"),
  "currentPeriodEndsAt" = COALESCE(e."currentPeriodEndsAt", e."coreValidUntil"),
  "nextRenewalAt" = COALESCE(e."nextRenewalAt", e."coreValidUntil"),
  "tierAtPeriodStart" = COALESCE(e."tierAtPeriodStart", e."tier"),
  "amountChargedForPeriodCents" = CASE
    WHEN e."amountChargedForPeriodCents" > 0 THEN e."amountChargedForPeriodCents"
    ELSE GREATEST(0, COALESCE(
      (SELECT l."lineTotalCents" FROM "BillingOrderLine" l WHERE l."orderId" = e."coreLastOrderId" AND l."creatorId" = e."creatorId" LIMIT 1),
      COALESCE(e."corePriceCents", 0) + COALESCE(e."aiChatterPriceCents", 0) + COALESCE(e."outreachPriceCents", 0)
    ))
  END,
  "autoRenewEnabled" = CASE
    WHEN e."coreValidUntil" > CURRENT_TIMESTAMP
      AND COALESCE((
        SELECT s."billingMode" <> 'FREE_INTERNAL'::"BillingMode"
        FROM "AgencySubscription" s
        WHERE s."agencyId" = e."agencyId"
        ORDER BY s."createdAt" DESC
        LIMIT 1
      ), true)
    THEN true
    ELSE e."autoRenewEnabled"
  END,
  "walletTestMode" = COALESCE(
    e."walletTestMode",
    (SELECT o."testMode" FROM "BillingOrder" o WHERE o."id" = e."coreLastOrderId" LIMIT 1),
    false
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE e."coreValidFrom" IS NOT NULL OR e."coreValidUntil" IS NOT NULL;
