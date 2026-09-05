-- Audit: Custom Orders / Telegram Transaction Authority / Submission Intake / Media Handoff
-- Existing CustomOrder rows predate client mutation identity, so the column is nullable for migration compatibility.
ALTER TABLE "CustomOrder" ADD COLUMN "clientMutationId" TEXT;
ALTER TABLE "CustomOrder" ADD COLUMN "clientMutationFingerprint" TEXT;
CREATE UNIQUE INDEX "CustomOrder_agency_clientMutationId_key" ON "CustomOrder"("agencyId", "clientMutationId");

ALTER TABLE "CustomContentSubmission" ADD COLUMN "telegramInboundEventIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CustomContentSubmission" ADD COLUMN "telegramSourceKey" TEXT;
CREATE UNIQUE INDEX "CustomContentSubmission_telegramSourceKey_key" ON "CustomContentSubmission"("telegramSourceKey");

CREATE TABLE "TelegramDeliveryIntent" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "customOrderId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "logicalKey" TEXT NOT NULL,
  "clientIntentId" TEXT,
  "referenceOrdinal" INTEGER,
  "payloadFingerprint" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "state" TEXT NOT NULL DEFAULT 'PLANNED',
  "deviceId" TEXT,
  "userId" TEXT,
  "memberId" TEXT,
  "accessEpoch" INTEGER,
  "claimTokenHash" TEXT,
  "claimRevision" INTEGER NOT NULL DEFAULT 0,
  "claimUntil" TIMESTAMP(3),
  "commitStartedAt" TIMESTAMP(3),
  "remoteMessageId" INTEGER,
  "remoteRecipientTelegramUserId" TEXT,
  "remoteSentAt" TIMESTAMP(3),
  "outcomeReason" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelegramDeliveryIntent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramDeliveryIntent_logicalKey_key" ON "TelegramDeliveryIntent"("logicalKey");
CREATE INDEX "TelegramDeliveryIntent_agencyId_state_createdAt_idx" ON "TelegramDeliveryIntent"("agencyId", "state", "createdAt");
CREATE INDEX "TelegramDeliveryIntent_agencyId_creatorId_state_idx" ON "TelegramDeliveryIntent"("agencyId", "creatorId", "state");
CREATE INDEX "TelegramDeliveryIntent_agencyId_customOrderId_kind_createdAt_idx" ON "TelegramDeliveryIntent"("agencyId", "customOrderId", "kind", "createdAt");
CREATE UNIQUE INDEX "TelegramDeliveryIntent_reference_ordinal_key" ON "TelegramDeliveryIntent"("customOrderId", "kind", "referenceOrdinal");
CREATE INDEX "TelegramDeliveryIntent_agencyId_accountId_state_idx" ON "TelegramDeliveryIntent"("agencyId", "accountId", "state");
CREATE INDEX "TelegramDeliveryIntent_agencyId_accountId_remoteRecipientTelegramUserId_state_idx" ON "TelegramDeliveryIntent"("agencyId", "accountId", "remoteRecipientTelegramUserId", "state");
CREATE INDEX "TelegramDeliveryIntent_customOrderId_remoteMessageId_idx" ON "TelegramDeliveryIntent"("customOrderId", "remoteMessageId");

CREATE TABLE "TelegramInboundEvent" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "creatorId" TEXT,
  "customOrderId" TEXT,
  "submissionId" TEXT,
  "senderTelegramUserId" TEXT NOT NULL,
  "messageId" INTEGER NOT NULL,
  "replyToMessageId" INTEGER,
  "groupedId" TEXT,
  "hasMedia" BOOLEAN NOT NULL DEFAULT false,
  "text" TEXT,
  "sentAt" TIMESTAMP(3) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelegramInboundEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramInboundEvent_provider_message_key" ON "TelegramInboundEvent"("agencyId", "accountId", "senderTelegramUserId", "messageId");
CREATE INDEX "TelegramInboundEvent_agencyId_creatorId_sentAt_idx" ON "TelegramInboundEvent"("agencyId", "creatorId", "sentAt");
CREATE INDEX "TelegramInboundEvent_agencyId_customOrderId_sentAt_idx" ON "TelegramInboundEvent"("agencyId", "customOrderId", "sentAt");
CREATE INDEX "TelegramInboundEvent_agencyId_accountId_replyToMessageId_idx" ON "TelegramInboundEvent"("agencyId", "accountId", "replyToMessageId");
CREATE INDEX "TelegramInboundEvent_submissionId_idx" ON "TelegramInboundEvent"("submissionId");
