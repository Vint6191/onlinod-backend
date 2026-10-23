-- Independent FanData component coverage. Rebuild only derived fan work in
-- bounded maintenance pages; no provider fetch or synchronous history rewrite.
CREATE OR REPLACE FUNCTION public.onlinod_traffic_member_metrics_v2(member_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE m "TrafficSourceMember"%ROWTYPE; v "CreatorFanValueCurrent"%ROWTYPE; desired JSONB; d JSONB; t TEXT; available BOOLEAN; revenue_at TIMESTAMP(3); component RECORD; amount BIGINT;
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
  available:=COALESCE(v."availability"='AVAILABLE' AND v."totalNetCents" IS NOT NULL,false);
  desired:=jsonb_build_object('sourceMembers',1,'valueSnapshotMembers',CASE WHEN available THEN 1 ELSE 0 END,
    'valuePendingMembers',CASE WHEN NOT available OR COALESCE(revenue_at,m."lastRevenueAt")>v."fetchedAt" THEN 1 ELSE 0 END,
    'valuePayingFans',CASE WHEN available AND v."totalNetCents">0 THEN 1 ELSE 0 END,
    'fanValueCents',CASE WHEN available THEN COALESCE(v."totalNetCents",0) ELSE 0 END,
    'valueComponentsMembers',1);
  -- A missing component is not zero. Preserve each independently known value,
  -- even when the provider did not expose the aggregate lifetime total.
  FOR component IN SELECT * FROM (VALUES
    ('Messages','messagesNetCents'),('Tips','tipsNetCents'),('Subscribes','subscriptionsNetCents'),
    ('Posts','postsNetCents'),('Streams','streamsNetCents')) x(name,column_name)
  LOOP
    amount:=(to_jsonb(v)->>component.column_name)::bigint;
    desired:=desired||jsonb_build_object('value'||component.name||'Cents',COALESCE(amount,0),
      'value'||component.name||'KnownMembers',CASE WHEN amount IS NULL THEN 0 ELSE 1 END,
      'value'||component.name||'UnknownMembers',CASE WHEN amount IS NULL THEN 1 ELSE 0 END);
  END LOOP;
  d:="onlinod_traffic_delta_v2"(m."projectionMetrics",desired);
  SELECT "sourceType" INTO t FROM "TrafficSource" WHERE "id"=m."sourceId";
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'source',m."sourceId",'*',d);
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'type',t,'*',d);
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'total','','*',jsonb_build_object('sourceMembers',d->'sourceMembers'));
  UPDATE "TrafficSourceMember" SET "projectionMetrics"=desired WHERE "id"=m."id" AND "projectionMetrics" IS DISTINCT FROM desired;
  RETURN desired-'sourceMembers';
END $function$;

INSERT INTO "TrafficProjectionSeed"("id","cursor","complete")
  VALUES('fan-components-v1','',false) ON CONFLICT("id") DO NOTHING;
