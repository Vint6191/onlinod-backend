-- P17 Unified Dialog Intelligence Core

CREATE TABLE "DialogScanState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "fanId" TEXT,
  "initialScanComplete" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'IDLE',
  "generation" INTEGER NOT NULL DEFAULT 0,
  "scanMode" TEXT NOT NULL DEFAULT 'initial',
  "newestMessageId" TEXT,
  "newestMessageAt" TIMESTAMP(3),
  "oldestMessageId" TEXT,
  "oldestMessageAt" TIMESTAMP(3),
  "forwardCursor" TEXT,
  "backwardCursor" TEXT,
  "lastFullScanAt" TIMESTAMP(3),
  "lastIncrementalScanAt" TIMESTAMP(3),
  "lastWsEventAt" TIMESTAMP(3),
  "lastCatchupAt" TIMESTAMP(3),
  "lastError" TEXT,
  "activeRunId" TEXT,
  "activeJobId" TEXT,
  "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
  "messagesProcessed" INTEGER NOT NULL DEFAULT 0,
  "mediaProcessed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DialogScanState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DialogScanRun" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "fanId" TEXT,
  "jobId" TEXT,
  "mode" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "generation" INTEGER NOT NULL DEFAULT 0,
  "continuation" JSONB,
  "progress" JSONB,
  "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
  "messagesProcessed" INTEGER NOT NULL DEFAULT 0,
  "mediaProcessed" INTEGER NOT NULL DEFAULT 0,
  "purchaseSignals" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "pausedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdByDeviceId" TEXT,
  "lastWorkerDeviceId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DialogScanRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DialogScanChunkCommit" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "chunkKey" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "cursorIn" TEXT,
  "cursorOut" TEXT,
  "page" INTEGER NOT NULL DEFAULT 0,
  "messageCount" INTEGER NOT NULL DEFAULT 0,
  "mediaCount" INTEGER NOT NULL DEFAULT 0,
  "hasMore" BOOLEAN NOT NULL DEFAULT false,
  "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "result" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "DialogScanChunkCommit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DialogMessageLedger" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "fanId" TEXT,
  "senderId" TEXT,
  "recipientId" TEXT,
  "direction" TEXT NOT NULL,
  "messageType" TEXT NOT NULL DEFAULT 'message',
  "text" TEXT,
  "priceCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "isFree" BOOLEAN NOT NULL DEFAULT false,
  "isOpened" BOOLEAN NOT NULL DEFAULT false,
  "isFromCreator" BOOLEAN NOT NULL DEFAULT false,
  "isFromFan" BOOLEAN NOT NULL DEFAULT false,
  "createdAtOf" TIMESTAMP(3) NOT NULL,
  "changedAtOf" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "source" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contentHash" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DialogMessageLedger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DialogMessageMedia" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "messageLedgerId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "assetId" TEXT,
  "mediaType" TEXT,
  "ownerId" TEXT,
  "ownership" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "isFanMedia" BOOLEAN NOT NULL DEFAULT false,
  "preview" JSONB NOT NULL DEFAULT '{}',
  "durationMs" INTEGER,
  "canView" BOOLEAN,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DialogMessageMedia_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DialogPurchaseSignal" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "sourceEventId" TEXT,
  "sourceMessageId" TEXT,
  "dialogId" TEXT,
  "buyerId" TEXT,
  "buyerUsername" TEXT,
  "buyerDisplayName" TEXT,
  "buyerDeleted" BOOLEAN NOT NULL DEFAULT false,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "source" TEXT NOT NULL DEFAULT 'notification',
  "resolveState" TEXT NOT NULL DEFAULT 'PENDING',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DialogPurchaseSignal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VaultPurchaseLedger" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "messageLedgerId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "sourceEventId" TEXT,
  "sourceMessageId" TEXT,
  "dialogId" TEXT,
  "buyerId" TEXT,
  "buyerUsername" TEXT,
  "buyerDisplayName" TEXT,
  "purchasedAt" TIMESTAMP(3) NOT NULL,
  "priceCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "isOpened" BOOLEAN NOT NULL DEFAULT false,
  "isFree" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL,
  "resolveState" TEXT NOT NULL,
  "buyerDeleted" BOOLEAN NOT NULL DEFAULT false,
  "sourceDeleted" BOOLEAN NOT NULL DEFAULT false,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VaultPurchaseLedger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VaultPurchaseMedia" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "assetId" TEXT,
  "mediaType" TEXT,
  "isFanMedia" BOOLEAN NOT NULL DEFAULT false,
  "resolutionStatus" TEXT NOT NULL DEFAULT 'RESOLVED',
  "allocatedCents" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VaultPurchaseMedia_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VaultAssetSalesAggregate" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "mediaId" TEXT,
  "mediaType" TEXT,
  "preview" JSONB NOT NULL DEFAULT '{}',
  "soldCount" INTEGER NOT NULL DEFAULT 0,
  "totalRevenueCents" INTEGER NOT NULL DEFAULT 0,
  "uniqueBuyers" INTEGER NOT NULL DEFAULT 0,
  "averagePriceCents" INTEGER NOT NULL DEFAULT 0,
  "openedCount" INTEGER NOT NULL DEFAULT 0,
  "notOpenedCount" INTEGER NOT NULL DEFAULT 0,
  "freeCount" INTEGER NOT NULL DEFAULT 0,
  "lastSoldAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VaultAssetSalesAggregate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DialogScanState_creatorId_dialogId_key" ON "DialogScanState"("creatorId", "dialogId");
