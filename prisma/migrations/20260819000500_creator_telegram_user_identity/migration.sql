ALTER TABLE "CreatorAccount"
ADD COLUMN "telegramUserId" TEXT;

CREATE INDEX "CreatorAccount_agencyId_telegramUserId_idx"
ON "CreatorAccount"("agencyId", "telegramUserId");
