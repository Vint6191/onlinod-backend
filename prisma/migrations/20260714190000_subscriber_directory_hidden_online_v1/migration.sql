CREATE TABLE "SubscriberScanRun" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "jobId" TEXT,
  "mode" TEXT NOT NULL DEFAULT 'full',
  "sourceType" TEXT NOT NULL DEFAULT 'all',
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "pageLimit" INTEGER NOT NULL DEFAULT 100,
  "nextOffset" INTEGER NOT NULL DEFAULT 0,
  "scannedCount" INTEGER NOT NULL DEFAULT 0,
  "pageCount" INTEGER NOT NULL DEFAULT 0,
  "hiddenCount" INTEGER NOT NULL DEFAULT 0,
  "hasMore" BOOLEAN,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "summary" JSONB NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriberScanRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriberScanPage" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "offset" INTEGER NOT NULL,
  "nextOffset" INTEGER NOT NULL,
  "itemCount" INTEGER NOT NULL DEFAULT 0,
  "hiddenCount" INTEGER NOT NULL DEFAULT 0,
  "hasMore" BOOLEAN NOT NULL,
  "contentHash" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriberScanPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriberScanItem" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "dialogId" TEXT,
  "username" TEXT,
  "name" TEXT,
  "avatarUrl" TEXT,
  "totalSpentCents" INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt" TIMESTAMP(3),
  "lastSeenIsNull" BOOLEAN NOT NULL DEFAULT false,
  "canReceiveChatMessage" BOOLEAN,
  "isActive" BOOLEAN,
  "subscribedOn" BOOLEAN,
  "subscribedBy" BOOLEAN,
  "subscriptionType" TEXT,
  "contentHash" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriberScanItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriberDirectoryState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "currentRunId" TEXT,
  "previousRunId" TEXT,
  "lastJobId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'EMPTY',
  "scanEveryDays" INTEGER NOT NULL DEFAULT 7,
  "nextScanAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "totalCount" INTEGER NOT NULL DEFAULT 0,
  "hiddenCount" INTEGER NOT NULL DEFAULT 0,
  "addedCount" INTEGER NOT NULL DEFAULT 0,
  "changedCount" INTEGER NOT NULL DEFAULT 0,
  "disappearedCount" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB NOT NULL DEFAULT '{}',
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriberDirectoryState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriberScanRun_jobId_key" ON "SubscriberScanRun"("jobId");
CREATE INDEX "SubscriberScanRun_agencyId_creatorId_status_idx" ON "SubscriberScanRun"("agencyId", "creatorId", "status");
CREATE INDEX "SubscriberScanRun_creatorId_createdAt_idx" ON "SubscriberScanRun"("creatorId", "createdAt");
CREATE INDEX "SubscriberScanRun_status_updatedAt_idx" ON "SubscriberScanRun"("status", "updatedAt");
CREATE UNIQUE INDEX "SubscriberScanPage_runId_offset_key" ON "SubscriberScanPage"("runId", "offset");
CREATE INDEX "SubscriberScanPage_runId_receivedAt_idx" ON "SubscriberScanPage"("runId", "receivedAt");
CREATE UNIQUE INDEX "SubscriberScanItem_runId_fanId_key" ON "SubscriberScanItem"("runId", "fanId");
CREATE INDEX "SubscriberScanItem_runId_lastSeenIsNull_idx" ON "SubscriberScanItem"("runId", "lastSeenIsNull");
CREATE INDEX "SubscriberScanItem_creatorId_fanId_idx" ON "SubscriberScanItem"("creatorId", "fanId");
CREATE INDEX "SubscriberScanItem_agencyId_creatorId_idx" ON "SubscriberScanItem"("agencyId", "creatorId");
CREATE UNIQUE INDEX "SubscriberDirectoryState_creatorId_key" ON "SubscriberDirectoryState"("creatorId");
CREATE INDEX "SubscriberDirectoryState_agencyId_status_idx" ON "SubscriberDirectoryState"("agencyId", "status");
CREATE INDEX "SubscriberDirectoryState_nextScanAt_idx" ON "SubscriberDirectoryState"("nextScanAt");

ALTER TABLE "SubscriberScanRun" ADD CONSTRAINT "SubscriberScanRun_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriberScanRun" ADD CONSTRAINT "SubscriberScanRun_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriberScanPage" ADD CONSTRAINT "SubscriberScanPage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SubscriberScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriberScanItem" ADD CONSTRAINT "SubscriberScanItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SubscriberScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriberDirectoryState" ADD CONSTRAINT "SubscriberDirectoryState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriberDirectoryState" ADD CONSTRAINT "SubscriberDirectoryState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one active scan per creator, including across multiple backend processes.
CREATE UNIQUE INDEX "SubscriberScanRun_one_active_creator_key"
  ON "SubscriberScanRun"("creatorId")
  WHERE "status" IN ('QUEUED', 'RUNNING');

-- Retire the pre-P9 parallel Hidden Online scan queue. Candidate/bump rows stay.
UPDATE "AutomationDelivery"
SET "status" = 'canceled',
    "claimedByDeviceId" = NULL,
    "claimedAt" = NULL,
    "claimUntil" = NULL,
    "error" = 'migrated to SubscriberDirectory subscriber_directory_scan',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "trigger" = 'hidden_online_scan'
  AND "status" IN ('hidden_scan_queued', 'hidden_scan_claimed', 'hidden_scan_paused');
