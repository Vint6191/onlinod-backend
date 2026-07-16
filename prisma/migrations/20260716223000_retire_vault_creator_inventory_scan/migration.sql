-- P17.8.1: Messages is the single creator-media catalog.
-- Retire any durable jobs created by the superseded /vault/media?list=all inventory scanner.
UPDATE "JobInstance"
SET
  "status" = 'CANCELLED',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "lastError" = 'retired: Messages catalog is the authoritative creator-media inventory',
  "claimedAt" = NULL,
  "claimedByDeviceId" = NULL,
  "leaseUntil" = NULL,
  "leaseTokenHash" = NULL,
  "leaseRevision" = "leaseRevision" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "jobKey" = 'vault_creator_inventory_scan'
  AND "status" IN ('SCHEDULED', 'CLAIMED');
