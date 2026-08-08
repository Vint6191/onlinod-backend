-- Financial transactions v1: durable all-time payout ledger + typed all-time chart totals.
-- Raw OnlyFans JSON is intentionally not stored.

ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'FINANCIAL_TRANSACTIONS';

DO $$ BEGIN
  CREATE TYPE "CreatorFinancialTransactionFactType" AS ENUM ('SALE', 'TIP', 'PAID_SUBSCRIPTION', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorFinancialTransactionProjectionStatus" AS ENUM ('PROJECTED', 'STORED_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorEarningsCategory" AS ENUM ('TOTAL', 'SUBSCRIPTIONS', 'MESSAGES', 'TIPS', 'POSTS', 'STREAMS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "CreatorSale"
  ADD COLUMN IF NOT EXISTS "feeCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "netCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "taxCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "vatCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaTaxCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "transactionStatus" TEXT;

ALTER TABLE "CreatorTip"
  ADD COLUMN IF NOT EXISTS "feeCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "netCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "taxCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "vatCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaTaxCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "transactionStatus" TEXT;

ALTER TABLE "CreatorPaidSubscription"
  ADD COLUMN IF NOT EXISTS "feeCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "netCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "taxCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "vatCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaTaxCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "transactionStatus" TEXT;

CREATE TABLE IF NOT EXISTS "CreatorFinancialTransaction" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT,
  "fanOnlyFansUserId" TEXT,
  "externalTransactionId" TEXT NOT NULL,
  "transactionType" TEXT NOT NULL,
  "factType" "CreatorFinancialTransactionFactType" NOT NULL DEFAULT 'OTHER',
  "projectionStatus" "CreatorFinancialTransactionProjectionStatus" NOT NULL DEFAULT 'STORED_ONLY',
  "amountCents" INTEGER NOT NULL,
  "feeCents" INTEGER,
  "netCents" INTEGER,
  "taxCents" INTEGER,
  "vatCents" INTEGER,
  "mediaTaxCents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "transactionStatus" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3),
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "scanRunId" TEXT,
  "page" INTEGER,
  "ordinal" INTEGER,
  "reasonCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorFinancialTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorFinancialTransaction_creatorId_externalTransactionId_key"
  ON "CreatorFinancialTransaction"("creatorId", "externalTransactionId");
CREATE INDEX IF NOT EXISTS "CreatorFinancialTransaction_agencyId_creatorId_occurredAt_idx"
  ON "CreatorFinancialTransaction"("agencyId", "creatorId", "occurredAt");
CREATE INDEX IF NOT EXISTS "CreatorFinancialTransaction_creatorId_fanId_occurredAt_idx"
  ON "CreatorFinancialTransaction"("creatorId", "fanId", "occurredAt");
CREATE INDEX IF NOT EXISTS "CreatorFinancialTransaction_creatorId_transactionType_occurredAt_idx"
  ON "CreatorFinancialTransaction"("creatorId", "transactionType", "occurredAt");
CREATE INDEX IF NOT EXISTS "CreatorFinancialTransaction_creatorId_sourceJobId_page_idx"
  ON "CreatorFinancialTransaction"("creatorId", "sourceJobId", "page");
CREATE INDEX IF NOT EXISTS "CreatorFinancialTransaction_creatorId_scanRunId_page_idx"
  ON "CreatorFinancialTransaction"("creatorId", "scanRunId", "page");
CREATE INDEX IF NOT EXISTS "CreatorFinancialTransaction_sourceJobId_idx"
  ON "CreatorFinancialTransaction"("sourceJobId");

DO $$ BEGIN
  ALTER TABLE "CreatorFinancialTransaction"
    ADD CONSTRAINT "CreatorFinancialTransaction_creatorId_fanId_fkey"
    FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CreatorFinancialTransaction"
    ADD CONSTRAINT "CreatorFinancialTransaction_agencyId_creatorId_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CreatorFinancialTransaction"
    ADD CONSTRAINT "CreatorFinancialTransaction_sourceDeviceId_fkey"
    FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CreatorFinancialTransaction"
    ADD CONSTRAINT "CreatorFinancialTransaction_sourceJobId_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CreatorEarningsTotal" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "category" "CreatorEarningsCategory" NOT NULL,
  "rangeFrom" TIMESTAMP(3) NOT NULL,
  "rangeTo" TIMESTAMP(3) NOT NULL,
  "grossCents" INTEGER NOT NULL,
  "netCents" INTEGER NOT NULL,
  "transactionsCount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "scanRunId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorEarningsTotal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorEarningsTotal_creatorId_category_key"
  ON "CreatorEarningsTotal"("creatorId", "category");
CREATE INDEX IF NOT EXISTS "CreatorEarningsTotal_agencyId_creatorId_category_idx"
  ON "CreatorEarningsTotal"("agencyId", "creatorId", "category");
CREATE INDEX IF NOT EXISTS "CreatorEarningsTotal_creatorId_sourceJobId_idx"
  ON "CreatorEarningsTotal"("creatorId", "sourceJobId");
CREATE INDEX IF NOT EXISTS "CreatorEarningsTotal_sourceJobId_idx"
  ON "CreatorEarningsTotal"("sourceJobId");

DO $$ BEGIN
  ALTER TABLE "CreatorEarningsTotal"
    ADD CONSTRAINT "CreatorEarningsTotal_agencyId_creatorId_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CreatorEarningsTotal"
    ADD CONSTRAINT "CreatorEarningsTotal_sourceDeviceId_fkey"
    FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CreatorEarningsTotal"
    ADD CONSTRAINT "CreatorEarningsTotal_sourceJobId_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Monetary fields in the source transaction ledger are intentionally signed.
-- Refunds, chargebacks and corrections must remain durable facts instead of being rejected.
