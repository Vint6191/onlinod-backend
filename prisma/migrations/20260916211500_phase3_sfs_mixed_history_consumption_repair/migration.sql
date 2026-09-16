-- Phase 3 / INT5.2A — repair mixed-history SFS duplicate consumption proof.
--
-- INT4.3A repointed AutomationDelivery.payload.candidateId to the opaque-id
-- survivor before deleting username-era duplicates. INT4.3C then correctly
-- cleared transient paid/comments-disabled usedForever rows, but a merged
-- survivor can carry that transient SKIPPED state while an older duplicate
-- represented a genuine completed SFS cycle. In that shape the scalar
-- usedForever=true survives the merge, then is cleared by INT4.3C and the
-- historical oneTargetForever proof is lost.
--
-- Completed SFS safety-unfollow delivery history is durable server evidence
-- that an ONLINOD SFS cycle reached its terminal cleanup. Restore only the
-- oneTargetForever bit from that durable history. Do not rewrite current
-- workflow state/phase: an active safety/recovery obligation must remain
-- exactly where it is.

WITH historical_consumption AS (
  SELECT DISTINCT ON (c."id")
    c."id" AS candidate_id,
    d."id" AS proof_delivery_id,
    COALESCE(d."finishedAt", d."updatedAt", d."createdAt") AS proof_at
  FROM "SfsTargetCandidate" c
  JOIN "AutomationDelivery" d
    ON d."agencyId" = c."agencyId"
   AND d."creatorId" = c."creatorId"
  WHERE d."moduleKey" = 'sfs'
    AND d."actionType" = 'SFS_UNFOLLOW_TARGET'
    AND d."status" = 'COMPLETED'
    AND (
      d."payload"->>'candidateId' = c."id"
      OR (
        c."targetUserId" IS NOT NULL
        AND (
          d."fanId" = c."targetUserId"
          OR d."targetId" = c."targetUserId"
          OR d."payload"->>'targetUserId' = c."targetUserId"
        )
      )
    )
  ORDER BY
    c."id",
    COALESCE(d."finishedAt", d."updatedAt", d."createdAt") DESC,
    d."id" DESC
)
UPDATE "SfsTargetCandidate" c
SET
  "usedForever" = true,
  "metadata" = COALESCE(c."metadata", '{}'::jsonb) || jsonb_build_object(
    'historicalConsumptionProofRestoredAt', CURRENT_TIMESTAMP,
    'historicalConsumptionProofDeliveryId', h.proof_delivery_id,
    'historicalConsumptionProofAt', h.proof_at,
    'historicalConsumptionProofKind', 'COMPLETED_SFS_UNFOLLOW_DELIVERY'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM historical_consumption h
WHERE c."id" = h.candidate_id
  AND c."usedForever" IS DISTINCT FROM true;
