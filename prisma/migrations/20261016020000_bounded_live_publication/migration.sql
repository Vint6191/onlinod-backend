BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL TimeZone = 'UTC';

-- No historical ledger rewrite in a deployment. A resumable publication builds
-- the new layout while the previous published snapshot stays readable.
ALTER TABLE "CreatorEarningsLedgerProof" ADD COLUMN "activeGeneration" text;
ALTER TABLE "CreatorMoneyObservation" ADD COLUMN "coveredGeneration" text;
CREATE TABLE "CreatorEarningsGeneration" (
 id text PRIMARY KEY, "agencyId" text NOT NULL, "creatorId" text NOT NULL,
 "runId" text NOT NULL, "baseGeneration" text, state text NOT NULL DEFAULT 'BUILDING',
 phase text NOT NULL DEFAULT 'COPY', cursor text NOT NULL DEFAULT '',
 "fromAt" timestamp(3) NOT NULL, "throughAt" timestamp(3) NOT NULL, "snapshotAt" timestamp(3) NOT NULL,
 "fullScan" boolean NOT NULL, "legacyPending" boolean NOT NULL DEFAULT false, "observedCount" bigint NOT NULL DEFAULT 0, "invalidCount" bigint NOT NULL DEFAULT 0,
 "oldestAt" timestamp(3), "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "publishedAt" timestamp(3), "retiredAt" timestamp(3),
 CHECK(state IN ('BUILDING','READY','ACTIVE','RETIRED')),
 CHECK(phase IN ('COPY','APPLY','RESOLVE','READY')),
 FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EarningsGeneration_building" ON "CreatorEarningsGeneration"("creatorId") WHERE state IN ('BUILDING','READY');
CREATE INDEX "EarningsGeneration_retired" ON "CreatorEarningsGeneration"("retiredAt",id) WHERE state='RETIRED';
CREATE INDEX "EarningsGeneration_abandoned" ON "CreatorEarningsGeneration"("createdAt",id) WHERE state IN ('BUILDING','READY');
CREATE INDEX "EarningsGeneration_legacy" ON "CreatorEarningsGeneration"("publishedAt",id) WHERE "legacyPending" AND "publishedAt" IS NOT NULL;
CREATE UNIQUE INDEX "EarningsGeneration_active" ON "CreatorEarningsGeneration"("creatorId") WHERE state='ACTIVE';
CREATE INDEX "EarningsGeneration_creator" ON "CreatorEarningsGeneration"("creatorId",state);
CREATE TABLE "CreatorEarningsGenerationEntry" (
 generation text NOT NULL REFERENCES "CreatorEarningsGeneration"(id) ON DELETE CASCADE,
 "transactionId" text NOT NULL, "occurredAt" timestamp(3) NOT NULL,
 category text NOT NULL, "netCents" bigint NOT NULL CHECK("netCents">=0),
 status text NOT NULL CHECK(status IN ('done','loading','undo')), "observedAt" timestamp(3) NOT NULL,
 PRIMARY KEY(generation,"transactionId")
);
CREATE TABLE "CreatorEarningsGenerationHour" (
 generation text NOT NULL REFERENCES "CreatorEarningsGeneration"(id) ON DELETE CASCADE,
 hour timestamp(3) NOT NULL, category text NOT NULL, "netCents" bigint NOT NULL,
 "observedAt" timestamp(3) NOT NULL, PRIMARY KEY(generation,hour,category)
);
CREATE TABLE "CreatorEarningsGenerationDay" (
 generation text NOT NULL REFERENCES "CreatorEarningsGeneration"(id) ON DELETE CASCADE,
 date date NOT NULL, category text NOT NULL, "netCents" bigint NOT NULL,
 "observedAt" timestamp(3) NOT NULL, PRIMARY KEY(generation,date,category)
);
CREATE FUNCTION onlinod_earnings_generation_delta_v1() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE r record; delta bigint;
BEGIN
 -- Deleting retired rows is compaction, not a new monetary event. Aggregate
 -- rows are removed separately in bounded batches.
 IF TG_OP='DELETE' THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND (OLD."occurredAt",OLD.category,OLD."netCents",OLD.status,OLD."observedAt")
   IS NOT DISTINCT FROM (NEW."occurredAt",NEW.category,NEW."netCents",NEW.status,NEW."observedAt") THEN RETURN NULL; END IF;
 FOR r IN SELECT * FROM (VALUES
   (CASE WHEN TG_OP='UPDATE' THEN OLD.generation END,OLD."occurredAt",OLD.category,
      -CASE WHEN OLD.status='undo' THEN 0 ELSE OLD."netCents" END,OLD."observedAt"),
   (NEW.generation,NEW."occurredAt",NEW.category,CASE WHEN NEW.status='undo' THEN 0 ELSE NEW."netCents" END,NEW."observedAt")
 ) AS v(g,at,cat,cents,observed) WHERE g IS NOT NULL LOOP
   INSERT INTO "CreatorEarningsGenerationHour"(generation,hour,category,"netCents","observedAt")
    VALUES(r.g,date_trunc('hour',r.at),r.cat,r.cents,r.observed)
    ON CONFLICT(generation,hour,category) DO UPDATE SET
      "netCents"="CreatorEarningsGenerationHour"."netCents"+EXCLUDED."netCents",
      "observedAt"=GREATEST("CreatorEarningsGenerationHour"."observedAt",EXCLUDED."observedAt");
   INSERT INTO "CreatorEarningsGenerationDay"(generation,date,category,"netCents","observedAt")
    VALUES(r.g,r.at::date,r.cat,r.cents,r.observed)
    ON CONFLICT(generation,date,category) DO UPDATE SET
      "netCents"="CreatorEarningsGenerationDay"."netCents"+EXCLUDED."netCents",
      "observedAt"=GREATEST("CreatorEarningsGenerationDay"."observedAt",EXCLUDED."observedAt");
 END LOOP;
 RETURN NULL;
END $body$;
CREATE TRIGGER onlinod_earnings_generation_delta_v1 AFTER INSERT OR UPDATE ON "CreatorEarningsGenerationEntry"
 FOR EACH ROW EXECUTE FUNCTION onlinod_earnings_generation_delta_v1();

-- A rolling deployment can briefly have a V19 process beside V20. Once a new
-- generation starts, a V19 legacy-only write must fail before ACK, not disappear
-- at the pointer swap. Both versions use the same creator money advisory lock.
CREATE FUNCTION onlinod_earnings_writer_fence_v6() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE creator text;
BEGIN
 creator := CASE WHEN TG_OP='DELETE' THEN OLD."creatorId" ELSE NEW."creatorId" END;
 IF current_setting('onlinod.earnings_writer_generation',true) IS DISTINCT FROM 'v6'
   AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=creator AND "deletedAt" IS NULL)
   AND EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" WHERE "creatorId"=creator AND state IN ('BUILDING','READY','ACTIVE'))
 THEN RAISE EXCEPTION 'EARNINGS_WRITER_UPGRADE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER onlinod_earnings_writer_fence_v6 BEFORE INSERT OR UPDATE OR DELETE ON "CreatorEarningsLedgerEntry"
 FOR EACH ROW EXECUTE FUNCTION onlinod_earnings_writer_fence_v6();
