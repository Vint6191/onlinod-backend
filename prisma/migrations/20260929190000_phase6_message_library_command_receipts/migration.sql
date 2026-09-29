CREATE TABLE "MessageLibraryCommandReceipt" (
 "id" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "creatorId" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "status" TEXT NOT NULL,
 "result" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MessageLibraryCommandReceipt_status_check" CHECK ("status" IN ('COMMITTED','ABANDONED')),
 CONSTRAINT "MessageLibraryCommandReceipt_result_bound" CHECK (octet_length("result"::text)<=4194304)
);
CREATE INDEX "MessageLibraryCommandReceipt_agencyId_id_idx" ON "MessageLibraryCommandReceipt"("agencyId","id");
