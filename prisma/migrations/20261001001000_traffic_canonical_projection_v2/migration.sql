BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Traffic retains human costs and stable source identifiers. Provider fields
-- are a projection of Campaigns; the old independent collector cannot write.
ALTER TABLE "TrafficSource" ADD COLUMN "canonicalCampaignId" TEXT;
ALTER TABLE "TrafficSource" ADD COLUMN "projectionMetrics" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "TrafficSourceMember" ADD COLUMN "projectionMetrics" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "TrafficMetric" (
  "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "objectId" TEXT NOT NULL DEFAULT '', "period" TEXT NOT NULL DEFAULT '*',
  "metrics" JSONB NOT NULL DEFAULT '{}', "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY("creatorId","kind","objectId","period"),
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE INDEX "TrafficMetric_period_v2" ON "TrafficMetric"("creatorId","kind","period","objectId");
CREATE TABLE "TrafficFanProjection" (
  "id" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL, "fanId" TEXT NOT NULL, "lastRevenueAt" TIMESTAMP(3),
  "metrics" JSONB NOT NULL DEFAULT '{}', "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("creatorId","fanId"),
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE TABLE "TrafficReceiptProjection" (
  "id" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
  "fact" JSONB NOT NULL DEFAULT '{}',
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE TABLE "TrafficProjectionBackfill" (
  "creatorId" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL,
  "stage" TEXT NOT NULL DEFAULT 'RETIRE', "cursor" TEXT NOT NULL DEFAULT '',
  "completedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);
CREATE TABLE "TrafficProjectionSeed" ("id" TEXT PRIMARY KEY, "cursor" TEXT NOT NULL DEFAULT '', "complete" BOOLEAN NOT NULL DEFAULT false);
INSERT INTO "TrafficProjectionSeed"("id") VALUES('v2');

CREATE FUNCTION "onlinod_traffic_lock_v2"(c TEXT) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('traffic-projection-v2:'||c,0))
$$;
CREATE FUNCTION "onlinod_traffic_delta_v2"(old_value JSONB,new_value JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(k,to_jsonb(COALESCE((new_value->>k)::numeric,0)-COALESCE((old_value->>k)::numeric,0))),'{}'::jsonb)
  FROM (SELECT jsonb_object_keys(COALESCE(old_value,'{}')||COALESCE(new_value,'{}')) k) keys
$$;
CREATE FUNCTION "onlinod_traffic_add_v2"(a TEXT,c TEXT,k TEXT,o TEXT,p TEXT,d JSONB) RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous JSONB; updated JSONB; key TEXT; amount NUMERIC;
BEGIN
  IF d='{}'::jsonb OR NOT EXISTS(SELECT 1 FROM jsonb_each_text(d) e WHERE e.value::numeric<>0) THEN RETURN; END IF;
  INSERT INTO "TrafficMetric"("agencyId","creatorId","kind","objectId","period") VALUES(a,c,k,o,p)
    ON CONFLICT DO NOTHING;
  SELECT "metrics" INTO previous FROM "TrafficMetric" WHERE "creatorId"=c AND "kind"=k AND "objectId"=o AND "period"=p FOR UPDATE;
  updated:=previous;
  FOR key,amount IN SELECT e.key,e.value::numeric FROM jsonb_each_text(d) e LOOP
    updated:=jsonb_set(updated,ARRAY[key],to_jsonb(COALESCE((updated->>key)::numeric,0)+amount));
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_each_text(updated) e WHERE e.value::numeric<0) THEN RAISE EXCEPTION 'TRAFFIC_METRIC_UNDERFLOW:%:%',k,o; END IF;
  UPDATE "TrafficMetric" SET "metrics"=updated,"updatedAt"=CURRENT_TIMESTAMP
    WHERE "creatorId"=c AND "kind"=k AND "objectId"=o AND "period"=p;
  -- Exact all-time distinct paid-fan counts, with replay-safe zero crossings.
  IF k LIKE 'receiptFan:%' AND p='*' THEN
    amount:=(CASE WHEN COALESCE((updated->>'paidSubscriptions')::numeric,0)>0 THEN 1 ELSE 0 END)
      -(CASE WHEN COALESCE((previous->>'paidSubscriptions')::numeric,0)>0 THEN 1 ELSE 0 END);
    IF amount<>0 THEN PERFORM "onlinod_traffic_add_v2"(a,c,'source',substring(k from 12),'*',jsonb_build_object('paidFans',amount)); END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(updated) e WHERE e.value::numeric<>0) THEN
    DELETE FROM "TrafficMetric" WHERE "creatorId"=c AND "kind"=k AND "objectId"=o AND "period"=p;
  END IF;
END $$;

CREATE FUNCTION "onlinod_traffic_ensure_backfill_v2"(a TEXT,c TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "TrafficProjectionBackfill"("agencyId","creatorId") VALUES(a,c) ON CONFLICT DO NOTHING;
  IF FOUND THEN PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_BACKFILL','TrafficProjectionBackfill',c,c,c); END IF;
END $$;
CREATE FUNCTION "onlinod_traffic_creator_enroll_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deletedAt" IS NULL THEN PERFORM "onlinod_traffic_ensure_backfill_v2"(NEW."agencyId",NEW."id"); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "traffic_creator_enroll_v2" AFTER INSERT ON "CreatorAccount" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_creator_enroll_v2"();

CREATE FUNCTION "onlinod_traffic_dirty_fan_v2"(a TEXT,c TEXT,f TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE identity TEXT:=md5(jsonb_build_array(c,f)::text);
BEGIN
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  INSERT INTO "TrafficFanProjection"("id","agencyId","creatorId","fanId") VALUES(identity,a,c,f) ON CONFLICT DO NOTHING;
  PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_FAN','TrafficFanProjection',identity,c,c);
END $$;

CREATE FUNCTION "onlinod_traffic_project_source_v2"(campaign_id TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r "CreatorCampaign"%ROWTYPE; source_id TEXT; prior_flag TEXT;
BEGIN
  SELECT * INTO r FROM "CreatorCampaign" WHERE "id"=campaign_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM "onlinod_traffic_ensure_backfill_v2"(r."agencyId",r."creatorId");
  prior_flag:=current_setting('onlinod.traffic_projection_v2',true);
  PERFORM set_config('onlinod.traffic_projection_v2','canonical',true);
  INSERT INTO "TrafficSource"("id","agencyId","creatorId","accountId","sourceType","externalId","canonicalCampaignId",
    "name","url","status","startedAt","endedAt","lastScannedAt","stats","createdAt","updatedAt")
  VALUES('tcs_'||md5(r."id"),r."agencyId",r."creatorId",r."creatorId",'of_campaign',r."externalCampaignId",r."id",
    r."name",r."trackingUrl",CASE WHEN r."isActive" THEN 'live' ELSE 'inactive' END,r."startedAt",r."endedAt",r."collectedAt",
    jsonb_build_object('claimers',r."claimersCount",'clicks',r."clicksCount"),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT("agencyId","creatorId","sourceType","externalId") DO UPDATE SET
    "canonicalCampaignId"=EXCLUDED."canonicalCampaignId","name"=EXCLUDED."name","url"=EXCLUDED."url","status"=EXCLUDED."status",
    "startedAt"=EXCLUDED."startedAt","endedAt"=EXCLUDED."endedAt","lastScannedAt"=EXCLUDED."lastScannedAt","stats"=EXCLUDED."stats","updatedAt"=CURRENT_TIMESTAMP
  RETURNING "id" INTO source_id;
  PERFORM set_config('onlinod.traffic_projection_v2',COALESCE(prior_flag,''),true);
  RETURN source_id;
END $$;
CREATE FUNCTION "onlinod_traffic_project_member_v2"(membership_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r "CreatorCampaignFan"%ROWTYPE; f "CreatorFan"%ROWTYPE; s TEXT; prior_flag TEXT;
BEGIN
  SELECT * INTO r FROM "CreatorCampaignFan" WHERE "id"=membership_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO f FROM "CreatorFan" WHERE "id"=r."fanId" AND "creatorId"=r."creatorId" AND "agencyId"=r."agencyId";
  IF NOT FOUND THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_FAN_SCOPE'; END IF;
  s:="onlinod_traffic_project_source_v2"(r."campaignId");
  IF s IS NULL THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_CAMPAIGN_MISSING'; END IF;
  prior_flag:=current_setting('onlinod.traffic_projection_v2',true);
  PERFORM set_config('onlinod.traffic_projection_v2','canonical',true);
  INSERT INTO "TrafficSourceMember"("id","agencyId","creatorId","sourceId","fanId","firstSeenAt","lastSeenAt","claimedAt","metadata","createdAt","updatedAt")
    VALUES('tcm_'||md5(r."id"),r."agencyId",r."creatorId",s,f."onlyFansUserId",r."collectedAt",r."collectedAt",r."attributedAt",
      jsonb_build_object('fanUsername',r."claimerUsernameAtEvent",'fanName',r."claimerDisplayNameAtEvent",'fanAvatar',r."claimerAvatarUrlAtEvent"),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT("agencyId","creatorId","sourceId","fanId") DO UPDATE SET
      "lastSeenAt"=GREATEST("TrafficSourceMember"."lastSeenAt",EXCLUDED."lastSeenAt"),
      "claimedAt"=COALESCE(EXCLUDED."claimedAt","TrafficSourceMember"."claimedAt"),"metadata"=EXCLUDED."metadata","updatedAt"=CURRENT_TIMESTAMP;
  PERFORM set_config('onlinod.traffic_projection_v2',COALESCE(prior_flag,''),true);
END $$;

CREATE FUNCTION "onlinod_traffic_canonical_capture_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='CreatorCampaign' THEN
    IF TG_OP='INSERT' OR (OLD."name",OLD."trackingUrl",OLD."isActive",OLD."startedAt",OLD."endedAt",OLD."claimersCount",OLD."clicksCount",OLD."collectedAt")
      IS DISTINCT FROM (NEW."name",NEW."trackingUrl",NEW."isActive",NEW."startedAt",NEW."endedAt",NEW."claimersCount",NEW."clicksCount",NEW."collectedAt") THEN
      PERFORM "onlinod_traffic_project_source_v2"(NEW."id");
    END IF;
  ELSE
    IF TG_OP='INSERT' OR (OLD."attributedAt",OLD."collectedAt",OLD."claimerUsernameAtEvent",OLD."claimerDisplayNameAtEvent",OLD."claimerAvatarUrlAtEvent")
      IS DISTINCT FROM (NEW."attributedAt",NEW."collectedAt",NEW."claimerUsernameAtEvent",NEW."claimerDisplayNameAtEvent",NEW."claimerAvatarUrlAtEvent") THEN
      PERFORM "onlinod_traffic_project_member_v2"(NEW."id");
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "traffic_campaign_capture_v2" AFTER INSERT OR UPDATE ON "CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_canonical_capture_v2"();
CREATE TRIGGER "traffic_member_capture_v2" AFTER INSERT OR UPDATE ON "CreatorCampaignFan" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_canonical_capture_v2"();

CREATE FUNCTION "onlinod_traffic_provider_guard_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onlinod.traffic_projection_v2',true)='canonical' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_WRITER_REQUIRED'; END IF;
  IF TG_TABLE_NAME='TrafficSource' THEN
    IF (to_jsonb(NEW)-ARRAY['costRevision','costCents','currency','updatedAt','projectionMetrics'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['costRevision','costCents','currency','updatedAt','projectionMetrics']) THEN
      RAISE EXCEPTION 'TRAFFIC_CANONICAL_WRITER_REQUIRED'; END IF;
  ELSE
    IF (NEW."agencyId",NEW."creatorId",NEW."sourceId",NEW."fanId",NEW."firstSeenAt",NEW."lastSeenAt",NEW."claimedAt",NEW."metadata")
      IS DISTINCT FROM (OLD."agencyId",OLD."creatorId",OLD."sourceId",OLD."fanId",OLD."firstSeenAt",OLD."lastSeenAt",OLD."claimedAt",OLD."metadata") THEN
      RAISE EXCEPTION 'TRAFFIC_CANONICAL_WRITER_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "traffic_provider_guard_v2" BEFORE INSERT OR UPDATE ON "TrafficSource" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_provider_guard_v2"();
CREATE TRIGGER "traffic_member_provider_guard_v2" BEFORE INSERT OR UPDATE ON "TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_provider_guard_v2"();

CREATE FUNCTION "onlinod_traffic_source_metrics_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous JSONB:='{}'; desired JSONB; d JSONB;
BEGIN
  IF TG_OP='UPDATE' AND NEW."projectionMetrics" IS DISTINCT FROM OLD."projectionMetrics" AND (to_jsonb(NEW)-'projectionMetrics')=(to_jsonb(OLD)-'projectionMetrics') THEN RETURN NEW; END IF;
  PERFORM "onlinod_traffic_lock_v2"(NEW."creatorId");
  IF TG_OP='UPDATE' THEN previous:=OLD."projectionMetrics"; END IF;
  desired:=jsonb_build_object('sources',1,'costCents',NEW."costCents");
  d:="onlinod_traffic_delta_v2"(previous,desired);
  PERFORM "onlinod_traffic_add_v2"(NEW."agencyId",NEW."creatorId",'total','','*',d);
  PERFORM "onlinod_traffic_add_v2"(NEW."agencyId",NEW."creatorId",'type',NEW."sourceType",'*',d);
  UPDATE "TrafficSource" SET "projectionMetrics"=desired WHERE "id"=NEW."id" AND "projectionMetrics" IS DISTINCT FROM desired;
  RETURN NEW;
END $$;
CREATE TRIGGER "traffic_source_metrics_v2" AFTER INSERT OR UPDATE ON "TrafficSource" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_source_metrics_v2"();

CREATE FUNCTION "onlinod_traffic_member_dirty_capture_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a TEXT; c TEXT; f TEXT;
BEGIN
  IF TG_TABLE_NAME='CreatorFanValueCurrent' THEN
    IF TG_OP='DELETE' THEN a:=OLD."agencyId";c:=OLD."creatorId";f:=OLD."fanId"; ELSE a:=NEW."agencyId";c:=NEW."creatorId";f:=NEW."fanId"; END IF;
    SELECT "onlyFansUserId" INTO f FROM "CreatorFan" WHERE "id"=f AND "creatorId"=c;
    IF NOT EXISTS(SELECT 1 FROM "TrafficSourceMember" WHERE "creatorId"=c AND "fanId"=f)
      AND NOT EXISTS(SELECT 1 FROM "TrafficFanProjection" WHERE "creatorId"=c AND "fanId"=f) THEN
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME='CreatorFan' THEN
    a:=OLD."agencyId";c:=OLD."creatorId";f:=OLD."onlyFansUserId";
    IF NOT EXISTS(SELECT 1 FROM "TrafficFanProjection" WHERE "creatorId"=c AND "fanId"=f) THEN RETURN OLD; END IF;
  ELSE
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['projectionMetrics','updatedAt'])=(to_jsonb(OLD)-ARRAY['projectionMetrics','updatedAt']) THEN RETURN NEW; END IF;
    IF TG_OP='DELETE' THEN a:=OLD."agencyId";c:=OLD."creatorId";f:=OLD."fanId"; ELSE a:=NEW."agencyId";c:=NEW."creatorId";f:=NEW."fanId"; END IF;
  END IF;
  PERFORM "onlinod_traffic_dirty_fan_v2"(a,c,f);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER "traffic_fan_delete_capture_v2" BEFORE DELETE ON "CreatorFan" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_member_dirty_capture_v2"();
CREATE TRIGGER "traffic_value_capture_v2" AFTER INSERT OR UPDATE OR DELETE ON "CreatorFanValueCurrent" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_member_dirty_capture_v2"();
CREATE TRIGGER "traffic_member_dirty_v2" AFTER INSERT OR UPDATE ON "TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_member_dirty_capture_v2"();

CREATE FUNCTION "onlinod_traffic_receipt_project_v2"(receipt_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r "CreatorSubscriptionLedger"%ROWTYPE; cache "TrafficReceiptProjection"%ROWTYPE; next_fact JSONB:='{}'; fact JSONB; sign INTEGER; a TEXT; c TEXT; t TEXT; p TEXT; d JSONB;
BEGIN
  SELECT * INTO r FROM "CreatorSubscriptionLedger" WHERE "id"=receipt_id;
  SELECT * INTO cache FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  a:=COALESCE(r."agencyId",cache."agencyId");c:=COALESCE(r."creatorId",cache."creatorId");
  IF c IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_lock_v2"(c);
  -- Read again after the projection lock: concurrent rebuild and live writes
  -- must compare against the most recently committed cache.
  SELECT * INTO cache FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  SELECT * INTO r FROM "CreatorSubscriptionLedger" WHERE "id"=receipt_id;
  IF r."id" IS NOT NULL AND r."amountCents">0 THEN
    SELECT "sourceType" INTO t FROM "TrafficSource" WHERE "id"=r."sourceId" AND "creatorId"=c AND "agencyId"=a;
    IF r."sourceId" IS NOT NULL AND t IS NULL THEN RAISE EXCEPTION 'TRAFFIC_RECEIPT_SOURCE_SCOPE'; END IF;
    next_fact:=jsonb_build_object('source',COALESCE(r."sourceId",''),'type',COALESCE(t,'paid_unknown'),'fan',r."fanId",
      'period',to_char(r."occurredAt",'YYYY-MM-DD'),'amount',r."amountCents");
  END IF;
  IF COALESCE(cache."fact",'{}')=next_fact THEN RETURN; END IF;
  FOR fact,sign IN SELECT COALESCE(cache."fact",'{}'),-1 UNION ALL SELECT next_fact,1 LOOP
    IF fact='{}'::jsonb THEN CONTINUE; END IF;
    d:=jsonb_build_object('paidSubscriptions',sign,'revenueCents',sign*(fact->>'amount')::numeric);
    FOREACH p IN ARRAY ARRAY['*',fact->>'period'] LOOP
      PERFORM "onlinod_traffic_add_v2"(a,c,'total','',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'type',fact->>'type',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'source',fact->>'source',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'receiptFan:'||(fact->>'source'),fact->>'fan',p,d);
    END LOOP;
  END LOOP;
  IF r."id" IS NULL THEN DELETE FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  ELSE
    INSERT INTO "TrafficReceiptProjection"("id","agencyId","creatorId","fact") VALUES(receipt_id,a,c,next_fact)
      ON CONFLICT("id") DO UPDATE SET "fact"=EXCLUDED."fact";
    PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  END IF;
END $$;
CREATE FUNCTION "onlinod_traffic_receipt_capture_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD."sourceId",OLD."fanId",OLD."amountCents",OLD."occurredAt") IS NOT DISTINCT FROM (NEW."sourceId",NEW."fanId",NEW."amountCents",NEW."occurredAt") THEN RETURN NEW; END IF;
  PERFORM "onlinod_traffic_receipt_project_v2"(CASE WHEN TG_OP='DELETE' THEN OLD."id" ELSE NEW."id" END);
  IF TG_OP='INSERT' AND NEW."sourceId" IS NULL THEN PERFORM "onlinod_traffic_dirty_fan_v2"(NEW."agencyId",NEW."creatorId",NEW."fanId"); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER "traffic_receipt_capture_v2" AFTER INSERT OR UPDATE OR DELETE ON "CreatorSubscriptionLedger" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_receipt_capture_v2"();

-- Finite point projection. Fan workers call this for at most 100 memberships.
CREATE FUNCTION "onlinod_traffic_member_metrics_v2"(member_id TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE m "TrafficSourceMember"%ROWTYPE; v "CreatorFanValueCurrent"%ROWTYPE; desired JSONB; d JSONB; t TEXT; available BOOLEAN; revenue_at TIMESTAMP(3);
BEGIN
  SELECT * INTO m FROM "TrafficSourceMember" WHERE "id"=member_id;
  IF NOT FOUND THEN RETURN '{}'; END IF;
  PERFORM "onlinod_traffic_lock_v2"(m."creatorId");
  SELECT v0.* INTO v FROM "CreatorFan" f JOIN "CreatorFanValueCurrent" v0 ON v0."creatorId"=f."creatorId" AND v0."fanId"=f."id"
    WHERE f."creatorId"=m."creatorId" AND f."agencyId"=m."agencyId" AND f."onlyFansUserId"=m."fanId";
  SELECT GREATEST(m."lastRevenueAt",p."lastRevenueAt") INTO revenue_at FROM "TrafficFanProjection" p WHERE p."creatorId"=m."creatorId" AND p."fanId"=m."fanId";
  available:=COALESCE(v."availability"='AVAILABLE',false);
  desired:=jsonb_build_object('sourceMembers',1,'valueSnapshotMembers',CASE WHEN available THEN 1 ELSE 0 END,
    'valuePendingMembers',CASE WHEN NOT available OR COALESCE(revenue_at,m."lastRevenueAt")>v."fetchedAt" THEN 1 ELSE 0 END,
    'valuePayingFans',CASE WHEN available AND v."totalNetCents">0 THEN 1 ELSE 0 END,
    'fanValueCents',CASE WHEN available THEN COALESCE(v."totalNetCents",0) ELSE 0 END,
    'valueMessagesCents',CASE WHEN available THEN COALESCE(v."messagesNetCents",0) ELSE 0 END,
    'valueTipsCents',CASE WHEN available THEN COALESCE(v."tipsNetCents",0) ELSE 0 END,
    'valueSubscribesCents',CASE WHEN available THEN COALESCE(v."subscriptionsNetCents",0) ELSE 0 END,
    'valuePostsCents',CASE WHEN available THEN COALESCE(v."postsNetCents",0) ELSE 0 END,
    'valueStreamsCents',CASE WHEN available THEN COALESCE(v."streamsNetCents",0) ELSE 0 END);
  d:="onlinod_traffic_delta_v2"(m."projectionMetrics",desired);
  SELECT "sourceType" INTO t FROM "TrafficSource" WHERE "id"=m."sourceId";
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'source',m."sourceId",'*',d);
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'type',t,'*',d);
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'total','','*',jsonb_build_object('sourceMembers',d->'sourceMembers'));
  UPDATE "TrafficSourceMember" SET "projectionMetrics"=desired WHERE "id"=m."id";
  RETURN desired-'sourceMembers';
END $$;

-- Destructive lifecycle cascades delete the derived scope as well. Ordinary
-- source/member deletion is not an application API; retain historical rows so
-- human costs and attribution do not disappear on a provider directory refresh.
CREATE FUNCTION "onlinod_traffic_delete_guard_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=OLD."creatorId" AND "deletedAt" IS NULL)
    AND EXISTS(SELECT 1 FROM "Agency" WHERE "id"=OLD."agencyId" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'TRAFFIC_HISTORY_REQUIRES_CREATOR_RETIREMENT';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "traffic_source_delete_guard_v2" BEFORE DELETE ON "TrafficSource" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_delete_guard_v2"();
CREATE TRIGGER "traffic_member_delete_guard_v2" BEFORE DELETE ON "TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_delete_guard_v2"();
CREATE FUNCTION "onlinod_traffic_job_retired_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."jobKey"='traffic_sources_scan' AND NEW."status" IN ('SCHEDULED','CLAIMED','PAUSED') THEN
  RAISE EXCEPTION 'TRAFFIC_SOURCE_JOB_RETIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "traffic_job_retired_v2" BEFORE INSERT OR UPDATE ON "JobInstance" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_job_retired_v2"();
COMMIT;
