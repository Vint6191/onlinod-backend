-- ONLINOD V14.1 — native NOWPayments top-up metadata.
-- Hosted checkout pages are no longer required for the primary wallet top-up flow.

ALTER TABLE "BillingPaymentAttempt"
  ADD COLUMN IF NOT EXISTS "payAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "payinExtraId" TEXT,
  ADD COLUMN IF NOT EXISTS "purchaseId" TEXT;
