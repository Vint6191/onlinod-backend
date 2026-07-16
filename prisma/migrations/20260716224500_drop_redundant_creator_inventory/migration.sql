-- P17.8.1: Messages is the sole creator-media catalog for Never Used.
-- Cancel any stale jobs from the discarded /vault/media?list=all inventory pass.
UPDATE "JobInstance"
SET
  "status" = 'CANCELLED',
  "completedAt" = CURRENT_TIMESTAMP,
  "lastError" = 'retired: Messages catalog is the sole Never Used candidate inventory',
  "claimedByDeviceId" = NULL,
  "claimedAt" = NULL,
  "leaseUntil" = NULL,
  "leaseTokenHash" = NULL,
  "leaseRevision" = "leaseRevision" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "jobKey" = 'vault_creator_inventory_scan'
  AND "status" IN ('SCHEDULED', 'CLAIMED');

DROP TABLE IF EXISTS "CreatorVaultMediaInventory";
DROP TABLE IF EXISTS "CreatorVaultInventorySnapshot";
