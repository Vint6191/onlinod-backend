-- Audit 13 / Execution Commit Authority / Closure 3
--
-- 1. Retire the disconnected legacy Presence execution generation without
--    dropping retained Presence facts/tables in this authority closure.
-- 2. Give SFS discovery an explicit observation-time authority clock.

ALTER TABLE "SfsTargetCandidate"
  ADD COLUMN "discoveryObservedAt" TIMESTAMP(3),
  ADD COLUMN "discoverySourceJobId" TEXT;

-- Legacy presence jobs were never claimable by the authoritative Desktop job
-- catalog. Retire any non-terminal rows so deployment does not preserve an
-- impossible scheduled workflow after its producers/routes are removed.
UPDATE "JobInstance"
SET
  "status" = 'FAILED',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "lastError" = 'LEGACY_PRESENCE_ORCHESTRATION_RETIRED',
  "claimedAt" = NULL,
  "claimedByDeviceId" = NULL,
  "leaseUntil" = NULL,
  "leaseTokenHash" = NULL,
  "leaseMemberId" = NULL,
  "leaseAccessEpoch" = NULL,
  "workId" = NULL,
  "leaseRevision" = "leaseRevision" + 1
WHERE "jobKey" = 'refresh_online_presence'
  AND "status" IN ('SCHEDULED', 'CLAIMED');
