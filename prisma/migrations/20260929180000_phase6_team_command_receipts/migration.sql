-- Receipts live for the agency lifetime. No expiry can resurrect an old command.
CREATE TABLE "TeamMutationReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "authorizationScope" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMutationReceipt_status_check" CHECK ("status" IN ('COMMITTED','ABANDONED')),
  CONSTRAINT "TeamMutationReceipt_result_bound" CHECK (octet_length("result"::text) <= 2097152),
  CONSTRAINT "TeamMutationReceipt_scope_bound" CHECK (octet_length("authorizationScope"::text) <= 2097152)
);
CREATE INDEX "TeamMutationReceipt_agencyId_id_idx" ON "TeamMutationReceipt"("agencyId","id");
