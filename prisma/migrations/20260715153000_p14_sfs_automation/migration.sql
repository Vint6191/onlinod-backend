-- P14 SFS Automation. SFS targets are a projection; JobInstance remains the
-- read/orchestration queue and AutomationDelivery remains the only write queue.
CREATE TABLE "SfsTargetCandidate" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "targetUserId" TEXT,
  "username" TEXT NOT NULL,
  "displayName" TEXT,
  "avatarUrl" TEXT,
  "subscribePriceCents" INTEGER NOT NULL DEFAULT 0,
  "isWantComments" BOOLEAN,
  "creatorFollowing" BOOLEAN,
  "sourcePostIds" JSONB NOT NULL DEFAULT '[]',
  "state" TEXT NOT NULL DEFAULT 'CANDIDATE',
  "phase" TEXT NOT NULL DEFAULT 'DISCOVERY',
  "eligibilityReason" TEXT,
  "ignored" BOOLEAN NOT NULL DEFAULT false,
  "blocked" BOOLEAN NOT NULL DEFAULT false,
  "usedForever" BOOLEAN NOT NULL DEFAULT false,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "cooldownUntil" TIMESTAMP(3),
  "latestDeliveryId" TEXT,
  "latestActionType" TEXT,
  "latestStatus" TEXT,
  "latestError" TEXT,
  "scanJobId" TEXT,
  "safetyUnfollowDeliveryId" TEXT,
  "commentsPlanned" INTEGER NOT NULL DEFAULT 0,
  "likesPlanned" INTEGER NOT NULL DEFAULT 0,
  "unfollowAt" TIMESTAMP(3),
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SfsTargetCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SfsTargetCandidate_creatorId_username_key" ON "SfsTargetCandidate"("creatorId", "username");
CREATE INDEX "SfsTargetCandidate_agencyId_creatorId_state_idx" ON "SfsTargetCandidate"("agencyId", "creatorId", "state");
CREATE INDEX "SfsTargetCandidate_creatorId_targetUserId_idx" ON "SfsTargetCandidate"("creatorId", "targetUserId");
CREATE INDEX "SfsTargetCandidate_creatorId_phase_idx" ON "SfsTargetCandidate"("creatorId", "phase");
CREATE INDEX "SfsTargetCandidate_creatorId_usedForever_idx" ON "SfsTargetCandidate"("creatorId", "usedForever");
CREATE INDEX "SfsTargetCandidate_creatorId_unfollowAt_idx" ON "SfsTargetCandidate"("creatorId", "unfollowAt");
CREATE INDEX "SfsTargetCandidate_scanJobId_idx" ON "SfsTargetCandidate"("scanJobId");
ALTER TABLE "SfsTargetCandidate" ADD CONSTRAINT "SfsTargetCandidate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SfsTargetCandidate" ADD CONSTRAINT "SfsTargetCandidate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the approved Alpha SFS settings into the new module control plane.
-- Existing P14 controls win; this is a one-way migration from the legacy
-- AutomationTask settings record.
INSERT INTO "AutomationControlState" (
  "id", "agencyId", "scopeKey", "creatorId", "moduleKey", "enabled",
  "settings", "updatedByUserId", "createdAt", "updatedAt"
)
SELECT
  'p14_sfs_ctl_' || substr(md5(t."agencyId" || ':' || t."creatorId"), 1, 20),
  t."agencyId",
  'creator:' || t."creatorId" || ':module:sfs',
  t."creatorId",
  'sfs',
  CASE WHEN lower(COALESCE(t."config"->>'enabled', '')) IN ('true', 'false') THEN (t."config"->>'enabled')::boolean ELSE t."enabled" END,
  jsonb_build_object(
    'enabled', CASE WHEN lower(COALESCE(t."config"->>'enabled', '')) IN ('true', 'false') THEN (t."config"->>'enabled')::boolean ELSE t."enabled" END,
    'automatic', CASE WHEN lower(COALESCE(t."config"->>'huntingEnabled', '')) IN ('true', 'false') THEN (t."config"->>'huntingEnabled')::boolean ELSE true END,
    'huntingEnabled', CASE WHEN lower(COALESCE(t."config"->>'huntingEnabled', '')) IN ('true', 'false') THEN (t."config"->>'huntingEnabled')::boolean ELSE true END,
    'commentsEnabled', true,
    'commentLikesEnabled', CASE WHEN lower(COALESCE(t."config"->>'commentLikesEnabled', '')) IN ('true', 'false') THEN (t."config"->>'commentLikesEnabled')::boolean ELSE true END,
    'dailyLimit', CASE WHEN COALESCE(t."config"->>'dailyLimit', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'dailyLimit')::integer ELSE 20 END,
    'wallScanPosts', CASE WHEN COALESCE(t."config"->>'wallScanPosts', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'wallScanPosts')::integer ELSE 40 END,
    'discoveryFreshnessHours', 12,
    'maxPinnedPosts', CASE WHEN COALESCE(t."config"->>'maxPinnedPosts', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'maxPinnedPosts')::integer ELSE 5 END,
    'commentsPageLimit', 20,
    'commentsMaxPages', 50,
    'commentLikesPerPost', CASE WHEN COALESCE(t."config"->>'commentLikesPerPost', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'commentLikesPerPost')::integer ELSE 8 END,
    'commentLikesDailyCap', CASE WHEN COALESCE(t."config"->>'commentLikesDailyCap', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'commentLikesDailyCap')::integer ELSE 800 END,
    'minimumIntervalMs', GREATEST(15000, LEAST(86400, CASE WHEN COALESCE(t."config"->>'commentDelayMinSec', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'commentDelayMinSec')::integer ELSE 15 END) * 1000),
    'maximumIntervalMs', GREATEST(15000, LEAST(86400, CASE WHEN COALESCE(t."config"->>'commentDelayMaxSec', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'commentDelayMaxSec')::integer ELSE 45 END) * 1000),
    'randomJitter', true,
    'maxAttempts', 3,
    'followToScanMinMs', GREATEST(1000, LEAST(86400, CASE WHEN COALESCE(t."config"->>'actionDelayMinSec', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'actionDelayMinSec')::integer ELSE 10 END) * 1000),
    'followToScanMaxMs', GREATEST(1000, LEAST(86400, CASE WHEN COALESCE(t."config"->>'actionDelayMaxSec', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'actionDelayMaxSec')::integer ELSE 30 END) * 1000),
    'unfollowMinMinutes', CASE WHEN COALESCE(t."config"->>'unfollowMinMinutes', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'unfollowMinMinutes')::integer ELSE 3 END,
    'unfollowMaxMinutes', CASE WHEN COALESCE(t."config"->>'unfollowMaxMinutes', '') ~ '^[0-9]{1,9}$' THEN (t."config"->>'unfollowMaxMinutes')::integer ELSE 10 END,
    'quickUnfollowMinMs', 30000,
    'quickUnfollowMaxMs', 90000,
    'safetyUnfollowMs', 900000,
    'oneTargetForever', true,
    'freeTargetsOnly', CASE WHEN lower(COALESCE(t."config"->>'onlyFreeTargets', '')) IN ('true', 'false') THEN (t."config"->>'onlyFreeTargets')::boolean ELSE true END
  ),
  t."updatedByUserId",
  t."createdAt",
  CURRENT_TIMESTAMP
