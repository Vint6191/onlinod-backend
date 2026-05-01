CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELLED', 'LOCKED');
CREATE TYPE "BillingMode" AS ENUM ('MANUAL', 'STRIPE', 'CRYPTO', 'FREE_INTERNAL');
CREATE TYPE "CreatorBillingTier" AS ENUM ('STARTER', 'GROWTH', 'PRO', 'ELITE', 'CUSTOM');
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'THREE_MONTHS', 'SIX_MONTHS');

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agency" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'TRIAL';
ALTER TABLE "Agency" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Agency" ADD COLUMN IF NOT EXISTS "currentPeriodEnd" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AgencySubscription" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
  "billingMode" "BillingMode" NOT NULL DEFAULT 'MANUAL',
  "billingPeriod" "BillingPeriod" NOT NULL DEFAULT 'MONTHLY',
  "corePricePerCreatorCents" INTEGER NOT NULL DEFAULT 2000,
  "trialEndsAt" TIMESTAMP(3),
  "graceUntil" TIMESTAMP(3),
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgencySubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CreatorBillingProfile" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "tier" "CreatorBillingTier" NOT NULL DEFAULT 'STARTER',
  "tierMode" TEXT NOT NULL DEFAULT 'MANUAL',
  "corePriceCents" INTEGER NOT NULL DEFAULT 2000,
  "revenue30dCents" INTEGER NOT NULL DEFAULT 0,
  "aiChatterEnabled" BOOLEAN NOT NULL DEFAULT false,
  "aiChatterPriceCents" INTEGER NOT NULL DEFAULT 10000,
  "outreachEnabled" BOOLEAN NOT NULL DEFAULT false,
  "outreachPriceCents" INTEGER NOT NULL DEFAULT 2900,
  "billingExcluded" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorBillingProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdminActionLog" (
  "id" TEXT NOT NULL,
  "adminUserId" TEXT NOT NULL,
  "agencyId" TEXT,
  "action" TEXT NOT NULL,
  "targetType" TEXT,
  "targetId" TEXT,
  "before" JSONB,
  "after" JSONB,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminActionLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorBillingProfile_creatorId_key" ON "CreatorBillingProfile"("creatorId");
CREATE INDEX IF NOT EXISTS "AgencySubscription_agencyId_idx" ON "AgencySubscription"("agencyId");
CREATE INDEX IF NOT EXISTS "CreatorBillingProfile_agencyId_idx" ON "CreatorBillingProfile"("agencyId");
CREATE INDEX IF NOT EXISTS "AdminActionLog_agencyId_idx" ON "AdminActionLog"("agencyId");
