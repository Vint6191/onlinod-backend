-- Analytics observation authority: durable provider-scan proof survives operational JobInstance retention.
CREATE TABLE "AnalyticsScanProof" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dataType" "AnalyticsDataType" NOT NULL,
    "scanRunId" TEXT NOT NULL,
    "sourceTimezone" TEXT NOT NULL,
    "scanFrom" DATE NOT NULL,
    "scanTo" DATE NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "clientObservedAt" TIMESTAMP(3),
    "serverReceivedAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "status" "AnalyticsIngestStatus" NOT NULL,
    "collectorVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "scanGeneration" TEXT NOT NULL,
    "collectionReason" TEXT NOT NULL,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedRows" INTEGER NOT NULL DEFAULT 0,
    "payloadChecksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalyticsScanProof_pkey" PRIMARY KEY ("id")
);


-- Analytics recurring collection has one durable cycle owner across backend replicas.
-- The lease is operational coordination only; it is never analytics business truth.
CREATE TABLE "AnalyticsCollectionLease" (
    "key" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "cycleNow" TIMESTAMP(3) NOT NULL,
    "cursorCreatorId" TEXT,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalyticsCollectionLease_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "AnalyticsCollectionLease_leaseUntil_idx" ON "AnalyticsCollectionLease"("leaseUntil");
CREATE INDEX "AnalyticsCollectionLease_cycle_complete_idx" ON "AnalyticsCollectionLease"("cycleKey", "completedAt");

-- Interactive Home refresh is one durable planner demand, not an HTTP loop over
-- every creator. Revision + lease + cursor make it replayable and multi-replica safe.
CREATE TABLE "AnalyticsCollectionDemand" (
    "key" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "rangeKey" TEXT NOT NULL,
    "coverageFrom" DATE NOT NULL,
    "coverageTo" DATE NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "reason" TEXT NOT NULL,
    "creatorIds" JSONB,
    "requestedByMemberId" TEXT NOT NULL,
    "requestedAccessEpoch" INTEGER NOT NULL,
    "requestRevision" INTEGER NOT NULL DEFAULT 1,
    "completedRevision" INTEGER NOT NULL DEFAULT 0,
    "claimedRevision" INTEGER,
    "claimToken" TEXT,
    "claimUntil" TIMESTAMP(3),
    "cursorCreatorId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalyticsCollectionDemand_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "AnalyticsCollectionDemand_due_idx"
ON "AnalyticsCollectionDemand"("completedAt", "claimUntil", "requestedAt");
CREATE INDEX "AnalyticsCollectionDemand_agency_requested_idx"
ON "AnalyticsCollectionDemand"("agencyId", "requestedAt");

-- Cursor-paginated recurring analytics sweep reads READY, non-deleted creators
-- in id order. This index makes the hot due-work scan scale with the current
-- READY workset instead of repeatedly sorting/scanning the whole creator table.
CREATE INDEX "CreatorAccount_status_deleted_id_idx"
ON "CreatorAccount"("status", "deletedAt", "id");

ALTER TABLE "AnalyticsCoverage" ADD COLUMN "scanProofId" TEXT;
ALTER TABLE "CreatorEarningsDaily" ADD COLUMN "sourceScanRequestedAt" TIMESTAMP(3);
ALTER TABLE "CreatorEarningsDaily" ADD COLUMN "scanProofId" TEXT;

CREATE UNIQUE INDEX "AnalyticsScanProof_creator_type_run_key"
ON "AnalyticsScanProof"("creatorId", "dataType", "scanRunId");
CREATE INDEX "AnalyticsScanProof_agency_creator_type_commit_idx"
ON "AnalyticsScanProof"("agencyId", "creatorId", "dataType", "committedAt");
CREATE INDEX "AnalyticsScanProof_creator_type_window_idx"
ON "AnalyticsScanProof"("creatorId", "dataType", "scanFrom", "scanTo");
CREATE INDEX "AnalyticsScanProof_sourceJobId_idx" ON "AnalyticsScanProof"("sourceJobId");
-- Bounded proof GC walks old receipts in deterministic createdAt/id order.
CREATE INDEX "AnalyticsScanProof_createdAt_id_idx" ON "AnalyticsScanProof"("createdAt", "id");
CREATE INDEX "AnalyticsCoverage_scanProofId_idx" ON "AnalyticsCoverage"("scanProofId");
CREATE INDEX "CreatorEarningsDaily_scanProofId_idx" ON "CreatorEarningsDaily"("scanProofId");

ALTER TABLE "AnalyticsScanProof"
ADD CONSTRAINT "AnalyticsScanProof_agencyId_creatorId_fkey"
FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalyticsCoverage"
ADD CONSTRAINT "AnalyticsCoverage_scanProofId_fkey"
FOREIGN KEY ("scanProofId") REFERENCES "AnalyticsScanProof"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorEarningsDaily"
ADD CONSTRAINT "CreatorEarningsDaily_scanProofId_fkey"
FOREIGN KEY ("scanProofId") REFERENCES "AnalyticsScanProof"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing relational v4 completion batches are already canonical ingest evidence.
-- Materialize durable receipts from that evidence only; legacy snapshots are deliberately excluded.
INSERT INTO "AnalyticsScanProof" (
    "id", "agencyId", "creatorId", "dataType", "scanRunId", "sourceTimezone",
    "scanFrom", "scanTo", "requestedAt", "clientObservedAt", "serverReceivedAt", "committedAt",
    "status", "collectorVersion", "schemaVersion", "scanGeneration", "collectionReason",
    "sourceDeviceId", "sourceJobId", "rowCount", "rejectedRows", "payloadChecksum", "createdAt", "updatedAt"
)
SELECT
    'migrated_' || md5(b."id"),
    b."agencyId",
    b."creatorId",
    b."dataType",
    substring(b."idempotencyKey" from 'run:([^:]+):completion'),
    b."sourceTimezone",
    b."rangeFrom"::date,
    b."rangeTo"::date,
    COALESCE(j."scheduledAt", b."startedAt"),
    NULL,
    b."startedAt",
    b."completedAt",
    b."status",
    b."collectorVersion",
    b."schemaVersion",
    'MIGRATED_V4',
    'MIGRATED_CANONICAL_INGEST',
    b."sourceDeviceId",
    b."sourceJobId",
    b."receivedRows",
    b."rejectedRows",
    b."payloadChecksum",
    b."createdAt",
    b."updatedAt"
FROM "AnalyticsIngestBatch" b
LEFT JOIN "JobInstance" j ON j."id" = b."sourceJobId"
WHERE b."dataType" = 'EARNINGS'::"AnalyticsDataType"
  AND b."idempotencyKey" LIKE 'earnings:%:completion:v4'
  AND substring(b."idempotencyKey" from 'run:([^:]+):completion') IS NOT NULL
ON CONFLICT ("creatorId", "dataType", "scanRunId") DO NOTHING;

UPDATE "CreatorEarningsDaily" d
SET "scanProofId" = p."id",
    "sourceScanRequestedAt" = p."requestedAt"
FROM "AnalyticsScanProof" p
WHERE p."creatorId" = d."creatorId"
  AND p."dataType" = 'EARNINGS'::"AnalyticsDataType"
  AND p."scanRunId" = d."sourceScanRunId"
  AND d."scanProofId" IS NULL;

UPDATE "AnalyticsCoverage" c
SET "scanProofId" = p."id"
FROM "AnalyticsIngestBatch" b,
     "AnalyticsScanProof" p
WHERE c."ingestBatchId" = b."id"
  AND c."creatorId" = p."creatorId"
  AND p."dataType" = 'EARNINGS'::"AnalyticsDataType"
  AND p."scanRunId" = substring(b."idempotencyKey" from 'run:([^:]+):daily')
  AND c."scanProofId" IS NULL;