CREATE TRIGGER onlinod_earnings_writer_fence_v6 BEFORE INSERT OR UPDATE OR DELETE ON "CreatorEarningsLedgerProof"
 FOR EACH ROW EXECUTE FUNCTION onlinod_earnings_writer_fence_v6();

-- Keep completed recovery authority independently from disposable intent rows.
CREATE TABLE "CreatorRecoveryWatermark" (
 "creatorId" text NOT NULL, stream text NOT NULL, "throughAt" timestamp(3) NOT NULL,
 PRIMARY KEY("creatorId",stream), FOREIGN KEY("creatorId") REFERENCES "CreatorAccount"(id) ON DELETE CASCADE
);
CREATE INDEX "RecoveryIntent_retention" ON "CreatorRecoveryIntent"("completedAt",id) WHERE status='COMPLETE';
CREATE INDEX "MoneyObservation_retention" ON "CreatorMoneyObservation"("capturedAt",id) WHERE status IN ('APPLIED','COVERED');
CREATE INDEX "MoneyObservation_covered" ON "CreatorMoneyObservation"("coveredGeneration",id) WHERE status='PENDING';
CREATE INDEX "RealtimeReceipt_retention" ON "CreatorRealtimeReceipt"("capturedAt","sessionId",seq);
CREATE INDEX "RealtimeSession_pending_device" ON "CreatorRealtimeSession"("creatorId","deviceId","updatedAt") WHERE "capturedSeq">"ackedSeq";
ALTER TABLE "CreatorRealtimeSession" ADD COLUMN "retiredAt" timestamp(3);
CREATE INDEX "RealtimeSession_retention" ON "CreatorRealtimeSession"("updatedAt",id) WHERE "retiredAt" IS NULL;
ALTER TABLE "CreatorNotificationFrontierPage" ADD COLUMN "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "NotificationFrontier_retention" ON "CreatorNotificationFrontierPage"("createdAt","creatorId",generation,page);
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName",ordinal,"turnCount","lastAdmittedAt")
 VALUES('onlinod_maintenance_v1','liveSyncRetention',28,0,NULL);
CREATE TABLE "CreatorDialogRecoveryRequest" (
 "creatorId" text PRIMARY KEY, "agencyId" text NOT NULL, "lastCoveredAt" timestamp(3),
 "sampleAt" timestamp(3) NOT NULL, "nextCheckAt" timestamp(3) NOT NULL,
 queued boolean NOT NULL DEFAULT true, reason text,
 FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion",revision,"activatedAt","createdAt","updatedAt")
 VALUES ('DIALOG_OFFLINE_RECOVERY','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName",ordinal,"turnCount","lastAdmittedAt")
 SELECT 'onlinod_maintenance_v1',name,ordinal,0,NULL FROM (VALUES
 ('liveSyncRetention_receipts',29),('liveSyncRetention_money',30),('liveSyncRetention_intents',31),
 ('liveSyncRetention_frontiers',32),('liveSyncRetention_sessions',33),('liveSyncRetention_generations',34),
 ('liveSyncRetention_abandoned',35),('liveSyncRetention_legacy',36),('dialogOfflineRecovery',37)
 ) AS lanes(name,ordinal);
COMMIT;