FROM "AutomationTask" t
WHERE t."type" = 'sfs_hunter'
  AND t."creatorId" IS NOT NULL
  AND t."clientId" = 'sfs_hunter_settings:' || t."creatorId"
ON CONFLICT ("agencyId", "scopeKey") DO NOTHING;

-- Preserve Alpha's one-target-forever ledger. Without this projection import,
-- a freshly deployed P14 worker could rediscover and process old SFS targets.
INSERT INTO "SfsTargetCandidate" (
  "id", "agencyId", "creatorId", "targetUserId", "username", "state",
  "phase", "eligibilityReason", "usedForever", "generation", "discoveredAt",
  "lastSeenAt", "completedAt", "metadata", "createdAt", "updatedAt"
)
SELECT
  'p14_sfs_used_' || substr(md5(j."agencyId" || ':' || j."creatorId" || ':' || (j."payload"->>'targetUserId')), 1, 20),
  j."agencyId",
  j."creatorId",
  j."payload"->>'targetUserId',
  lower(COALESCE(NULLIF(j."payload"->>'targetUsername', ''), 'legacy_' || (j."payload"->>'targetUserId'))),
  'COMPLETED',
  'DONE',
  'used_forever',
  true,
  1,
  j."createdAt",
  COALESCE(j."completedAt", j."updatedAt"),
  COALESCE(j."completedAt", j."updatedAt"),
  jsonb_build_object('legacyMigration', true, 'sourceJobId', j."id"),
  j."createdAt",
  CURRENT_TIMESTAMP
FROM "AutomationJob" j
WHERE j."type" = 'sfs_hunter'
  AND j."action" = 'sfs_used_marker'
  AND j."status" = 'done'
  AND j."creatorId" IS NOT NULL
  AND NULLIF(j."payload"->>'targetUserId', '') IS NOT NULL
ON CONFLICT ("creatorId", "username") DO UPDATE SET
  "targetUserId" = COALESCE("SfsTargetCandidate"."targetUserId", EXCLUDED."targetUserId"),
  "usedForever" = true,
  "state" = CASE WHEN "SfsTargetCandidate"."state" IN ('UNFOLLOW_DUE', 'UNFOLLOWING', 'RECOVERY_REQUIRED') THEN "SfsTargetCandidate"."state" ELSE 'COMPLETED' END,
  "phase" = CASE WHEN "SfsTargetCandidate"."state" IN ('UNFOLLOW_DUE', 'UNFOLLOWING', 'RECOVERY_REQUIRED') THEN "SfsTargetCandidate"."phase" ELSE 'DONE' END,
  "completedAt" = COALESCE("SfsTargetCandidate"."completedAt", EXCLUDED."completedAt"),
  "updatedAt" = CURRENT_TIMESTAMP;

