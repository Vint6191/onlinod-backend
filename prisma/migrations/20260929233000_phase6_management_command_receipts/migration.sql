CREATE TABLE "ManagementCommandReceipt" (
 "id" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "action" TEXT NOT NULL, "targetId" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
 "status" TEXT NOT NULL, "reference" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ManagementCommandReceipt_status_check" CHECK ("status" IN ('COMMITTED','ABANDONED')),
 CONSTRAINT "ManagementCommandReceipt_reference_bound" CHECK (octet_length("reference"::text)<=8192)
);
CREATE INDEX "ManagementCommandReceipt_agencyId_id_idx" ON "ManagementCommandReceipt"("agencyId","id");