CREATE INDEX "DialogScanState_agencyId_status_idx" ON "DialogScanState"("agencyId", "status");
CREATE INDEX "DialogScanState_creatorId_status_idx" ON "DialogScanState"("creatorId", "status");
CREATE INDEX "DialogScanState_activeRunId_idx" ON "DialogScanState"("activeRunId");
CREATE INDEX "DialogScanState_activeJobId_idx" ON "DialogScanState"("activeJobId");

CREATE UNIQUE INDEX "DialogScanRun_jobId_key" ON "DialogScanRun"("jobId");
CREATE INDEX "DialogScanRun_agencyId_status_idx" ON "DialogScanRun"("agencyId", "status");
CREATE INDEX "DialogScanRun_creatorId_dialogId_status_idx" ON "DialogScanRun"("creatorId", "dialogId", "status");
CREATE INDEX "DialogScanRun_jobId_idx" ON "DialogScanRun"("jobId");
CREATE INDEX "DialogScanRun_createdAt_idx" ON "DialogScanRun"("createdAt");
CREATE UNIQUE INDEX "DialogScanRun_one_active_per_dialog_idx" ON "DialogScanRun"("creatorId", "dialogId") WHERE "status" IN ('QUEUED', 'RUNNING', 'PAUSED');

CREATE UNIQUE INDEX "DialogScanChunkCommit_runId_chunkKey_key" ON "DialogScanChunkCommit"("runId", "chunkKey");
CREATE INDEX "DialogScanChunkCommit_jobId_idx" ON "DialogScanChunkCommit"("jobId");
CREATE INDEX "DialogScanChunkCommit_creatorId_dialogId_committedAt_idx" ON "DialogScanChunkCommit"("creatorId", "dialogId", "committedAt");

CREATE UNIQUE INDEX "DialogMessageLedger_creatorId_messageId_key" ON "DialogMessageLedger"("creatorId", "messageId");
CREATE INDEX "DialogMessageLedger_agencyId_dialogId_createdAtOf_idx" ON "DialogMessageLedger"("agencyId", "dialogId", "createdAtOf");
CREATE INDEX "DialogMessageLedger_creatorId_dialogId_createdAtOf_idx" ON "DialogMessageLedger"("creatorId", "dialogId", "createdAtOf");
CREATE INDEX "DialogMessageLedger_creatorId_fanId_createdAtOf_idx" ON "DialogMessageLedger"("creatorId", "fanId", "createdAtOf");
CREATE INDEX "DialogMessageLedger_creatorId_isOpened_changedAtOf_idx" ON "DialogMessageLedger"("creatorId", "isOpened", "changedAtOf");
CREATE INDEX "DialogMessageLedger_deletedAt_idx" ON "DialogMessageLedger"("deletedAt");

CREATE UNIQUE INDEX "DialogMessageMedia_messageLedgerId_mediaId_key" ON "DialogMessageMedia"("messageLedgerId", "mediaId");
CREATE UNIQUE INDEX "DialogMessageMedia_creatorId_messageId_mediaId_key" ON "DialogMessageMedia"("creatorId", "messageId", "mediaId");
CREATE INDEX "DialogMessageMedia_creatorId_assetId_idx" ON "DialogMessageMedia"("creatorId", "assetId");
CREATE INDEX "DialogMessageMedia_creatorId_isFanMedia_idx" ON "DialogMessageMedia"("creatorId", "isFanMedia");

CREATE UNIQUE INDEX "DialogPurchaseSignal_idempotencyKey_key" ON "DialogPurchaseSignal"("idempotencyKey");
CREATE UNIQUE INDEX "DialogPurchaseSignal_creatorId_sourceEventId_key" ON "DialogPurchaseSignal"("creatorId", "sourceEventId");
CREATE INDEX "DialogPurchaseSignal_creatorId_sourceMessageId_idx" ON "DialogPurchaseSignal"("creatorId", "sourceMessageId");
CREATE INDEX "DialogPurchaseSignal_creatorId_dialogId_occurredAt_idx" ON "DialogPurchaseSignal"("creatorId", "dialogId", "occurredAt");
CREATE INDEX "DialogPurchaseSignal_resolveState_lastSeenAt_idx" ON "DialogPurchaseSignal"("resolveState", "lastSeenAt");

