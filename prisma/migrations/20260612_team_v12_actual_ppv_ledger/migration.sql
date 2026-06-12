-- Team Analytics v12 — actual backend PPV ledger + resolver.
-- Raw ledgers are intentionally metadata-only: no message text, no body, no media URLs.

CREATE TABLE IF NOT EXISTS "TeamSentMessageLedger" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT 'unknown',
  "creatorId" TEXT,
  "creatorRef" TEXT,
  "memberId" TEXT,
  "userId" TEXT,
  "deviceId" TEXT,
  "shiftKey" TEXT,
  "dialogId" TEXT,
  "fanId" TEXT,
  "messageId" TEXT,
  "localSeed" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL,
  "messageKind" TEXT NOT NULL DEFAULT 'text',
  "isPpv" BOOLEAN NOT NULL DEFAULT false,
  "priceCents" INTEGER,
  "currency" TEXT,
  "mediaCount" INTEGER NOT NULL DEFAULT 0,
  "mediaIds" JSONB,
  "campaignId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual_chat',
  "telemetryEventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamSentMessageLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamSentMessageLedger_agencyId_accountId_localSeed_key"
  ON "TeamSentMessageLedger"("agencyId", "accountId", "localSeed");
CREATE UNIQUE INDEX IF NOT EXISTS "TeamSentMessageLedger_agencyId_accountId_messageId_key"
  ON "TeamSentMessageLedger"("agencyId", "accountId", "messageId");
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_agencyId_messageId_idx"
  ON "TeamSentMessageLedger"("agencyId", "messageId");
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_agencyId_accountId_messageId_idx"
  ON "TeamSentMessageLedger"("agencyId", "accountId", "messageId");
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_agencyId_creatorId_sentAt_idx"
  ON "TeamSentMessageLedger"("agencyId", "creatorId", "sentAt");
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_agencyId_memberId_sentAt_idx"
  ON "TeamSentMessageLedger"("agencyId", "memberId", "sentAt");
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_agencyId_isPpv_sentAt_idx"
  ON "TeamSentMessageLedger"("agencyId", "isPpv", "sentAt");
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_agencyId_dialogId_sentAt_idx"
  ON "TeamSentMessageLedger"("agencyId", "dialogId", "sentAt");

CREATE TABLE IF NOT EXISTS "TeamPpvPurchaseLedger" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT 'unknown',
  "creatorId" TEXT,
  "creatorRef" TEXT,
  "purchaseId" TEXT NOT NULL,
  "messageId" TEXT,
  "dialogId" TEXT,
  "fanId" TEXT,
  "buyerFanId" TEXT,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "purchasedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unresolved',
  "attributedMemberId" TEXT,
  "attributedUserId" TEXT,
  "attributedShiftKey" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedByDeviceId" TEXT,
  "resolvedSource" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamPpvPurchaseLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamPpvPurchaseLedger_agencyId_purchaseId_key"
  ON "TeamPpvPurchaseLedger"("agencyId", "purchaseId");
CREATE INDEX IF NOT EXISTS "TeamPpvPurchaseLedger_agencyId_messageId_idx"
  ON "TeamPpvPurchaseLedger"("agencyId", "messageId");
CREATE INDEX IF NOT EXISTS "TeamPpvPurchaseLedger_agencyId_status_purchasedAt_idx"
  ON "TeamPpvPurchaseLedger"("agencyId", "status", "purchasedAt");
CREATE INDEX IF NOT EXISTS "TeamPpvPurchaseLedger_agencyId_attributedMemberId_purchasedAt_idx"
  ON "TeamPpvPurchaseLedger"("agencyId", "attributedMemberId", "purchasedAt");

CREATE TABLE IF NOT EXISTS "TeamPpvResolveJob" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT 'unknown',
  "creatorId" TEXT,
  "creatorRef" TEXT,
  "purchaseId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "purchasedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "resolvedByMemberId" TEXT,
  "resolvedByDeviceId" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamPpvResolveJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamPpvResolveJob_agencyId_purchaseId_messageId_key"
  ON "TeamPpvResolveJob"("agencyId", "purchaseId", "messageId");
CREATE INDEX IF NOT EXISTS "TeamPpvResolveJob_agencyId_status_createdAt_idx"
  ON "TeamPpvResolveJob"("agencyId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "TeamPpvResolveJob_agencyId_messageId_idx"
  ON "TeamPpvResolveJob"("agencyId", "messageId");
