-- Traffic core v1: source/member attribution + fan value snapshots + paid subscription ledger.
-- No raw websocket/API payloads are stored here.

CREATE TABLE "TrafficSource" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT 'unknown',
  "sourceType" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "name" TEXT,
  "url" TEXT,
  "status" TEXT,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "lastScannedAt" TIMESTAMP(3),
  "costCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "stats" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrafficSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrafficSourceMember" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "convertedAt" TIMESTAMP(3),
  "lastUserInfoFetchedAt" TIMESTAMP(3),
  "lastValueFetchedAt" TIMESTAMP(3),
  "lastRevenueAt" TIMESTAMP(3),
  "needsValueRefresh" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrafficSourceMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrafficFanValueSnapshot" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "totalSummCents" INTEGER NOT NULL DEFAULT 0,
  "messagesSummCents" INTEGER NOT NULL DEFAULT 0,
  "tipsSummCents" INTEGER NOT NULL DEFAULT 0,
  "subscribesSummCents" INTEGER NOT NULL DEFAULT 0,
  "postsSummCents" INTEGER NOT NULL DEFAULT 0,
  "streamsSummCents" INTEGER NOT NULL DEFAULT 0,
  "lastActivity" TIMESTAMP(3),
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL DEFAULT 'fan_value_core',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrafficFanValueSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorSubscriptionLedger" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT 'unknown',
  "fanId" TEXT NOT NULL,
  "sourceId" TEXT,
  "eventType" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "externalEventId" TEXT,
  "eventHash" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'realtime',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSubscriptionLedger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrafficDailyAggregate" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "day" TIMESTAMP(3) NOT NULL,
  "claimers" INTEGER NOT NULL DEFAULT 0,
  "freeSubs" INTEGER NOT NULL DEFAULT 0,
  "paidSubs" INTEGER NOT NULL DEFAULT 0,
  "renewals" INTEGER NOT NULL DEFAULT 0,
  "refunds" INTEGER NOT NULL DEFAULT 0,
  "grossCents" INTEGER NOT NULL DEFAULT 0,
  "netCents" INTEGER NOT NULL DEFAULT 0,
  "costCents" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrafficDailyAggregate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrafficSource_agencyId_creatorId_sourceType_externalId_key" ON "TrafficSource"("agencyId", "creatorId", "sourceType", "externalId");
CREATE INDEX "TrafficSource_agencyId_creatorId_sourceType_idx" ON "TrafficSource"("agencyId", "creatorId", "sourceType");
CREATE INDEX "TrafficSource_agencyId_creatorId_status_idx" ON "TrafficSource"("agencyId", "creatorId", "status");

CREATE UNIQUE INDEX "TrafficSourceMember_agencyId_creatorId_sourceId_fanId_key" ON "TrafficSourceMember"("agencyId", "creatorId", "sourceId", "fanId");
CREATE INDEX "TrafficSourceMember_agencyId_creatorId_fanId_idx" ON "TrafficSourceMember"("agencyId", "creatorId", "fanId");
CREATE INDEX "TrafficSourceMember_sourceId_fanId_idx" ON "TrafficSourceMember"("sourceId", "fanId");
CREATE INDEX "TrafficSourceMember_needsValueRefresh_lastValueFetchedAt_idx" ON "TrafficSourceMember"("needsValueRefresh", "lastValueFetchedAt");

CREATE UNIQUE INDEX "TrafficFanValueSnapshot_agencyId_creatorId_fanId_key" ON "TrafficFanValueSnapshot"("agencyId", "creatorId", "fanId");
CREATE INDEX "TrafficFanValueSnapshot_agencyId_creatorId_fetchedAt_idx" ON "TrafficFanValueSnapshot"("agencyId", "creatorId", "fetchedAt");

CREATE UNIQUE INDEX "CreatorSubscriptionLedger_agencyId_eventHash_key" ON "CreatorSubscriptionLedger"("agencyId", "eventHash");
CREATE INDEX "CreatorSubscriptionLedger_agencyId_creatorId_fanId_occurredAt_idx" ON "CreatorSubscriptionLedger"("agencyId", "creatorId", "fanId", "occurredAt");
CREATE INDEX "CreatorSubscriptionLedger_agencyId_creatorId_sourceId_occurredAt_idx" ON "CreatorSubscriptionLedger"("agencyId", "creatorId", "sourceId", "occurredAt");

CREATE UNIQUE INDEX "TrafficDailyAggregate_sourceId_day_key" ON "TrafficDailyAggregate"("sourceId", "day");
CREATE INDEX "TrafficDailyAggregate_agencyId_creatorId_day_idx" ON "TrafficDailyAggregate"("agencyId", "creatorId", "day");

ALTER TABLE "TrafficSource" ADD CONSTRAINT "TrafficSource_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrafficSource" ADD CONSTRAINT "TrafficSource_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrafficSourceMember" ADD CONSTRAINT "TrafficSourceMember_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrafficSourceMember" ADD CONSTRAINT "TrafficSourceMember_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrafficSourceMember" ADD CONSTRAINT "TrafficSourceMember_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TrafficSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrafficFanValueSnapshot" ADD CONSTRAINT "TrafficFanValueSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrafficFanValueSnapshot" ADD CONSTRAINT "TrafficFanValueSnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorSubscriptionLedger" ADD CONSTRAINT "CreatorSubscriptionLedger_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscriptionLedger" ADD CONSTRAINT "CreatorSubscriptionLedger_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscriptionLedger" ADD CONSTRAINT "CreatorSubscriptionLedger_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TrafficSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TrafficDailyAggregate" ADD CONSTRAINT "TrafficDailyAggregate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrafficDailyAggregate" ADD CONSTRAINT "TrafficDailyAggregate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrafficDailyAggregate" ADD CONSTRAINT "TrafficDailyAggregate_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TrafficSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
