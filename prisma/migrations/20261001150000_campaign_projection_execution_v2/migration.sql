BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- These storage entry points also run from triggers / dependency wake outside
-- an application root commit. Pin their timestamp-without-time-zone writes at
-- the database boundary, including callers from a non-UTC rolling replica.
-- Otherwise a UTC claimer can see newly published/restored work hours ahead.
ALTER FUNCTION "phase2_publish_domain_work"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TIMESTAMPTZ) SET TimeZone='UTC';
ALTER FUNCTION "phase3_wake_domain_dependency_batch"(TEXT,TEXT,TEXT,BIGINT,INTEGER) SET TimeZone='UTC';

CREATE TABLE "CampaignProjectionPolicy" (
  "id" TEXT PRIMARY KEY CHECK("id"='active'),
  "generation" INTEGER NOT NULL CHECK("generation">0),
  "valueFreshnessMs" INTEGER NOT NULL CHECK("valueFreshnessMs">=60000)
);
INSERT INTO "CampaignProjectionPolicy" VALUES('active',1,
  COALESCE((SELECT "valueFreshnessMs" FROM "CampaignReadSeed" WHERE "id"='v1'),21600000));

-- Metadata-only rename, no fleet-wide UPDATE or history rewrite. The old
-- reader sees a permanent upgrade barrier, never stale cache marked READY.
ALTER TABLE "CampaignReadState" RENAME TO "CampaignReadStateData";
ALTER TABLE "CampaignReadStateData" RENAME CONSTRAINT "CampaignReadState_pkey" TO "CampaignReadStateData_pkey";
ALTER TABLE "CampaignReadStateData" RENAME CONSTRAINT "CampaignReadState_agencyId_creatorId_fkey" TO "CampaignReadStateData_agencyId_creatorId_fkey";
ALTER TABLE "CampaignReadStateData" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CampaignReadSeed" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
CREATE VIEW "CampaignReadState" AS SELECT "creatorId","agencyId","stage","cursor",
  NULL::timestamp(3) AS "completedAt","valueFreshnessMs","updatedAt" FROM "CampaignReadStateData";
COMMENT ON VIEW "CampaignReadState" IS 'Retired v1 reader barrier: upgrade backend; all live state is CampaignReadStateData.';

CREATE TABLE "CampaignReadRepairInterval" (
  "id" BIGSERIAL PRIMARY KEY,"agencyId" TEXT NOT NULL,"creatorId" TEXT NOT NULL,"fanId" TEXT NOT NULL,
  "fromAt" TIMESTAMP(3) NOT NULL,"untilAt" TIMESTAMP(3),"cursorAt" TIMESTAMP(3),"cursorId" TEXT NOT NULL DEFAULT '',
  CHECK("untilAt" IS NULL OR "untilAt">"fromAt"),
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE INDEX "CampaignReadRepairInterval_queue_v2" ON "CampaignReadRepairInterval"("creatorId","fanId","id");

CREATE FUNCTION "onlinod_campaign_projection_assert_v2"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onlinod.campaign_projection_writer',true) IS DISTINCT FROM 'campaign_projection_v2'
    OR NOT EXISTS(SELECT 1 FROM "CampaignProjectionPolicy" WHERE "id"='active'
      AND "generation"::text=current_setting('onlinod.campaign_projection_generation',true)) THEN
    RAISE EXCEPTION 'CAMPAIGN_PROJECTION_WRITER_RETIRED_OR_POLICY_CHANGED';
  END IF;
END $$;
CREATE FUNCTION "onlinod_campaign_projection_guard_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r JSONB;
BEGIN
  IF TG_OP='DELETE' THEN
    r:=to_jsonb(OLD);
    IF r->>'creatorId' IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM "CreatorAccount" c JOIN "Agency" a ON a."id"=c."agencyId"
      WHERE c."id"=r->>'creatorId' AND c."deletedAt" IS NULL AND a."deletedAt" IS NULL
    ) THEN RETURN OLD; END IF;
  END IF;
  PERFORM "onlinod_campaign_projection_assert_v2"();
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER "campaign_receipt_writer_v2" BEFORE INSERT OR UPDATE OR DELETE ON "CampaignReadReceipt"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_projection_guard_v2"();
CREATE TRIGGER "campaign_metric_writer_v2" BEFORE INSERT OR UPDATE OR DELETE ON "CampaignReadMetric"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_projection_guard_v2"();
CREATE TRIGGER "campaign_state_writer_v2" BEFORE UPDATE OR DELETE ON "CampaignReadStateData"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_projection_guard_v2"();
CREATE TRIGGER "campaign_seed_writer_v2" BEFORE UPDATE OR DELETE ON "CampaignReadSeed"
  FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_projection_guard_v2"();
