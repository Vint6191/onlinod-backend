BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL TimeZone = 'UTC';
CREATE TABLE "CreatorLiveSync" (
 "creatorId" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL,
 "lastCapturedAt" TIMESTAMP(3), "lastDeliveredAt" TIMESTAMP(3), "shortGapFrom" TIMESTAMP(3), "shortGapTo" TIMESTAMP(3),
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "CreatorLiveSync"("creatorId","agencyId","lastCapturedAt")
 SELECT "creatorId","agencyId",CASE WHEN "lastRealtimeEventAt"<=clock_timestamp()+interval '30 seconds'
   THEN "lastRealtimeEventAt" ELSE NULL END FROM "TeamObservationState";
CREATE TABLE "CreatorRealtimeSession" (
 id TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
 "deviceId" TEXT NOT NULL, "memberId" TEXT NOT NULL, "accessEpoch" INTEGER NOT NULL,
 incarnation TEXT NOT NULL, "capturedSeq" BIGINT NOT NULL DEFAULT 0, "ackedSeq" BIGINT NOT NULL DEFAULT 0,
 "lossAt" TIMESTAMP(3),"lossRevision" INTEGER NOT NULL DEFAULT 0,"resolvedLossRevision" INTEGER NOT NULL DEFAULT 0,
 "capturedAt" TIMESTAMP(3), loss BOOLEAN NOT NULL DEFAULT false,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK("capturedSeq">=0 AND "ackedSeq">=0),
 UNIQUE("creatorId","deviceId",incarnation),
 FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorRealtimeSession_creator_updated_idx" ON "CreatorRealtimeSession"("creatorId","updatedAt");
CREATE TABLE "CreatorRealtimeReceipt" (
 "sessionId" TEXT NOT NULL REFERENCES "CreatorRealtimeSession"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 seq BIGINT NOT NULL CHECK(seq>0), digest TEXT NOT NULL, "capturedAt" TIMESTAMP(3) NOT NULL,
 PRIMARY KEY("sessionId",seq)
);
CREATE TABLE "CreatorRecoveryIntent" (
 id TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
 stream TEXT NOT NULL CHECK(stream IN ('notifications','financial','campaigns','subscribers')),
 reason TEXT NOT NULL CHECK(reason IN ('OFFLINE_GAP','CAPTURE_LOSS')),
 "gapFrom" TIMESTAMP(3) NOT NULL, "targetAt" TIMESTAMP(3) NOT NULL,
 "policyVersion" INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','COMPLETE')),
 "jobId" TEXT, "completedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK("targetAt">="gapFrom"),
 FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorRecoveryIntent_pending_idx" ON "CreatorRecoveryIntent"("creatorId",stream,status,"targetAt",id);
ALTER TABLE "CreatorNotificationSyncState" ADD COLUMN "frontierReceipt" JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE "CreatorNotificationFrontierPage" (
 "creatorId" TEXT NOT NULL, "agencyId" TEXT NOT NULL, generation TEXT NOT NULL, page INTEGER NOT NULL,
 "cursorStart" TEXT NOT NULL, "cursorEnd" TEXT, digest TEXT NOT NULL,
 PRIMARY KEY("creatorId",generation,page),
 UNIQUE("creatorId",generation,"cursorStart"),
 FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
UPDATE "AnalyticsCollectionDemand" SET "completedAt"=CURRENT_TIMESTAMP,"claimToken"=NULL,"claimUntil"=NULL,"claimedRevision"=NULL,
 "requestRevision"="requestRevision"+1 WHERE reason='HOME_AUTOMATIC' AND "completedAt" IS NULL;

CREATE TABLE "CreatorEarningsLedgerProof" (
  "creatorId" text PRIMARY KEY,"agencyId" text NOT NULL,"fromAt" timestamp(3) NOT NULL,
  "throughAt" timestamp(3) NOT NULL,generation text NOT NULL,
  FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "CreatorEarningsLedgerEntry" (
  "agencyId" text NOT NULL,"creatorId" text NOT NULL,"transactionId" text NOT NULL,
  "occurredAt" timestamp(3) NOT NULL,category text NOT NULL DEFAULT 'other',"netCents" bigint NOT NULL CHECK("netCents">=0),
  status text NOT NULL CHECK(status IN ('done','loading','undo')),"observedAt" timestamp(3) NOT NULL,
  PRIMARY KEY("creatorId","transactionId"),
  FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "EarningsLedger_creator_date" ON "CreatorEarningsLedgerEntry"("creatorId","occurredAt");
CREATE TABLE "CreatorMoneyObservation" (
  id text PRIMARY KEY,"agencyId" text NOT NULL,"creatorId" text NOT NULL,"transactionId" text,
  "occurredAt" timestamp(3) NOT NULL,"capturedAt" timestamp(3) NOT NULL,
  status text NOT NULL CHECK(status IN ('PENDING','APPLIED','COVERED')),reason text,"resolvedAt" timestamp(3),
  FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MoneyObservation_pending" ON "CreatorMoneyObservation"("creatorId",status,"occurredAt");
-- Existing chart publication remains readable until the one-time ledger baseline completes.

CREATE TABLE "CreatorEarningsLedgerHour" (
 "agencyId" text NOT NULL,"creatorId" text NOT NULL,hour timestamp(3) NOT NULL,category text NOT NULL DEFAULT 'other',
 "netCents" bigint NOT NULL,"observedAt" timestamp(3) NOT NULL,
 PRIMARY KEY("creatorId",hour,category),
 FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "CreatorEarningsLedgerHour"("agencyId","creatorId",hour,category,"netCents","observedAt")
SELECT "agencyId","creatorId",date_trunc('hour',"occurredAt"),category,SUM(CASE WHEN status='undo' THEN 0 ELSE "netCents" END),MAX("observedAt")
FROM "CreatorEarningsLedgerEntry" GROUP BY "agencyId","creatorId",date_trunc('hour',"occurredAt"),category;
CREATE FUNCTION onlinod_live_earnings_hour_v1() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') AND EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=OLD."creatorId" AND "agencyId"=OLD."agencyId") THEN
  INSERT INTO "CreatorEarningsLedgerHour"("agencyId","creatorId",hour,category,"netCents","observedAt")
  VALUES(OLD."agencyId",OLD."creatorId",date_trunc('hour',OLD."occurredAt"),OLD.category,-CASE WHEN OLD.status='undo' THEN 0 ELSE OLD."netCents" END,OLD."observedAt")
  ON CONFLICT("creatorId",hour,category) DO UPDATE SET "netCents"="CreatorEarningsLedgerHour"."netCents"+EXCLUDED."netCents",
    "observedAt"=GREATEST("CreatorEarningsLedgerHour"."observedAt",EXCLUDED."observedAt");
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  INSERT INTO "CreatorEarningsLedgerHour"("agencyId","creatorId",hour,category,"netCents","observedAt")
  VALUES(NEW."agencyId",NEW."creatorId",date_trunc('hour',NEW."occurredAt"),NEW.category,CASE WHEN NEW.status='undo' THEN 0 ELSE NEW."netCents" END,NEW."observedAt")
  ON CONFLICT("creatorId",hour,category) DO UPDATE SET "netCents"="CreatorEarningsLedgerHour"."netCents"+EXCLUDED."netCents",
    "observedAt"=GREATEST("CreatorEarningsLedgerHour"."observedAt",EXCLUDED."observedAt");
 END IF;
 RETURN NULL;
END $body$;
CREATE TRIGGER onlinod_live_earnings_hour_v1 AFTER INSERT OR UPDATE OR DELETE ON "CreatorEarningsLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION onlinod_live_earnings_hour_v1();
COMMIT;
