-- V20.19 Phase 8: client-side E2E key hierarchy.
-- Backend stores public keys and opaque wrapped keys only; plaintext master/creator keys never enter Postgres.

CREATE TYPE "CryptoIdentityStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');
CREATE TYPE "CryptoRootStatus" AS ENUM ('ACTIVE', 'RECOVERY_ONLY', 'DISABLED');

CREATE TABLE "DeviceCryptoIdentity" (
  "deviceId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL DEFAULT 'x25519-spki-der-v1',
  "fingerprint" TEXT NOT NULL,
  "status" "CryptoIdentityStatus" NOT NULL DEFAULT 'PENDING',
  "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceCryptoIdentity_pkey" PRIMARY KEY ("deviceId")
);

CREATE TABLE "AgencyCryptoRoot" (
  "agencyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "CryptoRootStatus" NOT NULL DEFAULT 'ACTIVE',
  "recoveryCiphertext" TEXT NOT NULL,
  "recoveryIv" TEXT NOT NULL,
  "recoveryTag" TEXT NOT NULL,
  "recoveryAlgorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm-recovery-v1',
  "recoveryFormatVersion" INTEGER NOT NULL DEFAULT 1,
  "initializedByDeviceId" TEXT,
  "initializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgencyCryptoRoot_pkey" PRIMARY KEY ("agencyId")
);

CREATE TABLE "AgencyCryptoOwnerKeyWrap" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "rootVersion" INTEGER NOT NULL,
  "deviceId" TEXT NOT NULL,
  "ephemeralPublicKey" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL DEFAULT 'x25519-hkdf-sha256-aes-256-gcm-v1',
  "createdByDeviceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AgencyCryptoOwnerKeyWrap_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorCryptoKeyState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "activeVersion" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorCryptoKeyState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorDeviceKeyWrap" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "deviceId" TEXT NOT NULL,
  "ephemeralPublicKey" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL DEFAULT 'x25519-hkdf-sha256-aes-256-gcm-v1',
  "createdByDeviceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "CreatorDeviceKeyWrap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceCryptoIdentity_agencyId_fingerprint_key" ON "DeviceCryptoIdentity"("agencyId", "fingerprint");
CREATE INDEX "DeviceCryptoIdentity_agencyId_status_idx" ON "DeviceCryptoIdentity"("agencyId", "status");
CREATE INDEX "AgencyCryptoRoot_status_updatedAt_idx" ON "AgencyCryptoRoot"("status", "updatedAt");
CREATE UNIQUE INDEX "AgencyCryptoOwnerKeyWrap_agencyId_rootVersion_deviceId_key" ON "AgencyCryptoOwnerKeyWrap"("agencyId", "rootVersion", "deviceId");
CREATE INDEX "AgencyCryptoOwnerKeyWrap_deviceId_revokedAt_idx" ON "AgencyCryptoOwnerKeyWrap"("deviceId", "revokedAt");
CREATE UNIQUE INDEX "CreatorCryptoKeyState_creatorId_key" ON "CreatorCryptoKeyState"("creatorId");
CREATE UNIQUE INDEX "CreatorCryptoKeyState_agencyId_creatorId_key" ON "CreatorCryptoKeyState"("agencyId", "creatorId");
CREATE INDEX "CreatorCryptoKeyState_agencyId_updatedAt_idx" ON "CreatorCryptoKeyState"("agencyId", "updatedAt");
CREATE UNIQUE INDEX "CreatorDeviceKeyWrap_agencyId_creatorId_keyVersion_deviceId_key" ON "CreatorDeviceKeyWrap"("agencyId", "creatorId", "keyVersion", "deviceId");
CREATE INDEX "CreatorDeviceKeyWrap_deviceId_revokedAt_idx" ON "CreatorDeviceKeyWrap"("deviceId", "revokedAt");
CREATE INDEX "CreatorDeviceKeyWrap_agencyId_creatorId_keyVersion_idx" ON "CreatorDeviceKeyWrap"("agencyId", "creatorId", "keyVersion");

ALTER TABLE "DeviceCryptoIdentity" ADD CONSTRAINT "DeviceCryptoIdentity_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceCryptoIdentity" ADD CONSTRAINT "DeviceCryptoIdentity_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgencyCryptoRoot" ADD CONSTRAINT "AgencyCryptoRoot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgencyCryptoRoot" ADD CONSTRAINT "AgencyCryptoRoot_initializedByDeviceId_fkey" FOREIGN KEY ("initializedByDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgencyCryptoOwnerKeyWrap" ADD CONSTRAINT "AgencyCryptoOwnerKeyWrap_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgencyCryptoOwnerKeyWrap" ADD CONSTRAINT "AgencyCryptoOwnerKeyWrap_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgencyCryptoOwnerKeyWrap" ADD CONSTRAINT "AgencyCryptoOwnerKeyWrap_createdByDeviceId_fkey" FOREIGN KEY ("createdByDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorCryptoKeyState" ADD CONSTRAINT "CreatorCryptoKeyState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorCryptoKeyState" ADD CONSTRAINT "CreatorCryptoKeyState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_createdByDeviceId_fkey" FOREIGN KEY ("createdByDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorCryptoKeyState"("agencyId", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
