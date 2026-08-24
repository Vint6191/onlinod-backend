-- V20.19 Phase 8: recovery bridge from the new AMK to the immediately previous AMK.
-- The direction is deliberate: possession of an old compromised AMK can never recover a newer AMK.
CREATE TABLE "AgencyCryptoRootBridge" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "fromVersion" INTEGER NOT NULL,
  "toVersion" INTEGER NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm-root-bridge-v1',
  "createdByDeviceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retiredAt" TIMESTAMP(3),
  CONSTRAINT "AgencyCryptoRootBridge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgencyCryptoRootBridge_agencyId_fromVersion_toVersion_key"
  ON "AgencyCryptoRootBridge"("agencyId", "fromVersion", "toVersion");
CREATE INDEX "AgencyCryptoRootBridge_agencyId_toVersion_retiredAt_idx"
  ON "AgencyCryptoRootBridge"("agencyId", "toVersion", "retiredAt");

ALTER TABLE "AgencyCryptoRootBridge"
  ADD CONSTRAINT "AgencyCryptoRootBridge_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgencyCryptoRootBridge"
  ADD CONSTRAINT "AgencyCryptoRootBridge_createdByDeviceId_fkey"
  FOREIGN KEY ("createdByDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
