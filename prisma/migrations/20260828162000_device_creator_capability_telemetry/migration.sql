ALTER TABLE "DeviceCreatorBinding"
  ADD COLUMN IF NOT EXISTS "accessEpoch" INTEGER,
  ADD COLUMN IF NOT EXISTS "sessionReadReady" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sessionWriteReady" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "realtimeReady" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pageLocalReady" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "browserMaterialized" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "browserPresentable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sessionProofEpoch" INTEGER,
  ADD COLUMN IF NOT EXISTS "canonicalRevision" INTEGER,
  ADD COLUMN IF NOT EXISTS "networkRevision" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastCapabilityAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "DeviceCreatorBinding_deviceId_sessionReadReady_lastSeenAt_idx"
  ON "DeviceCreatorBinding"("deviceId", "sessionReadReady", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "DeviceCreatorBinding_deviceId_sessionWriteReady_lastSeenAt_idx"
  ON "DeviceCreatorBinding"("deviceId", "sessionWriteReady", "lastSeenAt");
