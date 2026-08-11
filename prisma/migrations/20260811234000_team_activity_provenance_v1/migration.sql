-- Team Analytics provenance v1.
-- Keep legacy columns intact while adding relational, queryable semantics for
-- canonical Team v13 events. This migration is intentionally additive so old
-- Electron clients and old Claims events continue to ingest during rollout.
ALTER TABLE "TeamActivityEvent"
  ADD COLUMN IF NOT EXISTS "eventKind" TEXT,
  ADD COLUMN IF NOT EXISTS "actionSource" TEXT,
  ADD COLUMN IF NOT EXISTS "lifecycle" TEXT,
  ADD COLUMN IF NOT EXISTS "dialogId" TEXT,
  ADD COLUMN IF NOT EXISTS "messageId" TEXT,
  ADD COLUMN IF NOT EXISTS "correlationId" TEXT,
  ADD COLUMN IF NOT EXISTS "coverageId" TEXT,
  ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER,
  ADD COLUMN IF NOT EXISTS "automationDeliveryId" TEXT,
  ADD COLUMN IF NOT EXISTS "broadcastDispatchId" TEXT,
  ADD COLUMN IF NOT EXISTS "priceCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "currency" TEXT,
  ADD COLUMN IF NOT EXISTS "isPpv" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "mediaCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_eventKind_ts_idx"
  ON "TeamActivityEvent"("agencyId", "eventKind", "ts");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_actionSource_ts_idx"
  ON "TeamActivityEvent"("agencyId", "actionSource", "ts");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_messageId_idx"
  ON "TeamActivityEvent"("agencyId", "messageId");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_correlationId_idx"
  ON "TeamActivityEvent"("agencyId", "correlationId");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_coverageId_ts_idx"
  ON "TeamActivityEvent"("agencyId", "coverageId", "ts");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_automationDeliveryId_idx"
  ON "TeamActivityEvent"("agencyId", "automationDeliveryId");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_broadcastDispatchId_idx"
  ON "TeamActivityEvent"("agencyId", "broadcastDispatchId");
