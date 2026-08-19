-- V19.12.1 cleanup: remove the abandoned BotFather/standard-bot custom upload experiment.
-- The original V19.12 migration remains in migration history so already-deployed databases stay consistent.
DROP INDEX IF EXISTS "CustomOrder_telegramUploadKey_key";
DROP INDEX IF EXISTS "AgencyTelegramMtprotoAccount_customBotUsername_key";

ALTER TABLE "CustomOrder"
  DROP COLUMN IF EXISTS "telegramTaskTransport",
  DROP COLUMN IF EXISTS "telegramBotControlMessageId",
  DROP COLUMN IF EXISTS "telegramUploadKey",
  DROP COLUMN IF EXISTS "telegramUploadArmedAt",
  DROP COLUMN IF EXISTS "telegramSubmissionMessageIds",
  DROP COLUMN IF EXISTS "telegramSubmissionReceivedAt";

ALTER TABLE "AgencyTelegramMtprotoAccount"
  DROP COLUMN IF EXISTS "customBotUsername";

DROP TYPE IF EXISTS "CustomOrderTelegramTransport";
