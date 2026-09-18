-- Phase 3 INT5.8A-3: keep Campaign completion proof bounded and durable.
-- Counters are advanced transactionally when campaign/claimer page batches become terminal.
ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN IF NOT EXISTS "campaignProofScanRunId" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "campaignProofCollectorVersion" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "campaignProofCampaignBatches" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignProofClaimerBatches" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignProofRejectedBatches" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "campaignProofRejectedRows" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CreatorCampaignCollectionState_completion_proof_nonnegative_check'
  ) THEN
    ALTER TABLE "CreatorCampaignCollectionState"
      ADD CONSTRAINT "CreatorCampaignCollectionState_completion_proof_nonnegative_check" CHECK (
        "campaignProofCampaignBatches" >= 0
        AND "campaignProofClaimerBatches" >= 0
        AND "campaignProofRejectedBatches" >= 0
        AND "campaignProofRejectedRows" >= 0
      ) NOT VALID;
    ALTER TABLE "CreatorCampaignCollectionState"
      VALIDATE CONSTRAINT "CreatorCampaignCollectionState_completion_proof_nonnegative_check";
  END IF;
END $$;

-- Adopt already-running Actual66 campaigns-v8 jobs. This is a one-time rollout
-- bridge only; steady-state completion never scans AnalyticsIngestBatch history.
-- sourceJobId is indexed, so each active collection state only touches its own
-- operational batches instead of the platform-wide ingest ledger.
WITH active_v8 AS (
  SELECT
    s."id" AS state_id,
    s."activeGeneration" AS scan_run_id,
    s."sourceJobId" AS source_job_id
  FROM "CreatorCampaignCollectionState" s
  WHERE s."activeGeneration" IS NOT NULL
    AND s."sourceJobId" IS NOT NULL
    AND s."status" IN ('SCANNING', 'PARTIAL')
), proof AS (
  SELECT
    a.state_id,
    a.scan_run_id,
    COUNT(*) FILTER (
      WHERE b."idempotencyKey" LIKE ('campaigns:' || a.source_job_id || ':run:' || a.scan_run_id || ':campaigns-v8:campaigns:%')
        AND b."status" IN ('COMMITTED', 'PARTIAL')
    )::INTEGER AS campaign_batches,
    COUNT(*) FILTER (
      WHERE b."idempotencyKey" LIKE ('campaigns:' || a.source_job_id || ':run:' || a.scan_run_id || ':campaigns-v8:claimers:%')
        AND b."status" IN ('COMMITTED', 'PARTIAL')
    )::INTEGER AS claimer_batches,
    COUNT(*) FILTER (
      WHERE (
        b."idempotencyKey" LIKE ('campaigns:' || a.source_job_id || ':run:' || a.scan_run_id || ':campaigns-v8:campaigns:%')
        OR b."idempotencyKey" LIKE ('campaigns:' || a.source_job_id || ':run:' || a.scan_run_id || ':campaigns-v8:claimers:%')
      )
        AND b."status" IN ('COMMITTED', 'PARTIAL')
        AND (b."status" <> 'COMMITTED' OR b."rejectedRows" > 0)
    )::INTEGER AS rejected_batches,
    COALESCE(SUM(b."rejectedRows") FILTER (
      WHERE (
        b."idempotencyKey" LIKE ('campaigns:' || a.source_job_id || ':run:' || a.scan_run_id || ':campaigns-v8:campaigns:%')
        OR b."idempotencyKey" LIKE ('campaigns:' || a.source_job_id || ':run:' || a.scan_run_id || ':campaigns-v8:claimers:%')
      )
        AND b."status" IN ('COMMITTED', 'PARTIAL')
    ), 0)::INTEGER AS rejected_rows
  FROM active_v8 a
  LEFT JOIN "AnalyticsIngestBatch" b
    ON b."sourceJobId" = a.source_job_id
   AND b."dataType" = 'CAMPAIGNS'
   AND b."collectorVersion" = 'campaigns-v8'
  GROUP BY a.state_id, a.scan_run_id
)
UPDATE "CreatorCampaignCollectionState" s
SET
  "campaignProofScanRunId" = p.scan_run_id,
  "campaignProofCollectorVersion" = 'campaigns-v8',
  "campaignProofCampaignBatches" = p.campaign_batches,
  "campaignProofClaimerBatches" = p.claimer_batches,
  "campaignProofRejectedBatches" = p.rejected_batches,
  "campaignProofRejectedRows" = p.rejected_rows
FROM proof p
WHERE s."id" = p.state_id;
