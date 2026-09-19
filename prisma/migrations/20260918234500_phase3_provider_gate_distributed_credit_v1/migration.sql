-- Phase 3 INT5.9A-12
-- Durable cross-process OF provider request credit. One singleton row is the
-- physical two-phase permit authority across rolling Backend generations.
CREATE TABLE IF NOT EXISTS "OfProviderRequestGateState" (
  "id" TEXT NOT NULL,
  "activePermitId" TEXT,
  "activeOwnerInstanceId" TEXT,
  "activeAgencyId" TEXT,
  "activeCreatorId" TEXT,
  "activeDeviceId" TEXT,
  "activeCapability" TEXT,
  "activeIntervalMs" INTEGER,
  "activeGrantedAt" TIMESTAMP(3),
  "activeExpiresAt" TIMESTAMP(3),
  "nextAllowedAt" TIMESTAMP(3),
  "revision" BIGINT NOT NULL DEFAULT 0,
  "lastStartedAt" TIMESTAMP(3),
  "lastStartedCreatorId" TEXT,
  "lastStartedDeviceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OfProviderRequestGateState_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OfProviderRequestGateState_active_expiry_idx"
  ON "OfProviderRequestGateState"("activeExpiresAt");
CREATE INDEX IF NOT EXISTS "OfProviderRequestGateState_next_allowed_idx"
  ON "OfProviderRequestGateState"("nextAllowedAt");

INSERT INTO "OfProviderRequestGateState" ("id", "revision", "createdAt", "updatedAt")
VALUES ('of-global', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
