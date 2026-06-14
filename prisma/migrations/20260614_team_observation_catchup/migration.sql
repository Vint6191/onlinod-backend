-- v17 observation/catch-up state.
-- One row per agency + creator, overwritten by heartbeat/catch-up.

CREATE TABLE IF NOT EXISTS "TeamObservationState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT 'unknown',
  "creatorRef" TEXT,
  "lastHeartbeatAt" TIMESTAMP(3),
  "lastRealtimeEventAt" TIMESTAMP(3),
  "lastObservedAt" TIMESTAMP(3),
  "lastPurchaseScanTo" TIMESTAMP(3),
  "lastTipScanTo" TIMESTAMP(3),
  "lastSuccessfulScanAt" TIMESTAMP(3),
  "currentScanStatus" TEXT NOT NULL DEFAULT 'idle',
  "currentScanFrom" TIMESTAMP(3),
  "currentScanTo" TIMESTAMP(3),
  "currentScanTypes" JSONB,
  "lockedByDeviceId" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "lastScanSummary" JSONB,
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TeamObservationState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamObservationState_agencyId_creatorId_key"
  ON "TeamObservationState"("agencyId", "creatorId");

CREATE INDEX IF NOT EXISTS "TeamObservationState_agencyId_lastObservedAt_idx"
  ON "TeamObservationState"("agencyId", "lastObservedAt");

CREATE INDEX IF NOT EXISTS "TeamObservationState_agencyId_currentScanStatus_idx"
  ON "TeamObservationState"("agencyId", "currentScanStatus");

CREATE INDEX IF NOT EXISTS "TeamObservationState_lockedUntil_idx"
  ON "TeamObservationState"("lockedUntil");

ALTER TABLE "TeamObservationState"
  ADD CONSTRAINT "TeamObservationState_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamObservationState"
  ADD CONSTRAINT "TeamObservationState_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
