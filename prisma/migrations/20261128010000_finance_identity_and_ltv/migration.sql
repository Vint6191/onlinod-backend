BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "TeamTipAlias" (
  "agencyId" TEXT NOT NULL,"creatorId" TEXT NOT NULL,namespace TEXT NOT NULL,"externalId" TEXT NOT NULL,"rootId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamTipAlias_pkey" PRIMARY KEY ("agencyId","creatorId",namespace,"externalId"),
  CONSTRAINT "TeamTipAlias_namespace_check" CHECK(namespace IN ('creator_tip','notification','transaction','event')),
  CONSTRAINT "TeamTipAlias_scope_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TeamTipAlias_rootId_idx" ON "TeamTipAlias"("rootId");
CREATE FUNCTION onlinod_guard_team_tip_identity_v4() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE matches_tip boolean;
BEGIN
 IF TG_TABLE_NAME='TeamTipAlias' THEN
  IF TG_OP='UPDATE' AND ROW(NEW."agencyId",NEW."creatorId",NEW.namespace,NEW."externalId",NEW."rootId")
    IS DISTINCT FROM ROW(OLD."agencyId",OLD."creatorId",OLD.namespace,OLD."externalId",OLD."rootId")
  THEN RAISE EXCEPTION 'TEAM_TIP_ALIAS_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM "TeamTipLedger" r WHERE r.id=NEW."rootId"
    AND (r."agencyId" IS DISTINCT FROM NEW."agencyId" OR COALESCE(r."creatorId",r."accountId") IS DISTINCT FROM NEW."creatorId"))
  THEN RAISE EXCEPTION 'TEAM_TIP_ALIAS_SCOPE_MISMATCH' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM "TeamTipLedger" r JOIN "CreatorTip" t ON t.id=r."creatorTipId"
    WHERE r.id=NEW."rootId" AND t."agencyId"=NEW."agencyId" AND t."creatorId"=NEW."creatorId"
      AND ((NEW.namespace='creator_tip' AND NEW."externalId"=t.id)
        OR (NEW.namespace='notification' AND NEW."externalId"=t."externalNotificationId")
        OR (NEW.namespace='transaction' AND NEW."externalId"=t."externalTransactionId")
        OR (NEW.namespace='event' AND NEW."externalId"=t."eventFingerprint")))
  THEN RAISE EXCEPTION 'TEAM_TIP_ALIAS_EVIDENCE_REQUIRED' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND (NEW."agencyId" IS DISTINCT FROM OLD."agencyId"
   OR (OLD."creatorId" IS NOT NULL AND NEW."creatorId" IS DISTINCT FROM OLD."creatorId")
   OR (OLD."creatorTipId" IS NOT NULL AND NEW."creatorTipId" IS NOT NULL AND NEW."creatorTipId"<>OLD."creatorTipId"))
 THEN RAISE EXCEPTION 'TEAM_TIP_ROOT_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM "TeamTipAlias" a WHERE a."rootId"=NEW.id
   AND (a."agencyId" IS DISTINCT FROM NEW."agencyId" OR a."creatorId" IS DISTINCT FROM COALESCE(NEW."creatorId",NEW."accountId")))
 THEN RAISE EXCEPTION 'TEAM_TIP_ROOT_SCOPE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF NEW."creatorTipId" IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM "CreatorTip" t WHERE t.id=NEW."creatorTipId"
    AND t."agencyId"=NEW."agencyId" AND t."creatorId"=COALESCE(NEW."creatorId",NEW."accountId"))
  THEN RAISE EXCEPTION 'TEAM_TIP_ROOT_SCOPE_MISMATCH' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM "TeamTipAlias" a WHERE a."rootId"=NEW.id) THEN
   SELECT EXISTS(SELECT 1 FROM "CreatorTip" t JOIN "TeamTipAlias" a ON a."rootId"=NEW.id
     AND a."agencyId"=t."agencyId" AND a."creatorId"=t."creatorId"
     WHERE t.id=NEW."creatorTipId" AND ((a.namespace='creator_tip' AND a."externalId"=t.id)
       OR (a.namespace='notification' AND a."externalId"=t."externalNotificationId")
       OR (a.namespace='transaction' AND a."externalId"=t."externalTransactionId")
       OR (a.namespace='event' AND a."externalId"=t."eventFingerprint"))) INTO matches_tip;
   IF NOT matches_tip THEN RAISE EXCEPTION 'TEAM_TIP_RETAINED_IDENTITY_MISMATCH' USING ERRCODE='55000'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER "TeamTipAlias_identity_guard" BEFORE INSERT OR UPDATE ON "TeamTipAlias"
 FOR EACH ROW EXECUTE FUNCTION onlinod_guard_team_tip_identity_v4();
CREATE TRIGGER "TeamTipLedger_00_identity_guard" BEFORE INSERT OR UPDATE ON "TeamTipLedger"
 FOR EACH ROW EXECUTE FUNCTION onlinod_guard_team_tip_identity_v4();
