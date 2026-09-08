ALTER TABLE "TelegramDeliveryIntent"
  ADD COLUMN "providerBindingRepairAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "providerBindingRetryAt" TIMESTAMP(3);

CREATE INDEX "TelegramDeliveryIntent_agencyId_state_providerBindingRetryAt_idx"
  ON "TelegramDeliveryIntent"("agencyId", "state", "providerBindingRetryAt");
