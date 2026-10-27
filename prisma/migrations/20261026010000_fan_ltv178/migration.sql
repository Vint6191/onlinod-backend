BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL TimeZone = 'UTC';

-- Fan attribution travels with the same verified money revision. Old entries
-- are hydrated only from an exactly matching canonical transaction at adoption.
ALTER TABLE "CreatorEarningsGenerationEntry" ADD COLUMN "fanOnlyFansUserId" text;
ALTER TABLE "CreatorEarningsLedgerEntry" ADD COLUMN "fanOnlyFansUserId" text;

CREATE TABLE "FanLtvState" (
 "creatorId" text PRIMARY KEY, "agencyId" text NOT NULL,
 "sourceKey" text NOT NULL DEFAULT '', stage text NOT NULL DEFAULT 'RESET',
 cursor text NOT NULL DEFAULT '', "upperId" text NOT NULL DEFAULT '',
 "resetStage" integer NOT NULL DEFAULT 0, snapshot jsonb,
 "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE
);
CREATE TABLE "FanLtvChange" (
 "creatorId" text NOT NULL REFERENCES "FanLtvState"("creatorId") ON DELETE CASCADE,
 "transactionId" text NOT NULL, PRIMARY KEY ("creatorId","transactionId")
);
CREATE TABLE "FanLtvReceipt" (
 "creatorId" text NOT NULL REFERENCES "FanLtvState"("creatorId") ON DELETE CASCADE,
 "transactionId" text NOT NULL, value jsonb NOT NULL, "nextDueAt" timestamp(3),
 PRIMARY KEY ("creatorId","transactionId")
);
CREATE INDEX "FanLtvReceipt_due178_idx" ON "FanLtvReceipt"("creatorId","nextDueAt","transactionId") WHERE "nextDueAt" IS NOT NULL;
CREATE TABLE "FanLtvBalance" (
 "creatorId" text NOT NULL REFERENCES "FanLtvState"("creatorId") ON DELETE CASCADE,
 "rangeKey" text NOT NULL, "fanId" text NOT NULL,
 "netCents" bigint NOT NULL CHECK ("netCents" BETWEEN 0 AND 9007199254740991),
 payments bigint NOT NULL CHECK (payments BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY ("creatorId","rangeKey","fanId")
);
CREATE TABLE "FanLtvMetric" (
 "creatorId" text NOT NULL REFERENCES "FanLtvState"("creatorId") ON DELETE CASCADE,
 "rangeKey" text NOT NULL, category text NOT NULL, "values" jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY ("creatorId","rangeKey",category)
);
-- Seven byte prefixes give exact order statistics in at most 7 x 256 probes,
-- independent of fan count. A worker updates these counts in the same commit
-- as fan balances. No all-fan sort runs when a screen is opened.
CREATE TABLE "FanLtvDistribution" (
 "creatorId" text NOT NULL REFERENCES "FanLtvState"("creatorId") ON DELETE CASCADE,
 prefix text NOT NULL CHECK (length(prefix) IN (2,4,6,8,10,12,14)),
 count bigint NOT NULL CHECK (count BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY ("creatorId",prefix)
);
CREATE FUNCTION onlinod_fan_ltv_writer178() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 IF current_setting('onlinod.fan_ltv_writer',true) IS DISTINCT FROM '178' THEN
  RAISE EXCEPTION 'FAN_LTV_WRITER_REQUIRED';
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER "FanLtvReceipt_writer178" BEFORE INSERT OR UPDATE ON "FanLtvReceipt" FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_writer178();
CREATE TRIGGER "FanLtvBalance_writer178" BEFORE INSERT OR UPDATE ON "FanLtvBalance" FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_writer178();
CREATE TRIGGER "FanLtvMetric_writer178" BEFORE INSERT OR UPDATE ON "FanLtvMetric" FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_writer178();
CREATE TRIGGER "FanLtvDistribution_writer178" BEFORE INSERT OR UPDATE ON "FanLtvDistribution" FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_writer178();

INSERT INTO "Phase2WorkGenerationAuthority"
 ("workClass","activeGeneration","projectionVersion",revision,"activatedAt","createdAt","updatedAt")
 VALUES ('FAN_LTV_PROJECTION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "MaintenanceAdmissionClassState" (generation,"laneName",ordinal,"turnCount","admissionSequence")
 VALUES ('onlinod_maintenance_v1','fanLtvProjection',40,0,0);

CREATE FUNCTION onlinod_fan_ltv_wake178(a text,c text,t text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
 INSERT INTO "FanLtvState"("agencyId","creatorId") VALUES(a,c) ON CONFLICT("creatorId") DO NOTHING;
 IF t IS NOT NULL THEN
  INSERT INTO "FanLtvChange"("creatorId","transactionId") VALUES(c,t) ON CONFLICT DO NOTHING;
 END IF;
 PERFORM phase2_publish_domain_work(a,'FAN_LTV_PROJECTION','CreatorAccount',c,c,c,NULL,NULL,NULL,0,clock_timestamp());
END $fn$;
CREATE FUNCTION onlinod_fan_ltv_source178() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE r jsonb; a text; c text;
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='CreatorEarningsLedgerProof' THEN
  PERFORM onlinod_fan_ltv_wake178(r->>'agencyId',r->>'creatorId'); RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='CreatorEarningsGenerationEntry' THEN
  SELECT g."agencyId",g."creatorId" INTO a,c FROM "CreatorEarningsGeneration" g
   JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=g."creatorId" AND p."activeGeneration"=g.id
   WHERE g.id=r->>'generation';
 ELSE
  a:=r->>'agencyId';c:=r->>'creatorId';
  IF EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=c AND "activeGeneration" IS NOT NULL) THEN RETURN NULL; END IF;
 END IF;
 IF c IS NOT NULL THEN PERFORM onlinod_fan_ltv_wake178(a,c,r->>'transactionId'); END IF;
 RETURN NULL;
END $fn$;
CREATE TRIGGER "FanLtv_generation178" AFTER INSERT OR UPDATE OR DELETE ON "CreatorEarningsGenerationEntry" FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_source178();
CREATE TRIGGER "FanLtv_ledger178" AFTER INSERT OR UPDATE OR DELETE ON "CreatorEarningsLedgerEntry" FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_source178();
CREATE TRIGGER "FanLtv_publication178" AFTER INSERT OR UPDATE ON "CreatorEarningsLedgerProof" FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_source178();
COMMIT;
