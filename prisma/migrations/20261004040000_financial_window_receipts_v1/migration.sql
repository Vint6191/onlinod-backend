BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE "CreatorFinancialCollectionState"
 ADD COLUMN "receiptCoverageVersion" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "coverageThrough" TIMESTAMP(3),ADD COLUMN "recentRangeFrom" TIMESTAMP(3),ADD COLUMN "recentRangeTo" TIMESTAMP(3),
 ADD COLUMN "historyAuditCursor" TIMESTAMP(3),ADD COLUMN "historyAuditCycleStartedAt" TIMESTAMP(3),
 ADD COLUMN "historyAuditObservedAt" TIMESTAMP(3),ADD COLUMN "historyAuditCompletedAt" TIMESTAMP(3);
CREATE TABLE "FinancialReceiptRun"(
 id TEXT PRIMARY KEY,"jobId" TEXT NOT NULL,"agencyId" TEXT NOT NULL,"creatorId" TEXT NOT NULL,generation TEXT NOT NULL,
 windows JSONB NOT NULL,cursor JSONB NOT NULL,proof JSONB NOT NULL,"compactedAt" TIMESTAMP(3),"detailsRetiredAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("jobId",generation),FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "FinancialReceiptRun_agencyId_creatorId_id_idx" ON "FinancialReceiptRun"("agencyId","creatorId",id);
CREATE INDEX "FinancialReceiptRun_retention_idx" ON "FinancialReceiptRun"("creatorId","createdAt",id);
CREATE TABLE "FinancialPageReceipt"(
 "runId" TEXT NOT NULL,"windowIndex" INTEGER NOT NULL,page INTEGER NOT NULL,"markerStart" VARCHAR(220) NOT NULL,"markerEnd" VARCHAR(220),
 "sourceHasMore" BOOLEAN NOT NULL,"payloadHash" VARCHAR(64) NOT NULL,received INTEGER NOT NULL,rejected INTEGER NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("runId","windowIndex",page),UNIQUE("runId","windowIndex","markerStart"),
 FOREIGN KEY("runId") REFERENCES "FinancialReceiptRun"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 CHECK(page>0 AND "windowIndex">=0 AND "windowIndex"<2 AND received>=0 AND received<=100 AND rejected>=0 AND rejected<=100)
);
CREATE TABLE "FinancialObservedFact"(
 "runId" TEXT NOT NULL,"windowIndex" INTEGER NOT NULL,"externalId" VARCHAR(220) NOT NULL,"occurredAt" TIMESTAMP(3) NOT NULL,value JSONB NOT NULL,
 PRIMARY KEY("runId","windowIndex","externalId"),FOREIGN KEY("runId") REFERENCES "FinancialReceiptRun"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "FinancialObservedFact_time_idx" ON "FinancialObservedFact"("runId","windowIndex","occurredAt","externalId");
CREATE FUNCTION "financial_receipt_writer_v1"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('onlinod.financial_receipts_v1',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'FINANCIAL_RECEIPT_WRITER_REQUIRED'; END IF;
 IF TG_TABLE_NAME='FinancialPageReceipt' AND TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'FINANCIAL_PAGE_RECEIPT_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='FinancialReceiptRun' AND TG_OP='UPDATE' THEN
   IF (NEW.id,NEW."jobId",NEW."agencyId",NEW."creatorId",NEW.generation,NEW.windows) IS DISTINCT FROM (OLD.id,OLD."jobId",OLD."agencyId",OLD."creatorId",OLD.generation,OLD.windows) THEN RAISE EXCEPTION 'FINANCIAL_RUN_SCOPE_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "FinancialReceiptRun_writer_v1" BEFORE INSERT OR UPDATE ON "FinancialReceiptRun" FOR EACH ROW EXECUTE FUNCTION "financial_receipt_writer_v1"();
CREATE TRIGGER "FinancialPageReceipt_writer_v1" BEFORE INSERT OR UPDATE ON "FinancialPageReceipt" FOR EACH ROW EXECUTE FUNCTION "financial_receipt_writer_v1"();
CREATE TRIGGER "FinancialObservedFact_writer_v1" BEFORE INSERT OR UPDATE ON "FinancialObservedFact" FOR EACH ROW EXECUTE FUNCTION "financial_receipt_writer_v1"();
CREATE FUNCTION "financial_receipt_job_guard_v1"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."jobKey"<>'financial_transactions_scan' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.params->>'financialReceiptVersion'='1' AND NEW.params->>'financialReceiptVersion' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'FINANCIAL_RECEIPT_PROTOCOL_DOWNGRADE'; END IF;
 IF NEW.params->>'financialReceiptVersion'='1' AND NEW.status IN ('CLAIMED','PUBLISHING','DONE')
   AND (TG_OP='INSERT' OR (NEW.status,NEW."leaseRevision",NEW.params,NEW.continuation) IS DISTINCT FROM (OLD.status,OLD."leaseRevision",OLD.params,OLD.continuation))
   AND current_setting('onlinod.financial_receipts_v1',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'FINANCIAL_RECEIPT_EXECUTOR_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "JobInstance_financial_receipt_v1" BEFORE INSERT OR UPDATE ON "JobInstance" FOR EACH ROW EXECUTE FUNCTION "financial_receipt_job_guard_v1"();
CREATE FUNCTION "financial_receipt_coverage_guard_v1"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='COMPLETE' AND (TG_OP='INSERT' OR (NEW.status,NEW."baselineVerifiedAt",NEW."lastCatchupCompletedAt",NEW."activeGeneration") IS DISTINCT FROM (OLD.status,OLD."baselineVerifiedAt",OLD."lastCatchupCompletedAt",OLD."activeGeneration")) THEN
   IF current_setting('onlinod.financial_receipts_v1',true) IS DISTINCT FROM '1' OR NEW."receiptCoverageVersion"<>1
     OR NOT EXISTS(SELECT 1 FROM "FinancialReceiptRun" r WHERE r."jobId"=NEW."sourceJobId" AND r.generation=NEW."activeGeneration" AND r."agencyId"=NEW."agencyId" AND r."creatorId"=NEW."creatorId" AND r.cursor->>'phase'='done' AND r.proof->>'complete'='true')
   THEN RAISE EXCEPTION 'FINANCIAL_RECEIPT_COVERAGE_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "CreatorFinancialCollectionState_receipt_v1" BEFORE INSERT OR UPDATE ON "CreatorFinancialCollectionState" FOR EACH ROW EXECUTE FUNCTION "financial_receipt_coverage_guard_v1"();
COMMIT;
