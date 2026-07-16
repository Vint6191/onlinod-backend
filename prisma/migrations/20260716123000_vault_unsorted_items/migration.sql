CREATE TABLE "VaultUnsortedItem" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNSORTED',
    "mediaType" TEXT NOT NULL DEFAULT 'unknown',
    "thumbUrl" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "folderIds" JSONB NOT NULL DEFAULT '[]',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VaultUnsortedItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VaultUnsortedItem_agencyId_creatorId_mediaId_key"
ON "VaultUnsortedItem"("agencyId", "creatorId", "mediaId");

CREATE INDEX "VaultUnsortedItem_agencyId_creatorId_status_lastSeenAt_idx"
ON "VaultUnsortedItem"("agencyId", "creatorId", "status", "lastSeenAt");

CREATE INDEX "VaultUnsortedItem_creatorId_status_lastSeenAt_idx"
ON "VaultUnsortedItem"("creatorId", "status", "lastSeenAt");

CREATE INDEX "VaultUnsortedItem_lastSeenJobId_idx"
ON "VaultUnsortedItem"("lastSeenJobId");

ALTER TABLE "VaultUnsortedItem"
ADD CONSTRAINT "VaultUnsortedItem_agencyId_fkey"
FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VaultUnsortedItem"
ADD CONSTRAINT "VaultUnsortedItem_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
