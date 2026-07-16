CREATE TABLE "CreatorVaultInventorySnapshot" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NOT_SCANNED',
  "generation" INTEGER NOT NULL DEFAULT 0,
  "pendingGeneration" INTEGER,
  "jobId" TEXT,
  "mode" TEXT NOT NULL DEFAULT 'full',
  "pages" INTEGER NOT NULL DEFAULT 0,
  "scanned" INTEGER NOT NULL DEFAULT 0,
  "knownStreak" INTEGER NOT NULL DEFAULT 0,
  "creatorOwned" INTEGER NOT NULL DEFAULT 0,
  "foreignCount" INTEGER NOT NULL DEFAULT 0,
  "unknownCount" INTEGER NOT NULL DEFAULT 0,
  "eligibleCount" INTEGER NOT NULL DEFAULT 0,
  "stoppedReason" TEXT,
  "lastFullScanAt" TIMESTAMP(3),
  "lastIncrementalScanAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorVaultInventorySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorVaultMediaInventory" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "mediaId" TEXT NOT NULL,
  "ownership" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "sourceKind" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "chatEligibility" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "ownershipEvidence" TEXT,
  "mediaType" TEXT NOT NULL DEFAULT 'unknown',
  "preview" JSONB NOT NULL DEFAULT '{}',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorVaultMediaInventory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorVaultInventorySnapshot_agencyId_creatorId_key" ON "CreatorVaultInventorySnapshot"("agencyId", "creatorId");
CREATE INDEX "CreatorVaultInventorySnapshot_creatorId_status_idx" ON "CreatorVaultInventorySnapshot"("creatorId", "status");
CREATE INDEX "CreatorVaultInventorySnapshot_jobId_idx" ON "CreatorVaultInventorySnapshot"("jobId");
CREATE UNIQUE INDEX "CreatorVaultMediaInventory_agencyId_creatorId_generation_mediaId_key" ON "CreatorVaultMediaInventory"("agencyId", "creatorId", "generation", "mediaId");
CREATE INDEX "CreatorVaultMediaInventory_agencyId_creatorId_generation_ownership_chatEligibility_idx" ON "CreatorVaultMediaInventory"("agencyId", "creatorId", "generation", "ownership", "chatEligibility");
CREATE INDEX "CreatorVaultMediaInventory_creatorId_mediaId_idx" ON "CreatorVaultMediaInventory"("creatorId", "mediaId");
CREATE INDEX "CreatorVaultMediaInventory_lastSeenJobId_idx" ON "CreatorVaultMediaInventory"("lastSeenJobId");

ALTER TABLE "CreatorVaultInventorySnapshot" ADD CONSTRAINT "CreatorVaultInventorySnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorVaultInventorySnapshot" ADD CONSTRAINT "CreatorVaultInventorySnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorVaultMediaInventory" ADD CONSTRAINT "CreatorVaultMediaInventory_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorVaultMediaInventory" ADD CONSTRAINT "CreatorVaultMediaInventory_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