CREATE UNIQUE INDEX "VaultPurchaseLedger_idempotencyKey_key" ON "VaultPurchaseLedger"("idempotencyKey");
CREATE UNIQUE INDEX "VaultPurchaseLedger_creatorId_sourceEventId_key" ON "VaultPurchaseLedger"("creatorId", "sourceEventId");
CREATE INDEX "VaultPurchaseLedger_agencyId_creatorId_purchasedAt_idx" ON "VaultPurchaseLedger"("agencyId", "creatorId", "purchasedAt");
CREATE INDEX "VaultPurchaseLedger_creatorId_status_purchasedAt_idx" ON "VaultPurchaseLedger"("creatorId", "status", "purchasedAt");
CREATE INDEX "VaultPurchaseLedger_creatorId_sourceMessageId_idx" ON "VaultPurchaseLedger"("creatorId", "sourceMessageId");
CREATE INDEX "VaultPurchaseLedger_creatorId_buyerId_idx" ON "VaultPurchaseLedger"("creatorId", "buyerId");

CREATE UNIQUE INDEX "VaultPurchaseMedia_purchaseId_mediaId_key" ON "VaultPurchaseMedia"("purchaseId", "mediaId");
CREATE INDEX "VaultPurchaseMedia_creatorId_assetId_idx" ON "VaultPurchaseMedia"("creatorId", "assetId");
CREATE INDEX "VaultPurchaseMedia_creatorId_resolutionStatus_idx" ON "VaultPurchaseMedia"("creatorId", "resolutionStatus");

CREATE UNIQUE INDEX "VaultAssetSalesAggregate_creatorId_assetId_key" ON "VaultAssetSalesAggregate"("creatorId", "assetId");
CREATE INDEX "VaultAssetSalesAggregate_agencyId_creatorId_totalRevenueCents_idx" ON "VaultAssetSalesAggregate"("agencyId", "creatorId", "totalRevenueCents");
CREATE INDEX "VaultAssetSalesAggregate_creatorId_lastSoldAt_idx" ON "VaultAssetSalesAggregate"("creatorId", "lastSoldAt");

ALTER TABLE "DialogScanState" ADD CONSTRAINT "DialogScanState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogScanState" ADD CONSTRAINT "DialogScanState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogScanRun" ADD CONSTRAINT "DialogScanRun_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogScanRun" ADD CONSTRAINT "DialogScanRun_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogScanChunkCommit" ADD CONSTRAINT "DialogScanChunkCommit_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogScanChunkCommit" ADD CONSTRAINT "DialogScanChunkCommit_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogScanChunkCommit" ADD CONSTRAINT "DialogScanChunkCommit_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DialogScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogMessageLedger" ADD CONSTRAINT "DialogMessageLedger_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogMessageLedger" ADD CONSTRAINT "DialogMessageLedger_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogMessageMedia" ADD CONSTRAINT "DialogMessageMedia_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogMessageMedia" ADD CONSTRAINT "DialogMessageMedia_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogMessageMedia" ADD CONSTRAINT "DialogMessageMedia_messageLedgerId_fkey" FOREIGN KEY ("messageLedgerId") REFERENCES "DialogMessageLedger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogPurchaseSignal" ADD CONSTRAINT "DialogPurchaseSignal_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogPurchaseSignal" ADD CONSTRAINT "DialogPurchaseSignal_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultPurchaseLedger" ADD CONSTRAINT "VaultPurchaseLedger_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultPurchaseLedger" ADD CONSTRAINT "VaultPurchaseLedger_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultPurchaseLedger" ADD CONSTRAINT "VaultPurchaseLedger_messageLedgerId_fkey" FOREIGN KEY ("messageLedgerId") REFERENCES "DialogMessageLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VaultPurchaseMedia" ADD CONSTRAINT "VaultPurchaseMedia_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultPurchaseMedia" ADD CONSTRAINT "VaultPurchaseMedia_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultPurchaseMedia" ADD CONSTRAINT "VaultPurchaseMedia_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "VaultPurchaseLedger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultAssetSalesAggregate" ADD CONSTRAINT "VaultAssetSalesAggregate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultAssetSalesAggregate" ADD CONSTRAINT "VaultAssetSalesAggregate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
