CREATE TABLE "AutomationContentCandidate" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "ownerFanId" TEXT NOT NULL,
  "contentId" TEXT NOT NULL,
  "contentType" TEXT NOT NULL DEFAULT 'post',
  "username" TEXT,
  "displayName" TEXT,
  "avatarUrl" TEXT,
  "source" TEXT NOT NULL DEFAULT 'subscriber_directory',
  "publishedAt" TIMESTAMP(3),
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "canToggleFavorite" BOOLEAN,
  "canViewMedia" BOOLEAN,
  "isFavorite" BOOLEAN,
  "state" TEXT NOT NULL DEFAULT 'DISCOVERED',
  "eligibilityReason" TEXT,
  "skipReason" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "cooldownUntil" TIMESTAMP(3),
  "snapshotRunId" TEXT,
  "latestDeliveryId" TEXT,
  "latestActionType" TEXT,
  "latestStatus" TEXT,
  "latestError" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationContentCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AutomationContentCandidate_creatorId_contentType_contentId_key" ON "AutomationContentCandidate"("creatorId", "contentType", "contentId");
CREATE INDEX "AutomationContentCandidate_agencyId_creatorId_state_idx" ON "AutomationContentCandidate"("agencyId", "creatorId", "state");
CREATE INDEX "AutomationContentCandidate_creatorId_ownerFanId_idx" ON "AutomationContentCandidate"("creatorId", "ownerFanId");
CREATE INDEX "AutomationContentCandidate_creatorId_publishedAt_idx" ON "AutomationContentCandidate"("creatorId", "publishedAt");
CREATE INDEX "AutomationContentCandidate_creatorId_cooldownUntil_idx" ON "AutomationContentCandidate"("creatorId", "cooldownUntil");
CREATE INDEX "AutomationContentCandidate_snapshotRunId_idx" ON "AutomationContentCandidate"("snapshotRunId");
ALTER TABLE "AutomationContentCandidate" ADD CONSTRAINT "AutomationContentCandidate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationContentCandidate" ADD CONSTRAINT "AutomationContentCandidate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AutomationContentDiscoveryState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "ownerFanId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL DEFAULT 'fan_posts',
  "snapshotRunId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
  "contentCount" INTEGER NOT NULL DEFAULT 0,
  "sourceErrors" JSONB NOT NULL DEFAULT '[]',
  "lastScannedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationContentDiscoveryState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AutomationContentDiscoveryState_creatorId_ownerFanId_sourceKey_key" ON "AutomationContentDiscoveryState"("creatorId", "ownerFanId", "sourceKey");
CREATE INDEX "AutomationContentDiscoveryState_agencyId_creatorId_status_idx" ON "AutomationContentDiscoveryState"("agencyId", "creatorId", "status");
CREATE INDEX "AutomationContentDiscoveryState_creatorId_snapshotRunId_idx" ON "AutomationContentDiscoveryState"("creatorId", "snapshotRunId");
CREATE INDEX "AutomationContentDiscoveryState_creatorId_lastSuccessAt_idx" ON "AutomationContentDiscoveryState"("creatorId", "lastSuccessAt");
CREATE INDEX "AutomationContentDiscoveryState_creatorId_lastScannedAt_idx" ON "AutomationContentDiscoveryState"("creatorId", "lastScannedAt");
ALTER TABLE "AutomationContentDiscoveryState" ADD CONSTRAINT "AutomationContentDiscoveryState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationContentDiscoveryState" ADD CONSTRAINT "AutomationContentDiscoveryState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
