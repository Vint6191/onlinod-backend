-- Immutable small public avatars: bytes and canonical pointer commit on the same database.
CREATE TABLE "AvatarAsset" ("id" TEXT PRIMARY KEY, "mimeType" TEXT NOT NULL, "bytes" BYTEA NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AvatarAsset_size" CHECK (octet_length("bytes") BETWEEN 1 AND 3145728),
 CONSTRAINT "AvatarAsset_mime" CHECK ("mimeType" IN ('image/jpeg','image/png','image/webp')));
ALTER TABLE "User" ADD COLUMN "avatarRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CreatorAccount" ADD COLUMN "avatarRevision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "AuthMailOutbox" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "authTokenId" TEXT NOT NULL UNIQUE REFERENCES "AuthToken"("id") ON DELETE CASCADE,
 "kind" TEXT NOT NULL, "payload" JSONB, "fingerprint" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "attempt" INTEGER NOT NULL DEFAULT 0,
 "leaseId" TEXT, "leaseUntil" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMP(3) NOT NULL, "providerId" TEXT, "lastCode" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AuthMailOutbox_status" CHECK ("status" IN ('PENDING','COMMITTING','UNKNOWN','SENT','FAILED','EXPIRED')));
CREATE INDEX "AuthMailOutbox_due_idx" ON "AuthMailOutbox"("status","nextAttemptAt");
CREATE INDEX "AuthMailOutbox_user_idx" ON "AuthMailOutbox"("userId","kind","createdAt");
CREATE INDEX "AuthToken_verification_code_idx" ON "AuthToken"("userId","type","codeHash","createdAt");

ALTER TABLE "CreatorAccount" ADD COLUMN "customsVaultRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TrafficSource" ADD COLUMN "costRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "OperationalControlState" (
 "id" TEXT NOT NULL PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
 "family" TEXT NOT NULL, "lastOperation" TEXT, "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "OperationalControlState_agencyId_creatorId_family_key" UNIQUE ("agencyId", "creatorId", "family")
);
CREATE INDEX "OperationalControlState_agencyId_creatorId_idx" ON "OperationalControlState"("agencyId", "creatorId");

CREATE TABLE "DialogControlResumeDemand" (
 "id" TEXT NOT NULL PRIMARY KEY,"agencyId" TEXT NOT NULL,"creatorId" TEXT NOT NULL,
 "moduleUpdatedAt" TIMESTAMP(3) NOT NULL,"creatorControlRevision" INTEGER NOT NULL DEFAULT 0,"status" TEXT NOT NULL DEFAULT 'PENDING',
 "attempts" INTEGER NOT NULL DEFAULT 0,"nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DialogControlResumeDemand_status_nextAttemptAt_id_idx" ON "DialogControlResumeDemand"("status","nextAttemptAt","id");
CREATE INDEX "DialogControlResumeDemand_agencyId_creatorId_idx" ON "DialogControlResumeDemand"("agencyId","creatorId");
