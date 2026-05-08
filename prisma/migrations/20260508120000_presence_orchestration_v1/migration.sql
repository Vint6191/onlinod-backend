-- Presence orchestration v1
-- Centralized online users snapshots + per-fan live presence state.

CREATE TABLE "CreatorPresenceSnapshot" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'FRESH',
  "onlineCount" INTEGER NOT NULL DEFAULT 0,
  "staleCount" INTEGER NOT NULL DEFAULT 0,
  "offlineCount" INTEGER NOT NULL DEFAULT 0,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'backend',
  "updatedByDeviceId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorPresenceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorPresenceUser" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "username" TEXT,
  "name" TEXT,
  "avatarUrl" TEXT,
  "totalSpentCents" INTEGER NOT NULL DEFAULT 0,
  "subscribeAt" TIMESTAMP(3),
  "duration" TEXT,
  "status" TEXT NOT NULL DEFAULT 'online',
  "source" TEXT NOT NULL DEFAULT 'api_snapshot',
  "lastOnlineAt" TIMESTAMP(3),
  "lastOfflineAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "lastSnapshotAt" TIMESTAMP(3),
  "updatedByDeviceId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorPresenceUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorPresenceSnapshot_creatorId_key" ON "CreatorPresenceSnapshot"("creatorId");
CREATE UNIQUE INDEX "CreatorPresenceSnapshot_agencyId_creatorId_key" ON "CreatorPresenceSnapshot"("agencyId", "creatorId");
CREATE INDEX "CreatorPresenceSnapshot_agencyId_idx" ON "CreatorPresenceSnapshot"("agencyId");
CREATE INDEX "CreatorPresenceSnapshot_capturedAt_idx" ON "CreatorPresenceSnapshot"("capturedAt");
CREATE INDEX "CreatorPresenceSnapshot_expiresAt_idx" ON "CreatorPresenceSnapshot"("expiresAt");
CREATE INDEX "CreatorPresenceSnapshot_updatedByDeviceId_idx" ON "CreatorPresenceSnapshot"("updatedByDeviceId");

CREATE UNIQUE INDEX "CreatorPresenceUser_creatorId_fanId_key" ON "CreatorPresenceUser"("creatorId", "fanId");
CREATE INDEX "CreatorPresenceUser_agencyId_idx" ON "CreatorPresenceUser"("agencyId");
CREATE INDEX "CreatorPresenceUser_creatorId_status_idx" ON "CreatorPresenceUser"("creatorId", "status");
CREATE INDEX "CreatorPresenceUser_fanId_idx" ON "CreatorPresenceUser"("fanId");
CREATE INDEX "CreatorPresenceUser_lastOnlineAt_idx" ON "CreatorPresenceUser"("lastOnlineAt");
CREATE INDEX "CreatorPresenceUser_lastCheckedAt_idx" ON "CreatorPresenceUser"("lastCheckedAt");
CREATE INDEX "CreatorPresenceUser_updatedByDeviceId_idx" ON "CreatorPresenceUser"("updatedByDeviceId");

ALTER TABLE "CreatorPresenceSnapshot" ADD CONSTRAINT "CreatorPresenceSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorPresenceSnapshot" ADD CONSTRAINT "CreatorPresenceSnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorPresenceSnapshot" ADD CONSTRAINT "CreatorPresenceSnapshot_updatedByDeviceId_fkey" FOREIGN KEY ("updatedByDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorPresenceUser" ADD CONSTRAINT "CreatorPresenceUser_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorPresenceUser" ADD CONSTRAINT "CreatorPresenceUser_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorPresenceUser" ADD CONSTRAINT "CreatorPresenceUser_updatedByDeviceId_fkey" FOREIGN KEY ("updatedByDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
