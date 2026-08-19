-- Standard BotFather bot upload workflow over MTProto. No Telegram Business tables or media blobs.
CREATE TYPE "CustomOrderTelegramTransport" AS ENUM ('USER', 'BOT');

ALTER TABLE "AgencyTelegramMtprotoAccount"
  ADD COLUMN "customBotUsername" TEXT;

ALTER TABLE "CustomOrder"
  ADD COLUMN "telegramTaskTransport" "CustomOrderTelegramTransport" NOT NULL DEFAULT 'USER',
  ADD COLUMN "telegramBotControlMessageId" INTEGER,
  ADD COLUMN "telegramUploadKey" TEXT,
  ADD COLUMN "telegramUploadArmedAt" TIMESTAMP(3),
  ADD COLUMN "telegramSubmissionMessageIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "telegramSubmissionReceivedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "CustomOrder_telegramUploadKey_key" ON "CustomOrder"("telegramUploadKey");

CREATE UNIQUE INDEX "AgencyTelegramMtprotoAccount_customBotUsername_key" ON "AgencyTelegramMtprotoAccount"("customBotUsername");
