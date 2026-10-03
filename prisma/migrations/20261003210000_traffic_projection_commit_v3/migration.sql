BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL TimeZone='UTC';

-- Timestamp-only producer state, separate from worker-owned aggregates. Workers
-- never mutate this row, including while holding DomainWork acknowledgement locks.
CREATE TABLE "TrafficFanSignal" (
  "id" TEXT PRIMARY KEY,"agencyId" TEXT NOT NULL,"creatorId" TEXT NOT NULL,"fanId" TEXT NOT NULL,
  "lastRevenueAt" TIMESTAMP(3),UNIQUE("creatorId","fanId"),
  FOREIGN KEY("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE
);

-- O(1) cutover. The old read ABI stays present, permanently rebuilding: an old
-- replica does not know TRAFFIC_FACT and cannot certify its pending work READY.
ALTER TABLE "TrafficProjectionBackfill" RENAME TO "TrafficProjectionBackfillData";
ALTER TABLE "TrafficProjectionBackfillData" RENAME CONSTRAINT "TrafficProjectionBackfill_pkey" TO "TrafficProjectionBackfillData_pkey";
ALTER TABLE "TrafficProjectionBackfillData" RENAME CONSTRAINT "TrafficProjectionBackfill_agencyId_creatorId_fkey" TO "TrafficProjectionBackfillData_agencyId_creatorId_fkey";
CREATE VIEW "TrafficProjectionBackfill" AS SELECT "creatorId","agencyId","stage","cursor",
  NULL::timestamp(3) AS "completedAt","updatedAt" FROM "TrafficProjectionBackfillData";

CREATE FUNCTION "onlinod_traffic_executor_assert_v3"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onlinod.traffic_executor_version',true) IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'TRAFFIC_PROJECTION_EXECUTOR_RETIRED';
  END IF;
END $$;
CREATE FUNCTION "onlinod_traffic_enter_v3"(c TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "onlinod_traffic_executor_assert_v3"();
  IF c IS NULL OR c='' THEN RAISE EXCEPTION 'TRAFFIC_PROJECTION_SCOPE_REQUIRED'; END IF;
  PERFORM "onlinod_traffic_lock_v2"(c);
  PERFORM set_config('onlinod.traffic_projection_creator_v3',c,true);
END $$;
CREATE FUNCTION "onlinod_traffic_projection_assert_v3"(c TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "onlinod_traffic_executor_assert_v3"();
  IF c IS NULL OR current_setting('onlinod.traffic_projection_creator_v3',true) IS DISTINCT FROM c THEN
    RAISE EXCEPTION 'TRAFFIC_PROJECTION_SCOPE_NOT_LOCKED';
  END IF;
END $$;

-- Canonical capture publishes a coalesced identity in the existing fair queue.
-- It never locks or updates derived sources, members or metrics.
CREATE FUNCTION "onlinod_traffic_publish_fact_v3"(a TEXT,c TEXT,t TEXT,o TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_FACT',t,o,c,c);
END $$;

CREATE OR REPLACE FUNCTION "onlinod_traffic_ensure_backfill_v2"(a TEXT,c TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "TrafficProjectionBackfillData"("agencyId","creatorId") VALUES(a,c) ON CONFLICT DO NOTHING;
  IF FOUND THEN PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_BACKFILL','TrafficProjectionBackfill',c,c,c); END IF;
END $$;

CREATE OR REPLACE FUNCTION "onlinod_traffic_project_source_v2"(campaign_id TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r "CreatorCampaign"%ROWTYPE; source_id TEXT; prior_flag TEXT;
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO r FROM "CreatorCampaign" WHERE "id"=campaign_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(r."creatorId");
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
  WHERE ("TrafficSource"."canonicalCampaignId","TrafficSource"."name","TrafficSource"."url","TrafficSource"."status",
    "TrafficSource"."startedAt","TrafficSource"."endedAt","TrafficSource"."lastScannedAt","TrafficSource"."stats") IS DISTINCT FROM
    (EXCLUDED."canonicalCampaignId",EXCLUDED."name",EXCLUDED."url",EXCLUDED."status",EXCLUDED."startedAt",EXCLUDED."endedAt",EXCLUDED."lastScannedAt",EXCLUDED."stats")
  RETURNING "id" INTO source_id;
  IF source_id IS NULL THEN
    SELECT "id" INTO source_id FROM "TrafficSource" WHERE "agencyId"=r."agencyId" AND "creatorId"=r."creatorId"
      AND "sourceType"='of_campaign' AND "externalId"=r."externalCampaignId";
  END IF;
  PERFORM set_config('onlinod.traffic_projection_v2',COALESCE(prior_flag,''),true);
  RETURN source_id;
END $$;

CREATE OR REPLACE FUNCTION "onlinod_traffic_project_member_v2"(membership_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r "CreatorCampaignFan"%ROWTYPE; f "CreatorFan"%ROWTYPE; s TEXT; prior_flag TEXT;
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO r FROM "CreatorCampaignFan" WHERE "id"=membership_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(r."creatorId");
  IF NOT EXISTS(SELECT 1 FROM "CreatorCampaign" WHERE "id"=r."campaignId" AND "creatorId"=r."creatorId" AND "agencyId"=r."agencyId") THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_CAMPAIGN_SCOPE'; END IF;
  SELECT * INTO f FROM "CreatorFan" WHERE "id"=r."fanId" AND "creatorId"=r."creatorId" AND "agencyId"=r."agencyId";
  IF NOT FOUND THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_FAN_SCOPE'; END IF;
  SELECT "id" INTO s FROM "TrafficSource" WHERE "canonicalCampaignId"=r."campaignId" AND "creatorId"=r."creatorId" AND "agencyId"=r."agencyId";
  IF s IS NULL THEN s:="onlinod_traffic_project_source_v2"(r."campaignId"); END IF;
  IF s IS NULL THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_CAMPAIGN_MISSING'; END IF;
  prior_flag:=current_setting('onlinod.traffic_projection_v2',true);
  PERFORM set_config('onlinod.traffic_projection_v2','canonical',true);
  INSERT INTO "TrafficSourceMember"("id","agencyId","creatorId","sourceId","fanId","firstSeenAt","lastSeenAt","claimedAt","metadata","createdAt","updatedAt")
    VALUES('tcm_'||md5(r."id"),r."agencyId",r."creatorId",s,f."onlyFansUserId",r."collectedAt",r."collectedAt",r."attributedAt",
      jsonb_build_object('fanUsername',r."claimerUsernameAtEvent",'fanName',r."claimerDisplayNameAtEvent",'fanAvatar',r."claimerAvatarUrlAtEvent"),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT("agencyId","creatorId","sourceId","fanId") DO UPDATE SET
      "lastSeenAt"=GREATEST("TrafficSourceMember"."lastSeenAt",EXCLUDED."lastSeenAt"),
      "claimedAt"=COALESCE(EXCLUDED."claimedAt","TrafficSourceMember"."claimedAt"),"metadata"=EXCLUDED."metadata","updatedAt"=CURRENT_TIMESTAMP
    WHERE ("TrafficSourceMember"."lastSeenAt","TrafficSourceMember"."claimedAt","TrafficSourceMember"."metadata") IS DISTINCT FROM
      (GREATEST("TrafficSourceMember"."lastSeenAt",EXCLUDED."lastSeenAt"),COALESCE(EXCLUDED."claimedAt","TrafficSourceMember"."claimedAt"),EXCLUDED."metadata");
  PERFORM set_config('onlinod.traffic_projection_v2',COALESCE(prior_flag,''),true);
END $$;

CREATE OR REPLACE FUNCTION "onlinod_traffic_canonical_capture_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='CreatorCampaign' THEN
    IF TG_OP='INSERT' OR (OLD."name",OLD."trackingUrl",OLD."isActive",OLD."startedAt",OLD."endedAt",OLD."claimersCount",OLD."clicksCount",OLD."collectedAt")
      IS DISTINCT FROM (NEW."name",NEW."trackingUrl",NEW."isActive",NEW."startedAt",NEW."endedAt",NEW."claimersCount",NEW."clicksCount",NEW."collectedAt") THEN
      PERFORM "onlinod_traffic_publish_fact_v3"(NEW."agencyId",NEW."creatorId",TG_TABLE_NAME,NEW."id");
    END IF;
  ELSE
    IF TG_OP='INSERT' OR (OLD."attributedAt",OLD."collectedAt",OLD."claimerUsernameAtEvent",OLD."claimerDisplayNameAtEvent",OLD."claimerAvatarUrlAtEvent")
      IS DISTINCT FROM (NEW."attributedAt",NEW."collectedAt",NEW."claimerUsernameAtEvent",NEW."claimerDisplayNameAtEvent",NEW."claimerAvatarUrlAtEvent") THEN
      PERFORM "onlinod_traffic_publish_fact_v3"(NEW."agencyId",NEW."creatorId",TG_TABLE_NAME,NEW."id");
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "onlinod_traffic_receipt_capture_v2"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD."sourceId",OLD."fanId",OLD."amountCents",OLD."occurredAt") IS NOT DISTINCT FROM (NEW."sourceId",NEW."fanId",NEW."amountCents",NEW."occurredAt") THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN
    PERFORM "onlinod_traffic_publish_fact_v3"(OLD."agencyId",OLD."creatorId",TG_TABLE_NAME,OLD."id");
    RETURN OLD;
  END IF;
  PERFORM "onlinod_traffic_publish_fact_v3"(NEW."agencyId",NEW."creatorId",TG_TABLE_NAME,NEW."id");
  IF NEW."sourceId" IS NULL THEN PERFORM "onlinod_traffic_dirty_fan_v2"(NEW."agencyId",NEW."creatorId",NEW."fanId"); END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "onlinod_traffic_receipt_project_v2"(receipt_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r "CreatorSubscriptionLedger"%ROWTYPE; cache "TrafficReceiptProjection"%ROWTYPE; next_fact JSONB:='{}'; fact JSONB; sign INTEGER; a TEXT; c TEXT; t TEXT; p TEXT; d JSONB;
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO r FROM "CreatorSubscriptionLedger" WHERE "id"=receipt_id;
  SELECT * INTO cache FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  a:=COALESCE(r."agencyId",cache."agencyId");c:=COALESCE(r."creatorId",cache."creatorId");
  IF c IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(c);
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
  IF r."id" IS NOT NULL AND r."sourceId" IS NOT NULL AND r."amountCents">0 THEN
    UPDATE "TrafficSourceMember" SET "needsValueRefresh"=true,
      "lastRevenueAt"=GREATEST("lastRevenueAt",r."occurredAt"),"convertedAt"=LEAST("convertedAt",r."occurredAt")
    WHERE "agencyId"=a AND "creatorId"=c AND "sourceId"=r."sourceId" AND "fanId"=r."fanId"
      AND (NOT "needsValueRefresh" OR "lastRevenueAt" IS NULL OR "lastRevenueAt"<r."occurredAt"
        OR "convertedAt" IS NULL OR "convertedAt">r."occurredAt");
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

CREATE OR REPLACE FUNCTION "onlinod_traffic_member_metrics_v2"(member_id TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE m "TrafficSourceMember"%ROWTYPE; v "CreatorFanValueCurrent"%ROWTYPE; desired JSONB; d JSONB; t TEXT; available BOOLEAN; revenue_at TIMESTAMP(3);
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO m FROM "TrafficSourceMember" WHERE "id"=member_id;
  IF NOT FOUND THEN RETURN '{}'; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(m."creatorId");
  SELECT v0.* INTO v FROM "CreatorFan" f JOIN "CreatorFanValueCurrent" v0 ON v0."creatorId"=f."creatorId" AND v0."fanId"=f."id"
    WHERE f."creatorId"=m."creatorId" AND f."agencyId"=m."agencyId" AND f."onlyFansUserId"=m."fanId";
  SELECT GREATEST(m."lastRevenueAt",p."lastRevenueAt",signal."lastRevenueAt") INTO revenue_at
    FROM "TrafficFanProjection" p LEFT JOIN "TrafficFanSignal" signal ON signal."id"=p."id" AND signal."creatorId"=p."creatorId" AND signal."agencyId"=p."agencyId"
    WHERE p."creatorId"=m."creatorId" AND p."fanId"=m."fanId";
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
  UPDATE "TrafficSourceMember" SET "projectionMetrics"=desired WHERE "id"=m."id" AND "projectionMetrics" IS DISTINCT FROM desired;
  RETURN desired-'sourceMembers';
END $$;

-- Capture can also be raised by derived member/receipt workers. In that case
-- enroll only the worker-owned row, not the producer's signal. This avoids a
-- signal -> DWI / DWI -> signal inversion in multi-fact transactions.
CREATE OR REPLACE FUNCTION "onlinod_traffic_dirty_fan_v2"(a TEXT,c TEXT,f TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE identity TEXT:=md5(jsonb_build_array(c,f)::text);
BEGIN
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  IF current_setting('onlinod.traffic_executor_version',true)='3'
    AND current_setting('onlinod.traffic_projection_creator_v3',true)=c THEN
    INSERT INTO "TrafficFanProjection"("id","agencyId","creatorId","fanId") VALUES(identity,a,c,f) ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO "TrafficFanSignal"("id","agencyId","creatorId","fanId") VALUES(identity,a,c,f) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_FAN','TrafficFanProjection',identity,c,c);
END $$;
CREATE FUNCTION "onlinod_traffic_observe_revenue_v3"(a TEXT,c TEXT,f TEXT,observed_at TIMESTAMPTZ) RETURNS void LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE identity TEXT:=md5(jsonb_build_array(c,f)::text);
BEGIN
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  INSERT INTO "TrafficFanSignal"("id","agencyId","creatorId","fanId","lastRevenueAt") VALUES(identity,a,c,f,observed_at)
    ON CONFLICT("creatorId","fanId") DO UPDATE SET "lastRevenueAt"=GREATEST("TrafficFanSignal"."lastRevenueAt",EXCLUDED."lastRevenueAt")
    WHERE "TrafficFanSignal"."lastRevenueAt" IS NULL OR "TrafficFanSignal"."lastRevenueAt"<EXCLUDED."lastRevenueAt";
  PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_FAN','TrafficFanProjection',identity,c,c);
END $$;

-- Physical rolling-version fences include claim, progress and acknowledgement;
-- an old worker cannot swallow a new queue revision without performing it.
CREATE FUNCTION "onlinod_traffic_work_guard_v3"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."state"='CLAIMED' AND (OLD."state"<>'CLAIMED' OR NEW."claimFence"<>OLD."claimFence" OR NEW."leaseUntil">OLD."leaseUntil"))
    OR (OLD."state"='CLAIMED' AND NEW."state"<>'CLAIMED')
    OR NEW."completedRevision">OLD."completedRevision"
    OR (OLD."state"='CLAIMED' AND NEW."progressCursor" IS DISTINCT FROM OLD."progressCursor") THEN
    PERFORM "onlinod_traffic_executor_assert_v3"();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "traffic_work_guard_v3" BEFORE UPDATE ON "DomainWorkItem" FOR EACH ROW
  WHEN (NEW."workClass" IN ('TRAFFIC_FACT','TRAFFIC_FAN','TRAFFIC_BACKFILL'))
  EXECUTE FUNCTION "onlinod_traffic_work_guard_v3"();

CREATE FUNCTION "onlinod_traffic_projection_guard_v3"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r JSONB;
BEGIN
  r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_OP='DELETE' AND r->>'creatorId' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM "CreatorAccount" c JOIN "Agency" a ON a."id"=c."agencyId"
    WHERE c."id"=r->>'creatorId' AND c."deletedAt" IS NULL AND a."deletedAt" IS NULL
  ) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='TrafficProjectionSeed' THEN PERFORM "onlinod_traffic_executor_assert_v3"();
  ELSE PERFORM "onlinod_traffic_projection_assert_v3"(r->>'creatorId'); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "traffic_source_writer_v3" BEFORE INSERT OR UPDATE OR DELETE ON "TrafficSource" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_projection_guard_v3"();
CREATE TRIGGER "traffic_member_writer_v3" BEFORE INSERT OR UPDATE OR DELETE ON "TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_projection_guard_v3"();
CREATE TRIGGER "traffic_metric_writer_v3" BEFORE INSERT OR UPDATE OR DELETE ON "TrafficMetric" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_projection_guard_v3"();
CREATE TRIGGER "traffic_receipt_writer_v3" BEFORE INSERT OR UPDATE OR DELETE ON "TrafficReceiptProjection" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_projection_guard_v3"();
CREATE TRIGGER "traffic_backfill_writer_v3" BEFORE UPDATE OR DELETE ON "TrafficProjectionBackfillData" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_projection_guard_v3"();
CREATE TRIGGER "traffic_seed_writer_v3" BEFORE UPDATE OR DELETE ON "TrafficProjectionSeed" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_projection_guard_v3"();
CREATE TRIGGER "traffic_fan_writer_v3" BEFORE INSERT OR UPDATE OR DELETE ON "TrafficFanProjection" FOR EACH ROW EXECUTE FUNCTION "onlinod_traffic_projection_guard_v3"();
COMMIT;

