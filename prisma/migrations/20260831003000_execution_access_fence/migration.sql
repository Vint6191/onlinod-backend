ALTER TABLE "JobInstance"
  ADD COLUMN IF NOT EXISTS "leaseMemberId" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseAccessEpoch" INTEGER;

ALTER TABLE "AutomationDelivery"
  ADD COLUMN IF NOT EXISTS "leaseMemberId" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseAccessEpoch" INTEGER;

-- Preserve already-running leases across deploy only when their claimant still
-- maps to one active agency membership. New claims always write the fence.
UPDATE "JobInstance" AS j
SET "leaseMemberId" = m."id",
    "leaseAccessEpoch" = m."accessEpoch"
FROM "WorkerDevice" AS d
JOIN "AgencyMember" AS m
  ON m."userId" = d."userId"
 AND m."agencyId" = d."agencyId"
 AND m."deletedAt" IS NULL
 AND m."deactivatedAt" IS NULL
WHERE j."claimedByDeviceId" = d."id"
  AND j."status" = 'CLAIMED'
  AND j."leaseMemberId" IS NULL;

UPDATE "AutomationDelivery" AS a
SET "leaseMemberId" = m."id",
    "leaseAccessEpoch" = m."accessEpoch"
FROM "WorkerDevice" AS d
JOIN "AgencyMember" AS m
  ON m."userId" = d."userId"
 AND m."agencyId" = d."agencyId"
 AND m."deletedAt" IS NULL
 AND m."deactivatedAt" IS NULL
WHERE a."claimedByDeviceId" = d."id"
  AND a."status" IN ('CLAIMED', 'RUNNING')
  AND a."leaseMemberId" IS NULL;
