-- Creator connect and encrypted snapshots

CREATE TYPE "ConnectSessionStatus" AS ENUM ('PENDING', 'CLAIMED', 'COMPLETED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "AccessSnapshotType" AS ENUM ('OF_ACCESS');

CREATE TABLE "CreatorConnectSession" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "claimedByUserId" TEXT,
    "claimedByDeviceId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" "ConnectSessionStatus" NOT NULL DEFAULT 'PENDING',
    "connectUrl" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "CreatorConnectSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccessSnapshot" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "deviceId" TEXT,
    "type" "AccessSnapshotType" NOT NULL DEFAULT 'OF_ACCESS',
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "encryptedPayload" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "userAgentHash" TEXT,
    "remoteId" TEXT,
    "username" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkerDevice" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceName" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorConnectSession_tokenHash_key" ON "CreatorConnectSession"("tokenHash");
CREATE INDEX "CreatorConnectSession_agencyId_idx" ON "CreatorConnectSession"("agencyId");
CREATE INDEX "CreatorConnectSession_creatorId_idx" ON "CreatorConnectSession"("creatorId");
CREATE INDEX "CreatorConnectSession_createdByUserId_idx" ON "CreatorConnectSession"("createdByUserId");
CREATE INDEX "CreatorConnectSession_status_idx" ON "CreatorConnectSession"("status");
CREATE INDEX "CreatorConnectSession_expiresAt_idx" ON "CreatorConnectSession"("expiresAt");

CREATE INDEX "AccessSnapshot_agencyId_idx" ON "AccessSnapshot"("agencyId");
CREATE INDEX "AccessSnapshot_creatorId_idx" ON "AccessSnapshot"("creatorId");
CREATE INDEX "AccessSnapshot_createdByUserId_idx" ON "AccessSnapshot"("createdByUserId");
CREATE INDEX "AccessSnapshot_active_idx" ON "AccessSnapshot"("active");
CREATE INDEX "AccessSnapshot_createdAt_idx" ON "AccessSnapshot"("createdAt");

CREATE INDEX "WorkerDevice_agencyId_idx" ON "WorkerDevice"("agencyId");
CREATE INDEX "WorkerDevice_userId_idx" ON "WorkerDevice"("userId");
CREATE INDEX "WorkerDevice_lastSeenAt_idx" ON "WorkerDevice"("lastSeenAt");

CREATE INDEX "AuditLog_agencyId_idx" ON "AuditLog"("agencyId");
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

ALTER TABLE "CreatorConnectSession" ADD CONSTRAINT "CreatorConnectSession_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorConnectSession" ADD CONSTRAINT "CreatorConnectSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorConnectSession" ADD CONSTRAINT "CreatorConnectSession_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorConnectSession" ADD CONSTRAINT "CreatorConnectSession_claimedByUserId_fkey" FOREIGN KEY ("claimedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AccessSnapshot" ADD CONSTRAINT "AccessSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessSnapshot" ADD CONSTRAINT "AccessSnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessSnapshot" ADD CONSTRAINT "AccessSnapshot_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkerDevice" ADD CONSTRAINT "WorkerDevice_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerDevice" ADD CONSTRAINT "WorkerDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
