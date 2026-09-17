-- Phase 3 / INT5.4C-1A
-- Server-owned post-provider-read observation tokens.
-- FanObservationClock serializes token issue and guarantees a strictly
-- increasing millisecond timestamp compatible with existing authorityVersion.

CREATE TABLE IF NOT EXISTS "FanObservationClock" (
  "id" INTEGER PRIMARY KEY,
  "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "FanObservationClock" ("id", "lastObservedAt", "updatedAt")
VALUES (1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "FanObservationToken" (
  "id" BIGSERIAL PRIMARY KEY,
  "token" TEXT NOT NULL UNIQUE,
  "jobId" TEXT NOT NULL,
  "agencyId" TEXT,
  "creatorId" TEXT,
  "deviceId" TEXT NOT NULL,
  "leaseRevision" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "scopeHash" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "FanObservationToken_jobId_leaseRevision_idx"
  ON "FanObservationToken" ("jobId", "leaseRevision");
CREATE INDEX IF NOT EXISTS "FanObservationToken_jobId_consumedAt_idx"
  ON "FanObservationToken" ("jobId", "consumedAt");
CREATE INDEX IF NOT EXISTS "FanObservationToken_creatorId_observedAt_idx"
  ON "FanObservationToken" ("creatorId", "observedAt");