INSERT INTO "MaintenanceLaneState"(key,generation,"activeGeneration",cursor,"updatedAt") VALUES
 ('team_tip_identity_adoption_v4','team_tip_identity_adoption_v4','team_tip_identity_adoption_v4',
  jsonb_build_object('upperId',COALESCE((SELECT MAX(id) FROM "CreatorTip"),''),'afterId',''),CURRENT_TIMESTAMP);

ALTER TABLE "CreatorEarningsGeneration" ADD COLUMN "ltvDeltaVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "CreatorEarningsGenerationChange" (
 generation TEXT NOT NULL REFERENCES "CreatorEarningsGeneration"(id) ON DELETE CASCADE,
 "transactionId" TEXT NOT NULL, PRIMARY KEY(generation,"transactionId")
);
CREATE FUNCTION onlinod_fan_ltv_generation_delta208() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE r "CreatorEarningsGenerationEntry"; g "CreatorEarningsGeneration"; base "CreatorEarningsGenerationEntry";
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 SELECT * INTO g FROM "CreatorEarningsGeneration" WHERE id=r.generation;
 IF g."ltvDeltaVersion"<>1 OR g.mode<>'SNAPSHOT' OR g.state NOT IN ('BUILDING','READY') THEN RETURN NULL; END IF;
 SELECT * INTO base FROM "CreatorEarningsGenerationEntry" WHERE generation=g."baseGeneration" AND "transactionId"=r."transactionId";
 IF TG_OP='DELETE' OR base."transactionId" IS NULL OR ROW(r."occurredAt",r.category,r."netCents",r.status,r."fanOnlyFansUserId")
   IS DISTINCT FROM ROW(base."occurredAt",base.category,base."netCents",base.status,base."fanOnlyFansUserId") THEN
  INSERT INTO "CreatorEarningsGenerationChange"(generation,"transactionId") VALUES(r.generation,r."transactionId") ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $body$;
CREATE TRIGGER "FanLtv_generation_delta208" AFTER INSERT OR UPDATE OR DELETE ON "CreatorEarningsGenerationEntry"
 FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_generation_delta208();
CREATE TRIGGER "CreatorEarningsGenerationChange_writer208" BEFORE INSERT OR UPDATE OR DELETE ON "CreatorEarningsGenerationChange"
 FOR EACH ROW EXECUTE FUNCTION onlinod_earnings_writer_fence_v7();

ALTER TABLE "FanLtvState" ADD COLUMN "publishedRevision" BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN "workingRevision" BIGINT NOT NULL DEFAULT 1,
 ADD COLUMN "balanceSeedCursor" TEXT NOT NULL DEFAULT '',
 ADD COLUMN "balanceSeedComplete" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "FanLtvPublishedBalance" (
 "creatorId" TEXT NOT NULL REFERENCES "FanLtvState"("creatorId") ON DELETE CASCADE,
 "fanId" TEXT NOT NULL, revision BIGINT NOT NULL,
 "netCents" BIGINT NOT NULL CHECK("netCents" BETWEEN 0 AND 9007199254740991),
 payments BIGINT NOT NULL CHECK(payments BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY("creatorId","fanId",revision)
);
CREATE TRIGGER "FanLtvPublishedBalance_writer208" BEFORE INSERT OR UPDATE ON "FanLtvPublishedBalance"
 FOR EACH ROW EXECUTE FUNCTION onlinod_fan_ltv_writer178();
-- BILLING_RECOVERY_SCHEMA_208
CREATE TABLE "CreatorBillingRecoverySnapshot" (
 "creatorId" TEXT PRIMARY KEY,"agencyId" TEXT NOT NULL,"fromDay" DATE NOT NULL,"toDay" DATE NOT NULL,
 "netCents" BIGINT NOT NULL CHECK("netCents" BETWEEN 0 AND 9007199254740991),
 "transactionsCount" BIGINT NOT NULL CHECK("transactionsCount">=0),
 "observedAt" TIMESTAMP(3) NOT NULL,"publishedAt" TIMESTAMP(3) NOT NULL,"receiptId" TEXT NOT NULL,proof JSONB NOT NULL,
 CONSTRAINT "CreatorBillingRecoverySnapshot_scope_fkey" FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE,
 CONSTRAINT "CreatorBillingRecoverySnapshot_window_check" CHECK("toDay"-"fromDay"=29)
);
CREATE FUNCTION onlinod_billing_recovery_writer208() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF current_setting('onlinod.financial_receipts_v1',true) IS DISTINCT FROM '1'
 THEN RAISE EXCEPTION 'BILLING_RECOVERY_RECEIPT_WRITER_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND (NEW."creatorId" IS DISTINCT FROM OLD."creatorId" OR NEW."agencyId" IS DISTINCT FROM OLD."agencyId")
 THEN RAISE EXCEPTION 'BILLING_RECOVERY_SCOPE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER "CreatorBillingRecoverySnapshot_writer208" BEFORE INSERT OR UPDATE ON "CreatorBillingRecoverySnapshot"
 FOR EACH ROW EXECUTE FUNCTION onlinod_billing_recovery_writer208();
COMMIT;
