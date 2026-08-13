-- ONLINOD V13 — NOWPayments billing foundation.
-- Additive only. Existing AgencySubscription / CreatorBillingProfile remain authoritative read models.

CREATE TYPE "BillingProvider" AS ENUM ('NOWPAYMENTS');
CREATE TYPE "BillingOrderStatus" AS ENUM ('CREATED', 'CHECKOUT_CREATED', 'PROCESSING', 'PARTIALLY_PAID', 'PAID', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELLED');

CREATE TABLE "BillingOrder" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "provider" "BillingProvider" NOT NULL DEFAULT 'NOWPAYMENTS',
  "status" "BillingOrderStatus" NOT NULL DEFAULT 'CREATED',
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "billingPeriod" "BillingPeriod" NOT NULL,
  "periodMonths" INTEGER NOT NULL,
  "billedCreators" INTEGER NOT NULL,
  "pricingSnapshot" JSONB NOT NULL,
  "providerInvoiceId" TEXT,
  "providerInvoiceUrl" TEXT,
  "providerStatus" TEXT,
  "testMode" BOOLEAN NOT NULL DEFAULT false,
  "paidAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingPaymentAttempt" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "provider" "BillingProvider" NOT NULL DEFAULT 'NOWPAYMENTS',
  "testMode" BOOLEAN NOT NULL DEFAULT false,
  "providerPaymentId" TEXT NOT NULL,
  "providerStatus" TEXT,
  "priceAmount" DECIMAL(30,12),
  "priceCurrency" TEXT,
  "payAmount" DECIMAL(30,12),
  "payCurrency" TEXT,
  "actuallyPaid" DECIMAL(30,12),
  "outcomeAmount" DECIMAL(30,12),
  "outcomeCurrency" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingPaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingProviderEvent" (
  "id" TEXT NOT NULL,
  "provider" "BillingProvider" NOT NULL DEFAULT 'NOWPAYMENTS',
  "eventKey" TEXT NOT NULL,
  "orderId" TEXT,
  "paymentAttemptId" TEXT,
  "providerStatus" TEXT,
  "signature" TEXT,
  "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "processingError" TEXT,
  CONSTRAINT "BillingProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingOrder_provider_testMode_providerInvoiceId_key" ON "BillingOrder"("provider", "testMode", "providerInvoiceId");
CREATE INDEX "BillingOrder_agencyId_createdAt_idx" ON "BillingOrder"("agencyId", "createdAt");
CREATE INDEX "BillingOrder_agencyId_status_idx" ON "BillingOrder"("agencyId", "status");
CREATE INDEX "BillingOrder_status_createdAt_idx" ON "BillingOrder"("status", "createdAt");

CREATE UNIQUE INDEX "BillingPaymentAttempt_provider_testMode_providerPaymentId_key" ON "BillingPaymentAttempt"("provider", "testMode", "providerPaymentId");
CREATE INDEX "BillingPaymentAttempt_orderId_createdAt_idx" ON "BillingPaymentAttempt"("orderId", "createdAt");
CREATE INDEX "BillingPaymentAttempt_providerStatus_idx" ON "BillingPaymentAttempt"("providerStatus");

CREATE UNIQUE INDEX "BillingProviderEvent_eventKey_key" ON "BillingProviderEvent"("eventKey");
CREATE INDEX "BillingProviderEvent_orderId_receivedAt_idx" ON "BillingProviderEvent"("orderId", "receivedAt");
CREATE INDEX "BillingProviderEvent_paymentAttemptId_receivedAt_idx" ON "BillingProviderEvent"("paymentAttemptId", "receivedAt");
CREATE INDEX "BillingProviderEvent_providerStatus_idx" ON "BillingProviderEvent"("providerStatus");
CREATE INDEX "BillingProviderEvent_receivedAt_idx" ON "BillingProviderEvent"("receivedAt");

ALTER TABLE "BillingOrder"
  ADD CONSTRAINT "BillingOrder_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BillingPaymentAttempt"
  ADD CONSTRAINT "BillingPaymentAttempt_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "BillingOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BillingProviderEvent"
  ADD CONSTRAINT "BillingProviderEvent_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "BillingOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BillingProviderEvent"
  ADD CONSTRAINT "BillingProviderEvent_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "BillingPaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