-- Adopt old scheduled/claimed/running unfollows into the fenced write queue.
INSERT INTO "SfsTargetCandidate" (
  "id", "agencyId", "creatorId", "targetUserId", "username", "state", "phase",
  "creatorFollowing", "usedForever", "generation", "unfollowAt", "discoveredAt",
  "lastSeenAt", "metadata", "createdAt", "updatedAt"
)
SELECT
  'p14_sfs_due_' || substr(md5(j."agencyId" || ':' || j."creatorId" || ':' || COALESCE(j."fanId", j."payload"->>'targetUserId')), 1, 20),
  j."agencyId",
  j."creatorId",
  COALESCE(j."fanId", j."payload"->>'targetUserId'),
  lower(COALESCE(NULLIF(j."payload"->>'targetUsername', ''), 'legacy_' || COALESCE(j."fanId", j."payload"->>'targetUserId'))),
  'UNFOLLOW_DUE',
  'UNFOLLOW',
  true,
  true,
  1,
  j."runAfter",
  j."createdAt",
  j."updatedAt",
  jsonb_build_object('legacyMigration', true, 'sourceJobId', j."id"),
  j."createdAt",
  CURRENT_TIMESTAMP
FROM "AutomationJob" j
WHERE j."type" = 'sfs_hunter'
  AND j."action" = 'sfs_unfollow_due'
  AND j."status" IN ('scheduled', 'claimed', 'running')
  AND j."creatorId" IS NOT NULL
  AND NULLIF(COALESCE(j."fanId", j."payload"->>'targetUserId'), '') IS NOT NULL
ON CONFLICT ("creatorId", "username") DO UPDATE SET
  "targetUserId" = EXCLUDED."targetUserId",
  "state" = 'UNFOLLOW_DUE',
  "phase" = 'UNFOLLOW',
  "creatorFollowing" = true,
  "usedForever" = true,
  "unfollowAt" = EXCLUDED."unfollowAt",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "AutomationDelivery" (
  "id", "agencyId", "creatorId", "moduleKey", "actionType", "targetId",
  "idempotencyKey", "generation", "priority", "payload", "fanId", "status",
  "scheduledAt", "notBefore", "attempts", "maxAttempts", "createdAt", "updatedAt"
)
SELECT
  'p14_sfs_cleanup_' || substr(md5(j."id"), 1, 20),
  j."agencyId",
  j."creatorId",
  'sfs',
  'SFS_UNFOLLOW_TARGET',
  COALESCE(j."fanId", j."payload"->>'targetUserId'),
  'sfs_unfollow:' || j."creatorId" || ':' || COALESCE(j."fanId", j."payload"->>'targetUserId') || ':1',
  1,
  120,
  jsonb_build_object(
    'candidateId', c."id",
    'safetyCleanup', true,
    'legacyMigration', true,
    'sourceJobId', j."id"
  ),
  COALESCE(j."fanId", j."payload"->>'targetUserId'),
  'QUEUED',
  CURRENT_TIMESTAMP,
  COALESCE(j."runAfter", CURRENT_TIMESTAMP),
  0,
  20,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "AutomationJob" j
JOIN "SfsTargetCandidate" c
  ON c."creatorId" = j."creatorId"
 AND c."targetUserId" = COALESCE(j."fanId", j."payload"->>'targetUserId')
WHERE j."type" = 'sfs_hunter'
  AND j."action" = 'sfs_unfollow_due'
  AND j."status" IN ('scheduled', 'claimed', 'running')
  AND j."creatorId" IS NOT NULL
  AND NULLIF(COALESCE(j."fanId", j."payload"->>'targetUserId'), '') IS NOT NULL
ON CONFLICT ("idempotencyKey") DO NOTHING;

UPDATE "SfsTargetCandidate" c
SET
  "safetyUnfollowDeliveryId" = d."id",
  "latestDeliveryId" = d."id",
  "latestActionType" = d."actionType",
  "latestStatus" = d."status",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "AutomationDelivery" d
WHERE d."moduleKey" = 'sfs'
  AND d."actionType" = 'SFS_UNFOLLOW_TARGET'
  AND d."creatorId" = c."creatorId"
  AND d."fanId" = c."targetUserId"
  AND c."state" = 'UNFOLLOW_DUE';

-- No new Alpha SFS jobs may execute after P14. Completion-only HTTP adapters
-- can still drain an already-running desktop request and create a P14 cleanup.
UPDATE "AutomationJob"
SET
  "status" = 'canceled',
  "claimedByDeviceId" = NULL,
  "claimedAt" = NULL,
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "error" = 'P14_LEGACY_SFS_DISABLED',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "type" = 'sfs_hunter'
  AND "status" IN ('scheduled', 'claimed', 'running');
