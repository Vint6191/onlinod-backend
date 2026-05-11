-- Money attribution / team claims v1

CREATE TABLE IF NOT EXISTS "MoneyAttribution" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "eventHash" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "creatorId" TEXT,
  "accountId" TEXT,
  "fanId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'auto',
  "attributedToMemberId" TEXT,
  "attributedToUserId" TEXT,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "lockedAt" TIMESTAMP(3),
  "history" JSONB NOT NULL DEFAULT '[]',
  "autoAttributedToMemberId" TEXT,
  "autoAttributedToUserId" TEXT,
  "autoReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MoneyAttribution_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MoneyAttribution_agencyId_eventHash_key" ON "MoneyAttribution"("agencyId", "eventHash");
CREATE INDEX IF NOT EXISTS "MoneyAttribution_agencyId_occurredAt_idx" ON "MoneyAttribution"("agencyId", "occurredAt");
CREATE INDEX IF NOT EXISTS "MoneyAttribution_agencyId_attributedToMemberId_occurredAt_idx" ON "MoneyAttribution"("agencyId", "attributedToMemberId", "occurredAt");
CREATE INDEX IF NOT EXISTS "MoneyAttribution_agencyId_locked_occurredAt_idx" ON "MoneyAttribution"("agencyId", "locked", "occurredAt");
