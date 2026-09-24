BEGIN;
SET LOCAL lock_timeout = '5s';

-- One bounded global traversal. No tenant/history backfill or table rewrite.
CREATE TABLE "BillingReconciliationCursor" (
  "id" TEXT PRIMARY KEY,
  "lastAgencyId" TEXT,
  "ownerToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "cycle" INTEGER NOT NULL DEFAULT 0,
  "lastCompletedAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastFailedAgencyId" TEXT,
  "lastErrorCode" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingReconciliationCursor_owner_lease" CHECK (("ownerToken" IS NULL) = ("leaseUntil" IS NULL)),
  CONSTRAINT "BillingReconciliationCursor_nonnegative" CHECK ("cycle" >= 0 AND "failureCount" >= 0)
);
INSERT INTO "BillingReconciliationCursor" ("id") VALUES ('billing_aggregate_v1');
COMMIT;
