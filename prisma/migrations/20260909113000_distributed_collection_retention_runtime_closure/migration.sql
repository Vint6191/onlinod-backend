-- Phase 1 distributed control closure.
-- Retention coordination must survive Prisma connection pooling and process
-- crashes without relying on a session-level advisory lock held by an unknown
-- physical connection.
CREATE TABLE "RetentionSweepLease" (
    "key" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RetentionSweepLease_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "RetentionSweepLease_leaseUntil_idx" ON "RetentionSweepLease"("leaseUntil");

-- Adopt already queued/running Analytics work onto a PostgreSQL-owned ordering
-- clock without changing its generation identity or provider traversal token.
-- JobInstance.createdAt is DB-generated and therefore safe across replicas.
UPDATE "JobInstance"
SET "params" = jsonb_set(
  COALESCE("params", '{}'::jsonb),
  '{authorityRequestedAt}',
  to_jsonb(to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  true
)
WHERE "jobKey" = 'fetch_earnings'
  AND "status" IN ('SCHEDULED', 'CLAIMED', 'PAUSED');

UPDATE "JobInstance"
SET "params" = jsonb_set(
  COALESCE("params", '{}'::jsonb),
  '{collectionAuthorityRequestedAt}',
  to_jsonb(to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  true
)
WHERE "jobKey" IN ('financial_transactions_scan', 'fetch_campaigns', 'catchup_notifications_scan')
  AND "status" IN ('SCHEDULED', 'CLAIMED', 'PAUSED');

-- If a current collector state still points at an adopted job/generation, use
-- that job's DB creation clock as the durable ordering timestamp. Source-window
-- jobs that were already CLAIMED are fenced and restarted below before execution
-- can continue under the adopted DB-owned boundary.
UPDATE "CreatorFinancialCollectionState" AS s
SET "activeRequestedAt" = j."createdAt"
FROM "JobInstance" AS j
WHERE s."sourceJobId" = j."id"
  AND s."activeGeneration" IS NOT NULL
  AND s."activeGeneration" = (j."params"->>'collectionGeneration')
  AND j."jobKey" = 'financial_transactions_scan';

UPDATE "CreatorCampaignCollectionState" AS s
SET "activeRequestedAt" = j."createdAt"
FROM "JobInstance" AS j
WHERE s."sourceJobId" = j."id"
  AND s."activeGeneration" IS NOT NULL
  AND s."activeGeneration" = (j."params"->>'collectionGeneration')
  AND j."jobKey" = 'fetch_campaigns';

UPDATE "CreatorNotificationSyncState" AS s
SET "activeRequestedAt" = j."createdAt"
FROM "JobInstance" AS j
WHERE s."sourceJobId" = j."id"
  AND s."activeGeneration" IS NOT NULL
  AND s."activeGeneration" = (j."params"->>'collectionGeneration')
  AND j."jobKey" = 'catchup_notifications_scan';

-- Any unmatched legacy process-clock marker that is still in the future is
-- fail-closed adopted immediately behind the migration's DB clock. A new
-- DB-authoritative command can therefore repair it without waiting for wall
-- time to catch up.
UPDATE "CreatorFinancialCollectionState"
SET "activeRequestedAt" = clock_timestamp() - INTERVAL '1 millisecond'
WHERE "activeRequestedAt" > clock_timestamp();

UPDATE "CreatorCampaignCollectionState"
SET "activeRequestedAt" = clock_timestamp() - INTERVAL '1 millisecond'
WHERE "activeRequestedAt" > clock_timestamp();

UPDATE "CreatorNotificationSyncState"
SET "activeRequestedAt" = clock_timestamp() - INTERVAL '1 millisecond'
WHERE "activeRequestedAt" > clock_timestamp();

-- Earnings ordering lives on the canonical daily row rather than a collector
-- state table. Prefer the DB-created source job for future-poisoned rows when
-- it still exists; otherwise adopt the row just behind the migration DB clock.
UPDATE "CreatorEarningsDaily" AS d
SET "sourceScanRequestedAt" = j."createdAt"
FROM "JobInstance" AS j
WHERE d."sourceJobId" = j."id"
  AND j."jobKey" = 'fetch_earnings'
  AND d."sourceScanRequestedAt" > clock_timestamp();

UPDATE "CreatorEarningsDaily"
SET "sourceScanRequestedAt" = clock_timestamp() - INTERVAL '1 millisecond'
WHERE "sourceScanRequestedAt" > clock_timestamp();

-- Existing source-window contracts need stricter adoption than ordering
-- timestamps. A CLAIMED worker may already be traversing the old provider
-- boundary in memory, while completion reloads JobInstance.params from the DB.
-- Rewriting that boundary under the same lease could therefore prove work the
-- worker never performed. SCHEDULED rows may be rewritten in place; CLAIMED rows
-- are fenced (leaseRevision++) and restarted from the beginning. PAUSED rows stay
-- PAUSED, but their stale continuation/progress is cleared so an explicit resume
-- restarts from the DB-owned boundary instead of silently auto-resuming.
UPDATE "JobInstance"
SET "params" = jsonb_set(
  jsonb_set(
    COALESCE("params", '{}'::jsonb),
    '{initialMarker}',
    to_jsonb(FLOOR(EXTRACT(EPOCH FROM "createdAt"))::bigint),
    true
  ),
  '{endDate}',
  to_jsonb(to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS')),
  true
)
WHERE "jobKey" = 'financial_transactions_scan'
  AND "status" = 'SCHEDULED';

UPDATE "JobInstance"
SET "params" = jsonb_set(
      jsonb_set(
        COALESCE("params", '{}'::jsonb),
        '{initialMarker}',
        to_jsonb(FLOOR(EXTRACT(EPOCH FROM "createdAt"))::bigint),
        true
      ),
      '{endDate}',
      to_jsonb(to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS')),
      true
    ),
    "status" = 'SCHEDULED',
    "nextRunAt" = clock_timestamp() + INTERVAL '30 seconds',
    "claimedAt" = NULL,
    "claimedByDeviceId" = NULL,
    "leaseUntil" = NULL,
    "leaseTokenHash" = NULL,
    "leaseMemberId" = NULL,
    "leaseAccessEpoch" = NULL,
    "leaseRevision" = "leaseRevision" + 1,
    "workId" = NULL,
    "continuation" = NULL,
    "progress" = NULL,
    "lastProgressAt" = NULL,
    "startedAt" = NULL,
    "completedAt" = NULL,
    "result" = NULL,
    "lastError" = 'analytics_db_time_contract_adopted'
WHERE "jobKey" = 'financial_transactions_scan'
  AND "status" = 'CLAIMED';

-- A PAUSED job has no live worker to fence, but its old continuation was built
-- against the pre-cutover source boundary. Preserve the operator pause while
-- clearing resumable traversal state so an explicit future resume restarts
-- from the DB-authoritative boundary instead of silently auto-resuming now.
UPDATE "JobInstance"
SET "params" = jsonb_set(
      jsonb_set(
        COALESCE("params", '{}'::jsonb),
        '{initialMarker}',
        to_jsonb(FLOOR(EXTRACT(EPOCH FROM "createdAt"))::bigint),
        true
      ),
      '{endDate}',
      to_jsonb(to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS')),
      true
    ),
    "claimedAt" = NULL,
    "claimedByDeviceId" = NULL,
    "leaseUntil" = NULL,
    "leaseTokenHash" = NULL,
    "leaseMemberId" = NULL,
    "leaseAccessEpoch" = NULL,
    "leaseRevision" = "leaseRevision" + 1,
    "workId" = NULL,
    "continuation" = NULL,
    "progress" = NULL,
    "lastProgressAt" = NULL,
    "startedAt" = NULL,
    "completedAt" = NULL,
    "result" = NULL,
    "lastError" = 'analytics_db_time_contract_adopted_paused'
WHERE "jobKey" = 'financial_transactions_scan'
  AND "status" = 'PAUSED';

UPDATE "JobInstance"
SET "params" = jsonb_set(
  COALESCE("params", '{}'::jsonb),
  '{to}',
  to_jsonb(to_char("createdAt" + INTERVAL '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  true
)
WHERE "jobKey" = 'catchup_notifications_scan'
  AND "status" = 'SCHEDULED';

UPDATE "JobInstance"
SET "params" = jsonb_set(
      COALESCE("params", '{}'::jsonb),
      '{to}',
      to_jsonb(to_char("createdAt" + INTERVAL '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      true
    ),
    "status" = 'SCHEDULED',
    "nextRunAt" = clock_timestamp() + INTERVAL '30 seconds',
    "claimedAt" = NULL,
    "claimedByDeviceId" = NULL,
    "leaseUntil" = NULL,
    "leaseTokenHash" = NULL,
    "leaseMemberId" = NULL,
    "leaseAccessEpoch" = NULL,
    "leaseRevision" = "leaseRevision" + 1,
    "workId" = NULL,
    "continuation" = NULL,
    "progress" = NULL,
    "lastProgressAt" = NULL,
    "startedAt" = NULL,
    "completedAt" = NULL,
    "result" = NULL,
    "lastError" = 'analytics_db_time_contract_adopted'
WHERE "jobKey" = 'catchup_notifications_scan'
  AND "status" = 'CLAIMED';

UPDATE "JobInstance"
SET "params" = jsonb_set(
      COALESCE("params", '{}'::jsonb),
      '{to}',
      to_jsonb(to_char("createdAt" + INTERVAL '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      true
    ),
    "claimedAt" = NULL,
    "claimedByDeviceId" = NULL,
    "leaseUntil" = NULL,
    "leaseTokenHash" = NULL,
    "leaseMemberId" = NULL,
    "leaseAccessEpoch" = NULL,
    "leaseRevision" = "leaseRevision" + 1,
    "workId" = NULL,
    "continuation" = NULL,
    "progress" = NULL,
    "lastProgressAt" = NULL,
    "startedAt" = NULL,
    "completedAt" = NULL,
    "result" = NULL,
    "lastError" = 'analytics_db_time_contract_adopted_paused'
WHERE "jobKey" = 'catchup_notifications_scan'
  AND "status" = 'PAUSED';

-- Earnings ranges are calendar windows computed by the planner, so they cannot
-- be safely reconstructed from JobInstance.createdAt inside SQL. Fence every
-- pre-cutover active earnings job and let the DB-clock planner recompute the
-- exact missing window. Terminal idempotency rows are intentionally reusable.
UPDATE "JobInstance"
SET "status" = 'CANCELLED',
    "completedAt" = clock_timestamp(),
    "claimedAt" = NULL,
    "claimedByDeviceId" = NULL,
    "leaseUntil" = NULL,
    "leaseTokenHash" = NULL,
    "leaseMemberId" = NULL,
    "leaseAccessEpoch" = NULL,
    "leaseRevision" = "leaseRevision" + 1,
    "workId" = NULL,
    "continuation" = NULL,
    "progress" = NULL,
    "lastProgressAt" = NULL,
    "lastError" = 'analytics_db_time_contract_replan_required'
WHERE "jobKey" = 'fetch_earnings'
  AND "status" IN ('SCHEDULED', 'CLAIMED', 'PAUSED');

-- The old distributed sweep lease was also process-clock based. Do not
-- preempt a healthy in-flight sweep during rolling deploy; only clamp a lease
-- that is impossible under the normal 15-minute lease horizon and is therefore
-- demonstrably future-poisoned by the old process clock.
UPDATE "AnalyticsCollectionLease"
SET "leaseUntil" = clock_timestamp() - INTERVAL '1 millisecond'
WHERE "completedAt" IS NULL
  AND "leaseUntil" > clock_timestamp() + INTERVAL '20 minutes';
