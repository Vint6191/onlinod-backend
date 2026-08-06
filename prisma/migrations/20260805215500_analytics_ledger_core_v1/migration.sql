-- Analytics Ledger Core V1
--
-- This migration introduces only the stable relational spine:
-- creator-scoped fan identity, idempotent ingest audit rows, and honest
-- day-level coverage. Business facts (sales, tips, likes, comments, etc.) are
-- intentionally added later from verified OnlyFans payloads.

CREATE TYPE "AnalyticsDataType" AS ENUM (
  'EARNINGS',
  'NOTIFICATIONS',
  'CAMPAIGNS',
  'MESSAGES_DAILY'
);

CREATE TYPE "AnalyticsCoverageStatus" AS ENUM (
  'MISSING',
  'QUEUED',
  'SCANNING',
  'PARTIAL',
  'COMPLETE',
  'FAILED',
  'UNAVAILABLE'
);

CREATE TYPE "AnalyticsIngestStatus" AS ENUM (
  'RECEIVED',
  'COMMITTED',
  'PARTIAL',
  'REJECTED',
  'FAILED'
);

CREATE TABLE "CreatorFan" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "onlyFansUserId" TEXT NOT NULL,
  "username" TEXT,
  "displayName" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorFan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorFan_non_empty_onlyfans_id_check" CHECK (length(btrim("onlyFansUserId")) > 0)
);

CREATE TABLE "AnalyticsIngestBatch" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "sourceDeviceId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "dataType" "AnalyticsDataType" NOT NULL,
  "status" "AnalyticsIngestStatus" NOT NULL DEFAULT 'RECEIVED',
  "rangeFrom" TIMESTAMP(3) NOT NULL,
  "rangeTo" TIMESTAMP(3) NOT NULL,
  "sourceTimezone" TEXT NOT NULL,
  "collectorVersion" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "payloadChecksum" TEXT NOT NULL,
  "receivedRows" INTEGER NOT NULL DEFAULT 0,
  "insertedRows" INTEGER NOT NULL DEFAULT 0,
  "updatedRows" INTEGER NOT NULL DEFAULT 0,
  "unchangedRows" INTEGER NOT NULL DEFAULT 0,
  "rejectedRows" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsIngestBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnalyticsIngestBatch_non_negative_counts_check" CHECK (
    "receivedRows" >= 0 AND
    "insertedRows" >= 0 AND
    "updatedRows" >= 0 AND
    "unchangedRows" >= 0 AND
    "rejectedRows" >= 0
  ),
  CONSTRAINT "AnalyticsIngestBatch_valid_range_check" CHECK ("rangeTo" >= "rangeFrom"),
  CONSTRAINT "AnalyticsIngestBatch_positive_schema_version_check" CHECK ("schemaVersion" > 0),
  CONSTRAINT "AnalyticsIngestBatch_processed_counts_check" CHECK (
    "insertedRows" + "updatedRows" + "unchangedRows" + "rejectedRows" <= "receivedRows"
  ),
  CONSTRAINT "AnalyticsIngestBatch_checksum_check" CHECK ("payloadChecksum" ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT "AnalyticsIngestBatch_non_empty_metadata_check" CHECK (
    length(btrim("idempotencyKey")) > 0 AND
    length(btrim("sourceTimezone")) > 0 AND
    length(btrim("collectorVersion")) > 0
  )
);

CREATE TABLE "AnalyticsCoverage" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "ingestBatchId" TEXT,
  "dataType" "AnalyticsDataType" NOT NULL,
  "coverageDate" DATE NOT NULL,
  "sourceTimezone" TEXT NOT NULL,
  "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
  "coveredFromAt" TIMESTAMP(3),
  "coveredToAt" TIMESTAMP(3),
  "sourceCursorStart" TEXT,
  "sourceCursorEnd" TEXT,
  "lastVerifiedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "retryAfterAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsCoverage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnalyticsCoverage_valid_interval_check" CHECK (
    "coveredFromAt" IS NULL OR
    "coveredToAt" IS NULL OR
    "coveredToAt" >= "coveredFromAt"
  ),
  CONSTRAINT "AnalyticsCoverage_non_empty_timezone_check" CHECK (length(btrim("sourceTimezone")) > 0)
);

CREATE UNIQUE INDEX "CreatorFan_creatorId_onlyFansUserId_key"
  ON "CreatorFan"("creatorId", "onlyFansUserId");
CREATE INDEX "CreatorFan_agencyId_creatorId_idx"
  ON "CreatorFan"("agencyId", "creatorId");
CREATE INDEX "CreatorFan_creatorId_lastSeenAt_idx"
  ON "CreatorFan"("creatorId", "lastSeenAt");

CREATE UNIQUE INDEX "AnalyticsIngestBatch_idempotencyKey_key"
  ON "AnalyticsIngestBatch"("idempotencyKey");
CREATE INDEX "AnalyticsIngestBatch_agencyId_creatorId_dataType_startedAt_idx"
  ON "AnalyticsIngestBatch"("agencyId", "creatorId", "dataType", "startedAt");
CREATE INDEX "AnalyticsIngestBatch_creatorId_dataType_status_idx"
  ON "AnalyticsIngestBatch"("creatorId", "dataType", "status");
CREATE INDEX "AnalyticsIngestBatch_sourceDeviceId_startedAt_idx"
  ON "AnalyticsIngestBatch"("sourceDeviceId", "startedAt");

CREATE UNIQUE INDEX "AnalyticsCoverage_creator_day_key"
  ON "AnalyticsCoverage"("creatorId", "dataType", "coverageDate", "sourceTimezone");
CREATE INDEX "AnalyticsCoverage_agency_creator_type_day_idx"
  ON "AnalyticsCoverage"("agencyId", "creatorId", "dataType", "coverageDate");
CREATE INDEX "AnalyticsCoverage_creator_type_status_day_idx"
  ON "AnalyticsCoverage"("creatorId", "dataType", "status", "coverageDate");
CREATE INDEX "AnalyticsCoverage_ingestBatchId_idx"
  ON "AnalyticsCoverage"("ingestBatchId");

ALTER TABLE "CreatorFan"
  ADD CONSTRAINT "CreatorFan_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CreatorFan_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AnalyticsIngestBatch"
  ADD CONSTRAINT "AnalyticsIngestBatch_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AnalyticsIngestBatch_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AnalyticsIngestBatch_sourceDeviceId_fkey"
    FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AnalyticsCoverage"
  ADD CONSTRAINT "AnalyticsCoverage_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AnalyticsCoverage_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AnalyticsCoverage_ingestBatchId_fkey"
    FOREIGN KEY ("ingestBatchId") REFERENCES "AnalyticsIngestBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
