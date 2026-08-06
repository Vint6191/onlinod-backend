-- Analytics Ledger Core V1 hardening
--
-- Keeps the normal application removal path non-destructive (CreatorAccount is
-- soft-disabled), while preserving the pre-existing explicit super-admin hard
-- delete semantics. It also links ingest audit rows to their source job and
-- enforces state/length invariants that the first migration did not express.

ALTER TABLE "AnalyticsIngestBatch"
  ADD COLUMN "sourceJobId" TEXT;

CREATE INDEX "AnalyticsIngestBatch_sourceJobId_idx"
  ON "AnalyticsIngestBatch"("sourceJobId");

ALTER TABLE "AnalyticsIngestBatch"
  ADD CONSTRAINT "AnalyticsIngestBatch_sourceJobId_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Bind each ledger row to the creator *and* that creator's agency. A pair such
-- as agency B + creator from agency A must be impossible even if a future
-- service has a bug. Normal removal remains a soft-delete; explicit super-admin
-- hard delete keeps its pre-existing cascade semantics.
CREATE UNIQUE INDEX "CreatorAccount_agencyId_id_key"
  ON "CreatorAccount"("agencyId", "id");

ALTER TABLE "CreatorFan"
  DROP CONSTRAINT "CreatorFan_agencyId_fkey",
  DROP CONSTRAINT "CreatorFan_creatorId_fkey",
  ADD CONSTRAINT "CreatorFan_agencyId_creatorId_fkey"
    FOREIGN KEY ("agencyId", "creatorId")
    REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalyticsIngestBatch"
  DROP CONSTRAINT "AnalyticsIngestBatch_agencyId_fkey",
  DROP CONSTRAINT "AnalyticsIngestBatch_creatorId_fkey",
  ADD CONSTRAINT "AnalyticsIngestBatch_agencyId_creatorId_fkey"
    FOREIGN KEY ("agencyId", "creatorId")
    REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalyticsCoverage"
  DROP CONSTRAINT "AnalyticsCoverage_agencyId_fkey",
  DROP CONSTRAINT "AnalyticsCoverage_creatorId_fkey",
  ADD CONSTRAINT "AnalyticsCoverage_agencyId_creatorId_fkey"
    FOREIGN KEY ("agencyId", "creatorId")
    REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorFan"
  ADD CONSTRAINT "CreatorFan_seen_range_check"
    CHECK ("lastSeenAt" >= "firstSeenAt"),
  ADD CONSTRAINT "CreatorFan_identity_length_check"
    CHECK (
      length(btrim("onlyFansUserId")) BETWEEN 1 AND 200 AND
      ("username" IS NULL OR length("username") <= 200) AND
      ("displayName" IS NULL OR length("displayName") <= 500)
    );

ALTER TABLE "AnalyticsIngestBatch"
  ADD CONSTRAINT "AnalyticsIngestBatch_metadata_length_check"
    CHECK (
      length(btrim("idempotencyKey")) BETWEEN 8 AND 240 AND
      length(btrim("sourceTimezone")) BETWEEN 1 AND 100 AND
      length(btrim("collectorVersion")) BETWEEN 1 AND 80 AND
      ("lastErrorCode" IS NULL OR length("lastErrorCode") <= 120) AND
      ("lastErrorMessage" IS NULL OR length("lastErrorMessage") <= 2000)
    ),
  ADD CONSTRAINT "AnalyticsIngestBatch_terminal_state_check"
    CHECK (
      ("status" = 'RECEIVED' AND "completedAt" IS NULL) OR
      ("status" <> 'RECEIVED' AND "completedAt" IS NOT NULL)
    ),
  ADD CONSTRAINT "AnalyticsIngestBatch_committed_counts_check"
    CHECK (
      "status" <> 'COMMITTED' OR (
        "insertedRows" + "updatedRows" + "unchangedRows" = "receivedRows" AND
        "rejectedRows" = 0
      )
    ),
  ADD CONSTRAINT "AnalyticsIngestBatch_rejected_counts_check"
    CHECK ("status" <> 'REJECTED' OR "rejectedRows" = "receivedRows"),
  ADD CONSTRAINT "AnalyticsIngestBatch_failed_error_check"
    CHECK (
      "status" <> 'FAILED' OR
      ("lastErrorCode" IS NOT NULL AND length(btrim("lastErrorCode")) > 0)
    );

ALTER TABLE "AnalyticsCoverage"
  ADD CONSTRAINT "AnalyticsCoverage_metadata_length_check"
    CHECK (
      length(btrim("sourceTimezone")) BETWEEN 1 AND 100 AND
      ("sourceCursorStart" IS NULL OR length("sourceCursorStart") <= 500) AND
      ("sourceCursorEnd" IS NULL OR length("sourceCursorEnd") <= 500) AND
      ("lastErrorCode" IS NULL OR length("lastErrorCode") <= 120) AND
      ("lastErrorMessage" IS NULL OR length("lastErrorMessage") <= 2000)
    ),
  ADD CONSTRAINT "AnalyticsCoverage_verified_state_check"
    CHECK (
      "status" NOT IN ('PARTIAL', 'COMPLETE', 'FAILED', 'UNAVAILABLE') OR
      "lastVerifiedAt" IS NOT NULL
    ),
  ADD CONSTRAINT "AnalyticsCoverage_partial_evidence_check"
    CHECK (
      "status" <> 'PARTIAL' OR
      "coveredFromAt" IS NOT NULL OR
      "coveredToAt" IS NOT NULL OR
      "sourceCursorStart" IS NOT NULL OR
      "sourceCursorEnd" IS NOT NULL
    ),
  ADD CONSTRAINT "AnalyticsCoverage_error_state_check"
    CHECK (
      "status" NOT IN ('FAILED', 'UNAVAILABLE') OR
      ("lastErrorCode" IS NOT NULL AND length(btrim("lastErrorCode")) > 0)
    ),
  ADD CONSTRAINT "AnalyticsCoverage_complete_state_check"
    CHECK (
      "status" <> 'COMPLETE' OR (
        "lastErrorCode" IS NULL AND
        "lastErrorMessage" IS NULL AND
        "retryAfterAt" IS NULL
      )
    ),
  ADD CONSTRAINT "AnalyticsCoverage_missing_state_check"
    CHECK (
      "status" <> 'MISSING' OR (
        "coveredFromAt" IS NULL AND
        "coveredToAt" IS NULL AND
        "sourceCursorStart" IS NULL AND
        "sourceCursorEnd" IS NULL
      )
    );
