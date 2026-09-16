-- Phase 3 / INT4.3A — SFS stable opaque target identity + UNKNOWN preservation.
--
-- SFS username is mutable profile data.  Historical workflow/safety state is
-- merged by (creatorId,targetUserId), then the old username unique constraint is
-- retired.  Existing cleanup deliveries/jobs are repointed before duplicate
-- candidate rows are removed so an active safety obligation is never orphaned.

-- Normalize historical opaque ids before duplicate grouping. Empty ids are
-- unresolved archaeology and remain non-executable NULL rows.
UPDATE "SfsTargetCandidate"
SET "targetUserId" = NULLIF(btrim("targetUserId"), '')
WHERE "targetUserId" IS DISTINCT FROM NULLIF(btrim("targetUserId"), '');

CREATE TEMP TABLE "_SfsTargetCandidateMerge" ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    c."id",
    c."creatorId",
    c."targetUserId",
    row_number() OVER (
      PARTITION BY c."creatorId", c."targetUserId"
      ORDER BY
        CASE WHEN c."state" IN ('UNFOLLOW_DUE','UNFOLLOWING','RECOVERY_REQUIRED') OR c."safetyUnfollowDeliveryId" IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN c."state" IN ('QUEUED','FOLLOWING','SCANNING','ACTING','UNFOLLOW_DUE','UNFOLLOWING','RECOVERY_REQUIRED') THEN 0 ELSE 1 END,
        c."usedForever" DESC,
        c."generation" DESC,
        COALESCE(c."discoveryObservedAt", c."lastSeenAt", c."updatedAt", c."createdAt") DESC,
        c."id" ASC
    ) AS rn
  FROM "SfsTargetCandidate" c
  WHERE c."targetUserId" IS NOT NULL AND btrim(c."targetUserId") <> ''
), winners AS (
  SELECT "creatorId", "targetUserId", "id" AS winner_id
  FROM ranked
  WHERE rn = 1
)
SELECT r."id" AS loser_id, w.winner_id
FROM ranked r
JOIN winners w
  ON w."creatorId" = r."creatorId"
 AND w."targetUserId" = r."targetUserId"
WHERE r.rn > 1;

-- Preserve all executable/history references to candidate ids before deleting
-- duplicate username-era projections.
UPDATE "AutomationDelivery" d
SET "payload" = jsonb_set(COALESCE(d."payload", '{}'::jsonb), '{candidateId}', to_jsonb(m.winner_id), true)
FROM "_SfsTargetCandidateMerge" m
WHERE d."payload"->>'candidateId' = m.loser_id;

UPDATE "JobInstance" j
SET "params" = jsonb_set(COALESCE(j."params", '{}'::jsonb), '{candidateId}', to_jsonb(m.winner_id), true)
FROM "_SfsTargetCandidateMerge" m
WHERE j."params"->>'candidateId' = m.loser_id;

UPDATE "AutomationJob" j
SET "payload" = jsonb_set(COALESCE(j."payload", '{}'::jsonb), '{candidateId}', to_jsonb(m.winner_id), true)
FROM "_SfsTargetCandidateMerge" m
WHERE j."payload"->>'candidateId' = m.loser_id;

-- Merge safety/local-control facts onto the chosen survivor.  The survivor is
-- deliberately ranked toward active cleanup/recovery state.  All cleanup
-- deliveries were repointed above, so retaining the earliest outstanding due
-- time is conservative and cannot silently discard a safety obligation.
UPDATE "SfsTargetCandidate" w
SET
  "usedForever" = agg.used_forever,
  "blocked" = agg.blocked,
  "ignored" = agg.ignored,
  "generation" = GREATEST(w."generation", agg.max_generation),
  "unfollowAt" = COALESCE(LEAST(w."unfollowAt", agg.min_unfollow_at), w."unfollowAt", agg.min_unfollow_at),
  "safetyUnfollowDeliveryId" = COALESCE(w."safetyUnfollowDeliveryId", agg.any_cleanup_id),
  "metadata" = COALESCE(w."metadata", '{}'::jsonb) || jsonb_build_object(
    'opaqueIdentityMergedAt', CURRENT_TIMESTAMP,
    'opaqueIdentityMergeCount', agg.row_count
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT
    c."creatorId",
    c."targetUserId",
    bool_or(c."usedForever") AS used_forever,
    bool_or(c."blocked") AS blocked,
    bool_or(c."ignored") AS ignored,
    max(c."generation") AS max_generation,
    min(c."unfollowAt") AS min_unfollow_at,
    max(c."safetyUnfollowDeliveryId") FILTER (WHERE c."safetyUnfollowDeliveryId" IS NOT NULL) AS any_cleanup_id,
    count(*)::int AS row_count
  FROM "SfsTargetCandidate" c
  WHERE c."targetUserId" IS NOT NULL AND btrim(c."targetUserId") <> ''
  GROUP BY c."creatorId", c."targetUserId"
  HAVING count(*) > 1
) agg
WHERE w."creatorId" = agg."creatorId"
  AND w."targetUserId" = agg."targetUserId"
  AND NOT EXISTS (SELECT 1 FROM "_SfsTargetCandidateMerge" m WHERE m.loser_id = w."id");

DELETE FROM "SfsTargetCandidate" c
USING "_SfsTargetCandidateMerge" m
WHERE c."id" = m.loser_id;

-- UNKNOWN price must remain NULL rather than silently becoming FREE.
ALTER TABLE "SfsTargetCandidate"
  ALTER COLUMN "subscribePriceCents" DROP NOT NULL,
  ALTER COLUMN "subscribePriceCents" DROP DEFAULT;

-- Pre-cutover SFS normalizers collapsed missing price/follow facts to 0/false.
-- There is no reliable row-level evidence that distinguishes those coerced
-- values from explicit provider values, so invalidate both projections once.
-- Active cleanup/recovery lifecycle is preserved; only ordinary future
-- eligibility must wait for a fresh profile observation.
UPDATE "SfsTargetCandidate"
SET
  "subscribePriceCents" = NULL,
  "creatorFollowing" = NULL,
  "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
    'legacyRelationshipProjectionInvalidatedAt', CURRENT_TIMESTAMP,
    'legacyRelationshipProjectionReason', 'INT4_3A_UNKNOWN_SEMANTICS_CUTOVER'
  ),
  "updatedAt" = CURRENT_TIMESTAMP;

-- Username is mutable and recyclable.  Keep it searchable, but never unique.
DROP INDEX IF EXISTS "SfsTargetCandidate_creatorId_username_key";
CREATE INDEX IF NOT EXISTS "SfsTargetCandidate_creatorId_username_idx"
  ON "SfsTargetCandidate"("creatorId", "username");

-- PostgreSQL UNIQUE permits multiple NULLs, so unresolved archaeology rows can
-- remain non-executable while every real opaque OF target is one identity per
-- creator.  Prisma 5 cannot model a compound @@unique containing a nullable
-- field, therefore this DB invariant intentionally lives in the migration.
CREATE UNIQUE INDEX IF NOT EXISTS "SfsTargetCandidate_creatorId_targetUserId_key"
  ON "SfsTargetCandidate"("creatorId", "targetUserId");
