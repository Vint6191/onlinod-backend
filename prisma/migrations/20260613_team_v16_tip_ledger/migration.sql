-- v16: move tip_received attribution out of legacy MoneyAttribution.
-- PPV stays in TeamPpvPurchaseLedger; subscriptions are not Team member revenue.

CREATE TABLE IF NOT EXISTS "TeamTipLedger" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT 'unknown',
  "creatorId" TEXT,
  "creatorRef" TEXT,
  "eventHash" TEXT NOT NULL,
  "tipId" TEXT NOT NULL,
  "messageId" TEXT,
  "dialogId" TEXT,
  "fanId" TEXT,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'creator_revenue',
  "attributedMemberId" TEXT,
  "attributedUserId" TEXT,
  "attributedShiftKey" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedByMemberId" TEXT,
  "resolvedSource" TEXT,
  "candidates" JSONB,
  "weakCandidates" JSONB,
  "result" JSONB,
  "history" JSONB NOT NULL DEFAULT '[]',
  "source" TEXT NOT NULL DEFAULT 'claims_ingest',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TeamTipLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamTipLedger_agencyId_eventHash_key" ON "TeamTipLedger"("agencyId", "eventHash");
CREATE INDEX IF NOT EXISTS "TeamTipLedger_agencyId_status_receivedAt_idx" ON "TeamTipLedger"("agencyId", "status", "receivedAt");
CREATE INDEX IF NOT EXISTS "TeamTipLedger_agencyId_attributedMemberId_receivedAt_idx" ON "TeamTipLedger"("agencyId", "attributedMemberId", "receivedAt");
CREATE INDEX IF NOT EXISTS "TeamTipLedger_agencyId_fanId_receivedAt_idx" ON "TeamTipLedger"("agencyId", "fanId", "receivedAt");
CREATE INDEX IF NOT EXISTS "TeamTipLedger_agencyId_creatorId_receivedAt_idx" ON "TeamTipLedger"("agencyId", "creatorId", "receivedAt");
