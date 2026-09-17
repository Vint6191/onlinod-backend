-- Phase 3 / INT5.4B — restore historical oneTargetForever proof from the
-- pre-P14 AutomationJob ledger after opaque-id duplicate convergence.
--
-- The earlier mixed-history repair intentionally trusted completed P14
-- SFS_UNFOLLOW_TARGET deliveries. A creator can also have a genuine legacy
-- `sfs_used_marker` from Alpha/P14 cutover with no completed new-generation
-- delivery. That marker was already treated as durable one-target-forever
-- evidence by the original P14 migration and must remain durable after later
-- duplicate merge + transient-marker cleanup.
--
-- Forward-only repair: do not rewrite current workflow state/phase or create
-- new deliveries. Restore only the historical consumption bit and provenance.

WITH legacy_consumption AS (
  SELECT DISTINCT ON (c."id")
    c."id" AS candidate_id,
    j."id" AS proof_job_id,
    COALESCE(j."completedAt", j."updatedAt", j."createdAt") AS proof_at
  FROM "SfsTargetCandidate" c
  JOIN "AutomationJob" j
    ON j."agencyId" = c."agencyId"
   AND j."creatorId" = c."creatorId"
   AND NULLIF(j."payload"->>'targetUserId', '') = c."targetUserId"
  WHERE j."type" = 'sfs_hunter'
    AND j."action" = 'sfs_used_marker'
    AND j."status" = 'done'
    AND c."targetUserId" IS NOT NULL
  ORDER BY
    c."id",
    COALESCE(j."completedAt", j."updatedAt", j."createdAt") DESC,
    j."id" DESC
)
UPDATE "SfsTargetCandidate" c
SET
  "usedForever" = true,
  "metadata" = COALESCE(c."metadata", '{}'::jsonb) || jsonb_build_object(
    'historicalConsumptionProofRestoredAt', CURRENT_TIMESTAMP,
    'historicalConsumptionProofLegacyJobId', h.proof_job_id,
    'historicalConsumptionProofAt', h.proof_at,
    'historicalConsumptionProofKind', 'LEGACY_SFS_USED_MARKER'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM legacy_consumption h
WHERE c."id" = h.candidate_id
  AND c."usedForever" IS DISTINCT FROM true;
