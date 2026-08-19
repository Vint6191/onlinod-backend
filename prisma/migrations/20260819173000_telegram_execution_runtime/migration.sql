ALTER TABLE "AgencyTelegramMtprotoAccount"
  ADD COLUMN "runtimeClaimedByDeviceId" TEXT,
  ADD COLUMN "runtimeClaimToken" TEXT,
  ADD COLUMN "runtimeClaimUntil" TIMESTAMP(3);

ALTER TABLE "CustomOrder"
  ADD COLUMN "telegramLastModelMessageId" INTEGER,
  ADD COLUMN "telegramLastModelMessageAt" TIMESTAMP(3);

CREATE INDEX "CustomOrder_agencyId_creatorId_telegramTaskMessageId_idx"
  ON "CustomOrder"("agencyId", "creatorId", "telegramTaskMessageId");