CREATE FUNCTION "onlinod_campaign_projection_ack_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((NEW."state"='CLAIMED' AND (OLD."state"<>'CLAIMED' OR NEW."claimFence"<>OLD."claimFence" OR NEW."leaseUntil">OLD."leaseUntil"))
      OR (OLD."state"='CLAIMED' AND NEW."state"<>'CLAIMED'))
    AND current_setting('onlinod.campaign_projection_writer',true) IS DISTINCT FROM 'campaign_projection_v2' THEN
    RAISE EXCEPTION 'CAMPAIGN_PROJECTION_WRITER_RETIRED_OR_POLICY_CHANGED';
  END IF;
  IF NEW."completedRevision">OLD."completedRevision" AND NEW."workClass" IN
    ('CAMPAIGN_FACT','CAMPAIGN_VALUE','CAMPAIGN_ATTRIBUTION','CAMPAIGN_CLOCK','CAMPAIGN_BACKFILL')
    AND EXISTS(SELECT 1 FROM "CreatorAccount" c JOIN "Agency" a ON a."id"=c."agencyId"
      WHERE c."id"=NEW."creatorId" AND c."deletedAt" IS NULL AND a."deletedAt" IS NULL) THEN
    PERFORM "onlinod_campaign_projection_assert_v2"();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "campaign_work_ack_v2" BEFORE UPDATE ON "DomainWorkItem"
  FOR EACH ROW WHEN (NEW."workClass" IN ('CAMPAIGN_FACT','CAMPAIGN_VALUE','CAMPAIGN_ATTRIBUTION','CAMPAIGN_CLOCK','CAMPAIGN_BACKFILL'))
  EXECUTE FUNCTION "onlinod_campaign_projection_ack_v2"();

CREATE FUNCTION "onlinod_campaign_projection_policy_v2"(expected INTEGER,ttl INTEGER) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE p "CampaignProjectionPolicy";
BEGIN
  SELECT * INTO p FROM "CampaignProjectionPolicy" WHERE "id"='active' FOR UPDATE;
  IF p."generation"<>expected THEN RAISE EXCEPTION 'CAMPAIGN_POLICY_GENERATION_CONFLICT'; END IF;
  IF ttl<60000 THEN RAISE EXCEPTION 'CAMPAIGN_POLICY_TTL_INVALID'; END IF;
  IF p."valueFreshnessMs"=ttl THEN RETURN p."generation"; END IF;
  UPDATE "CampaignProjectionPolicy" SET "generation"="generation"+1,"valueFreshnessMs"=ttl WHERE "id"='active' RETURNING * INTO p;
  PERFORM set_config('onlinod.campaign_projection_writer','campaign_projection_v2',true);
  PERFORM set_config('onlinod.campaign_projection_generation',p."generation"::text,true);
  UPDATE "CampaignReadSeed" SET "generation"=p."generation","valueFreshnessMs"=ttl,"cursor"='',"complete"=false WHERE "id"='v1';
  RETURN p."generation";
END $$;

