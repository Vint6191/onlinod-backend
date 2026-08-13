-- ONLINOD V13.1 — NOWPayments billing hardening.
-- Additive only: persistent checkout idempotency key.

ALTER TABLE "BillingOrder"
  ADD COLUMN "checkoutKey" TEXT;

CREATE UNIQUE INDEX "BillingOrder_agencyId_provider_testMode_checkoutKey_key"
  ON "BillingOrder"("agencyId", "provider", "testMode", "checkoutKey");
