-- V20.11 Session Broker foundation. Existing creators remain LOCAL_PERSISTENT;
-- this migration does not switch any Chromium/session runtime behavior.
CREATE TYPE "CreatorSessionMode" AS ENUM ('LOCAL_PERSISTENT', 'MANAGED_BROKER');
CREATE TYPE "CreatorSessionStateStatus" AS ENUM ('ACTIVE', 'REVOKED');

ALTER TABLE "CreatorAccount"
ADD COLUMN "sessionMode" "CreatorSessionMode" NOT NULL DEFAULT 'LOCAL_PERSISTENT';

CREATE TABLE "CreatorSessionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" "CreatorSessionStateStatus" NOT NULL DEFAULT 'ACTIVE',
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "encryptedPayload" TEXT,
    "iv" TEXT,
    "tag" TEXT,
    "algorithm" TEXT,
    "platformUserId" TEXT,
    "credentialHash" TEXT,
    "coherenceHash" TEXT,
    "capturedAt" TIMESTAMP(3),
    "capturedByUserId" TEXT,
    "capturedByDeviceId" TEXT,
    "sourceRequestId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorSessionState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorSessionState_creatorId_key" ON "CreatorSessionState"("creatorId");
CREATE INDEX "CreatorSessionState_agencyId_idx" ON "CreatorSessionState"("agencyId");
CREATE INDEX "CreatorSessionState_status_idx" ON "CreatorSessionState"("status");
CREATE INDEX "CreatorSessionState_capturedByUserId_idx" ON "CreatorSessionState"("capturedByUserId");
CREATE INDEX "CreatorSessionState_capturedByDeviceId_idx" ON "CreatorSessionState"("capturedByDeviceId");
CREATE INDEX "CreatorSessionState_updatedAt_idx" ON "CreatorSessionState"("updatedAt");

ALTER TABLE "CreatorSessionState"
ADD CONSTRAINT "CreatorSessionState_agencyId_fkey"
FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorSessionState"
ADD CONSTRAINT "CreatorSessionState_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorSessionState"
ADD CONSTRAINT "CreatorSessionState_capturedByUserId_fkey"
FOREIGN KEY ("capturedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorSessionState"
ADD CONSTRAINT "CreatorSessionState_capturedByDeviceId_fkey"
FOREIGN KEY ("capturedByDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
