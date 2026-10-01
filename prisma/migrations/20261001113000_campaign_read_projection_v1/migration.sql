BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Rebuildable read cache. Canonical Campaign, Financial and FanData writers
-- retain their existing generation and publication guards.
CREATE TABLE "CampaignReadState" (
  "creatorId" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL,
  "stage" TEXT NOT NULL DEFAULT 'DIRECTORY', "cursor" TEXT NOT NULL DEFAULT '',
  "completedAt" TIMESTAMP(3), "valueFreshnessMs" INTEGER, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE TABLE "CampaignReadSeed" ("id" TEXT PRIMARY KEY, "cursor" TEXT NOT NULL DEFAULT '', "complete" BOOLEAN NOT NULL DEFAULT false, "valueFreshnessMs" INTEGER);
INSERT INTO "CampaignReadSeed"("id") VALUES('v1');
CREATE TABLE "CampaignReadChange" (
  "id" BIGSERIAL PRIMARY KEY, "creatorId" TEXT NOT NULL, "agencyId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE INDEX "CampaignReadChange_creator_v1" ON "CampaignReadChange"("creatorId","id");
CREATE TABLE "CampaignReadReceipt" (
  "creatorId" TEXT NOT NULL, "agencyId" TEXT NOT NULL, "kind" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
  "contributions" JSONB NOT NULL DEFAULT '[]', "nextDueAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY("creatorId","kind","sourceId"),
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE INDEX "CampaignReadReceipt_due_v1" ON "CampaignReadReceipt"("creatorId","nextDueAt","kind","sourceId") WHERE "nextDueAt" IS NOT NULL;
CREATE TABLE "CampaignReadMetric" (
  "creatorId" TEXT NOT NULL, "agencyId" TEXT NOT NULL, "campaignId" TEXT NOT NULL DEFAULT '',
  "rangeKey" TEXT NOT NULL, "fanId" TEXT NOT NULL DEFAULT '',
  "metrics" JSONB NOT NULL DEFAULT '{}', "paying" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY("creatorId","campaignId","rangeKey","fanId"),
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE INDEX "CampaignReadMetric_paying_v1" ON "CampaignReadMetric"("creatorId","campaignId","rangeKey","fanId") WHERE "paying"=true;
CREATE TABLE "CampaignReadRepair" (
  "creatorId" TEXT NOT NULL, "agencyId" TEXT NOT NULL, "fanId" TEXT NOT NULL, "fromAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY("creatorId","fanId"),
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);

CREATE FUNCTION "onlinod_campaign_read_enroll_v1"(a TEXT,c TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "CampaignReadState"("agencyId","creatorId") VALUES(a,c) ON CONFLICT DO NOTHING;
  IF FOUND THEN PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_BACKFILL','CampaignReadState',c,c,c); END IF;
END $$;
CREATE FUNCTION "onlinod_campaign_read_repair_v1"(a TEXT,c TEXT,f TEXT,t TIMESTAMP(3)) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF f IS NULL OR t IS NULL THEN RETURN; END IF;
  INSERT INTO "CampaignReadRepair"("agencyId","creatorId","fanId","fromAt") VALUES(a,c,f,t)
    ON CONFLICT("creatorId","fanId") DO UPDATE SET "fromAt"=LEAST("CampaignReadRepair"."fromAt",EXCLUDED."fromAt");
  PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_ATTRIBUTION','CampaignFan',f,c,c);
END $$;
CREATE FUNCTION "onlinod_campaign_read_capture_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r JSONB; prior JSONB; a TEXT; c TEXT; f TEXT; kind TEXT;
BEGIN
  r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='CreatorAccount' THEN
    IF r->>'deletedAt' IS NULL THEN PERFORM "onlinod_campaign_read_enroll_v1"(r->>'agencyId',r->>'id'); END IF;
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
      PERFORM "onlinod_campaign_read_repair_v1"(a,c,f,(r->>'attributedAt')::timestamp);
      PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',f,c,c);
      IF TG_OP='UPDATE' THEN
        PERFORM "onlinod_campaign_read_repair_v1"(a,c,prior->>'fanId',(prior->>'attributedAt')::timestamp);
        IF prior->>'fanId'<>f THEN PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',prior->>'fanId',c,c); END IF;
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER "campaign_read_creator_v1" AFTER INSERT ON "CreatorAccount" FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_read_capture_v1"();
CREATE TRIGGER "campaign_read_directory_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_read_capture_v1"();
CREATE TRIGGER "campaign_read_member_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorCampaignFan" FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_read_capture_v1"();
CREATE TRIGGER "campaign_read_financial_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorFinancialTransaction" FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_read_capture_v1"();
CREATE TRIGGER "campaign_read_value_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorFanValueCurrent" FOR EACH ROW EXECUTE FUNCTION "onlinod_campaign_read_capture_v1"();

-- Restore wakes paused derived work through one coalescing dependency, with no
-- scan of the Agency's creators or blocked rows in the lifecycle transaction.
CREATE FUNCTION "onlinod_analytics_projection_restore_v1"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "phase2_bump_dependency"(NEW."id",'ANALYTICS_PROJECTION_LIFECYCLE',NEW."id");
  RETURN NEW;
END $$;
CREATE TRIGGER "analytics_projection_restore_v1" AFTER UPDATE OF "deletedAt" ON "Agency"
FOR EACH ROW WHEN (OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS NULL)
EXECUTE FUNCTION "onlinod_analytics_projection_restore_v1"();

-- Decimal strings preserve integer cents across PostgreSQL JSON and JS. Signed
-- amounts are legal; reference counts must never become negative.
CREATE FUNCTION "onlinod_campaign_read_add_v1"(a TEXT,c TEXT,p TEXT,w TEXT,f TEXT,d JSONB) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_value JSONB; after_value JSONB; delta JSONB; k TEXT; n NUMERIC; members NUMERIC; payers NUMERIC;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(d) e WHERE e.value::numeric<>0) THEN RETURN; END IF;
  INSERT INTO "CampaignReadMetric"("agencyId","creatorId","campaignId","rangeKey","fanId") VALUES(a,c,p,w,f) ON CONFLICT DO NOTHING;
  SELECT "metrics" INTO before_value FROM "CampaignReadMetric"
    WHERE "creatorId"=c AND "campaignId"=p AND "rangeKey"=w AND "fanId"=f FOR UPDATE;
  after_value:=before_value;
  FOR k,n IN SELECT e.key,e.value::numeric FROM jsonb_each_text(d) e LOOP
    n:=COALESCE((after_value->>k)::numeric,0)+n;
    IF n<0 AND (k NOT LIKE '%Cents') THEN RAISE EXCEPTION 'CAMPAIGN_READ_COUNTER_UNDERFLOW:%',k; END IF;
    after_value:=jsonb_set(after_value,ARRAY[k],to_jsonb(n::text));
  END LOOP;
  UPDATE "CampaignReadMetric" SET "metrics"=after_value,"paying"=COALESCE((after_value->>'transactionsCount')::numeric,0)>0,"updatedAt"=CURRENT_TIMESTAMP
    WHERE "creatorId"=c AND "campaignId"=p AND "rangeKey"=w AND "fanId"=f;
  IF f<>'' THEN
    members:=(CASE WHEN COALESCE((after_value->>'memberships')::numeric,0)>0 THEN 1 ELSE 0 END)
      -(CASE WHEN COALESCE((before_value->>'memberships')::numeric,0)>0 THEN 1 ELSE 0 END);
    payers:=(CASE WHEN COALESCE((after_value->>'transactionsCount')::numeric,0)>0 THEN 1 ELSE 0 END)
      -(CASE WHEN COALESCE((before_value->>'transactionsCount')::numeric,0)>0 THEN 1 ELSE 0 END);
    delta:=d || jsonb_build_object('uniqueFans',members::text,'payingFans',payers::text);
    PERFORM "onlinod_campaign_read_add_v1"(a,c,p,w,'',delta);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(after_value) e WHERE e.value::numeric<>0) THEN
    DELETE FROM "CampaignReadMetric" WHERE "creatorId"=c AND "campaignId"=p AND "rangeKey"=w AND "fanId"=f;
  END IF;
END $$;
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount","lastAdmittedAt")
 SELECT 'phase6_maintenance_campaign_read_v3',"laneName","ordinal","turnCount","lastAdmittedAt"
 FROM "MaintenanceAdmissionClassState" WHERE "generation"='phase6_maintenance_analytics_traffic_v2';
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount")
 SELECT 'phase6_maintenance_campaign_read_v3','campaignReadProjection',24,
 COALESCE((SELECT min("turnCount") FROM "MaintenanceAdmissionClassState" WHERE "generation"='phase6_maintenance_analytics_traffic_v2'),0);
COMMIT;