CREATE OR REPLACE FUNCTION "onlinod_campaign_read_enroll_v1"(a TEXT,c TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "CampaignReadStateData"("agencyId","creatorId") VALUES(a,c) ON CONFLICT DO NOTHING;
  IF FOUND THEN PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_BACKFILL','CampaignReadState',c,c,c); END IF;
END $$;
CREATE FUNCTION "onlinod_campaign_read_repair_v2"(a TEXT,c TEXT,f TEXT,source_id TEXT,t TIMESTAMP(3)) RETURNS void LANGUAGE plpgsql AS $$
DECLARE successor TIMESTAMP(3);
BEGIN
  IF f IS NULL OR t IS NULL THEN RETURN; END IF;
  SELECT "attributedAt" INTO successor FROM "CreatorCampaignFan"
    WHERE "creatorId"=c AND "agencyId"=a AND "fanId"=f AND "id"<>source_id
      AND ("attributedAt">t OR ("attributedAt"=t AND "id">source_id))
    ORDER BY "attributedAt","id" LIMIT 1;
  IF successor=t THEN RETURN; END IF;
  -- Constant producer work. Workers coalesce a bounded queue prefix; producers
  -- never scan/lock existing intervals or financial history.
  INSERT INTO "CampaignReadRepairInterval"("agencyId","creatorId","fanId","fromAt","untilAt") VALUES(a,c,f,t,successor);
  PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_ATTRIBUTION','CampaignFan',f,c,c);
END $$;
CREATE OR REPLACE FUNCTION "onlinod_campaign_read_capture_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r JSONB; prior JSONB; a TEXT; c TEXT; f TEXT; kind TEXT;
BEGIN
  r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='CreatorAccount' THEN
    -- A creator without campaigns has a virtual empty read model; no bootstrap debt.
    RETURN NEW;
  END IF;
  a:=r->>'agencyId'; c:=r->>'creatorId'; f:=r->>'fanId';
  IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL)
     OR NOT EXISTS(SELECT 1 FROM "Agency" WHERE "id"=a AND "deletedAt" IS NULL) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    prior:=to_jsonb(OLD);
    IF (prior->>'id',prior->>'creatorId',prior->>'agencyId') IS DISTINCT FROM (r->>'id',c,a) THEN
      RAISE EXCEPTION 'CAMPAIGN_READ_SOURCE_IDENTITY_IMMUTABLE';
    END IF;
    IF TG_TABLE_NAME='CreatorCampaign' AND (prior->>'isActive') IS NOT DISTINCT FROM (r->>'isActive') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='CreatorCampaignFan' AND
      (prior->>'fanId',prior->>'campaignId',prior->>'attributedAt') IS NOT DISTINCT FROM (f,r->>'campaignId',r->>'attributedAt') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='CreatorFinancialTransaction' AND
      (prior->>'fanId',prior->>'occurredAt',prior->>'amountCents',prior->>'netCents',prior->>'transactionStatus',prior->>'transactionType') IS NOT DISTINCT FROM
      (f,r->>'occurredAt',r->>'amountCents',r->>'netCents',r->>'transactionStatus',r->>'transactionType') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='CreatorFanValueCurrent' AND (prior-'updatedAt')=(r-'updatedAt') THEN RETURN NEW; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "CampaignReadStateData" WHERE "creatorId"=c)
     AND NOT EXISTS(SELECT 1 FROM "CreatorCampaign" WHERE "creatorId"=c) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  PERFORM "onlinod_campaign_read_enroll_v1"(a,c);
  IF TG_TABLE_NAME='CreatorFanValueCurrent' THEN
    PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',f,c,c);
    IF prior->>'fanId' IS NOT NULL AND prior->>'fanId'<>f THEN
      PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',prior->>'fanId',c,c);
    END IF;
  ELSE
    kind:=CASE TG_TABLE_NAME WHEN 'CreatorCampaign' THEN 'DIRECTORY' WHEN 'CreatorCampaignFan' THEN 'MEMBER' ELSE 'FINANCIAL' END;
    -- No projection locks or aggregate mutations in a canonical transaction.
    -- Append-only outbox: workers never contend with a producer updating an
    -- already selected signal. Uncommitted sequence gaps are not cursor gaps.
    INSERT INTO "CampaignReadChange"("agencyId","creatorId","kind","sourceId") VALUES(a,c,kind,r->>'id');
    PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_FACT','CampaignReadChange',c,c,c);
    IF kind='MEMBER' THEN
      PERFORM "onlinod_campaign_read_repair_v2"(a,c,f,r->>'id',(r->>'attributedAt')::timestamp);
      PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',f,c,c);
      IF TG_OP='UPDATE' THEN
        PERFORM "onlinod_campaign_read_repair_v2"(a,c,prior->>'fanId',prior->>'id',(prior->>'attributedAt')::timestamp);
        IF prior->>'fanId'<>f THEN PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',prior->>'fanId',c,c); END IF;
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount")
  SELECT 'campaign_projection_execution_v2',name,n-1,0 FROM unnest(ARRAY[
    'CAMPAIGN_FACT','CAMPAIGN_VALUE','CAMPAIGN_ATTRIBUTION','CAMPAIGN_CLOCK','CAMPAIGN_BACKFILL']) WITH ORDINALITY AS q(name,n);
COMMIT;
