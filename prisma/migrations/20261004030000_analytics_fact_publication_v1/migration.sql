BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE "CreatorAnalyticsFactPublication" (
 "agencyId" TEXT NOT NULL,"creatorId" TEXT NOT NULL,"kind" VARCHAR(40) NOT NULL,"factId" TEXT NOT NULL,
 "currentValue" JSONB,"publishedValue" JSONB,"revision" BIGINT NOT NULL DEFAULT 1,
 "dirty" BOOLEAN NOT NULL DEFAULT TRUE,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("creatorId","kind","factId"),
 FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AnalyticsFactPublication_dirty_idx" ON "CreatorAnalyticsFactPublication" ("creatorId","dirty","kind","factId");
CREATE TABLE "CreatorAnalyticsPublicationState" (
 "creatorId" TEXT PRIMARY KEY,"agencyId" TEXT NOT NULL,"initialized" BOOLEAN NOT NULL DEFAULT FALSE,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CreatorAnalyticsPublicationState_agencyId_creatorId_key" ON "CreatorAnalyticsPublicationState"("agencyId","creatorId");
CREATE TABLE "CreatorAnalyticsDay" (
 "creatorId" TEXT NOT NULL,"agencyId" TEXT NOT NULL,"date" DATE NOT NULL,"values" JSONB NOT NULL DEFAULT '{}',
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY("creatorId","date"),
 FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "CreatorAnalyticsDayMember" (
 "creatorId" TEXT NOT NULL,"agencyId" TEXT NOT NULL,"date" DATE NOT NULL,"metric" VARCHAR(40) NOT NULL,
 "memberId" TEXT NOT NULL,"refs" INTEGER NOT NULL CHECK("refs">0),PRIMARY KEY("creatorId","date","metric","memberId"),
 FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "NotificationFactReceipt" (
 "jobId" TEXT NOT NULL,"kind" VARCHAR(40) NOT NULL,"factId" TEXT NOT NULL,"agencyId" TEXT NOT NULL,"creatorId" TEXT NOT NULL,
 "historical" BOOLEAN NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("jobId","kind","factId"),
 FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "NotificationFactReceipt_creatorId_jobId_idx" ON "NotificationFactReceipt"("creatorId","jobId");

CREATE FUNCTION "analytics_publication_value_v1"(kind TEXT,row_data JSONB) RETURNS JSONB
 LANGUAGE SQL IMMUTABLE AS $$ SELECT CASE WHEN row_data IS NULL THEN NULL ELSE
 jsonb_strip_nulls((SELECT jsonb_object_agg(key,value) FROM jsonb_each(row_data) WHERE key=ANY(
 CASE kind
 WHEN 'CreatorSale' THEN ARRAY['purchasedAt','saleType','amountCents','fanId']
 WHEN 'CreatorTip' THEN ARRAY['tippedAt','amountCents']
 WHEN 'CreatorSubscriptionEvent' THEN ARRAY['occurredAt','eventType','observedPriceCents']
 WHEN 'CreatorPaidSubscription' THEN ARRAY['paidAt','amountCents']
 WHEN 'CreatorPostLike' THEN ARRAY['likedAt','fanId']
 WHEN 'CreatorPostComment' THEN ARRAY['commentedAt','fanId']
 WHEN 'CreatorFinancialTransaction' THEN ARRAY['occurredAt','transactionType','transactionStatus','amountCents','netCents']
 WHEN 'CreatorMessagesDaily' THEN ARRAY['date','incomingMessages','outgoingMessages','uniqueDialogs','sourceTimezone']
 ELSE ARRAY[]::text[] END))) END $$;

CREATE FUNCTION "analytics_stage_fact_v1"(source_kind TEXT,row_data JSONB,is_deleted BOOLEAN DEFAULT FALSE,is_adoption BOOLEAN DEFAULT FALSE)
 RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE value JSONB; changed INTEGER;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=row_data->>'creatorId' AND "agencyId"=row_data->>'agencyId') THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM "DomainWorkItem" d WHERE d."agencyId"=row_data->>'agencyId' AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
   AND d."objectType"='Phase2CreatorDestructiveCleanup' AND d."objectId"=row_data->>'creatorId')
 OR EXISTS(SELECT 1 FROM "DomainWorkItem" d WHERE d."agencyId"=row_data->>'agencyId' AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
   AND d."objectType"='Phase2AgencyDestructiveCleanup' AND d."objectId"=row_data->>'agencyId') THEN RETURN; END IF;
 value:=CASE WHEN is_deleted THEN NULL ELSE "analytics_publication_value_v1"(source_kind,row_data) END;
 INSERT INTO "CreatorAnalyticsFactPublication"("agencyId","creatorId","kind","factId","currentValue")
 VALUES(row_data->>'agencyId',row_data->>'creatorId',source_kind,row_data->>'id',value)
 ON CONFLICT("creatorId","kind","factId") DO UPDATE SET
   "currentValue"=EXCLUDED."currentValue","dirty"=TRUE,
   "revision"="CreatorAnalyticsFactPublication"."revision"+1,"updatedAt"=clock_timestamp()
 WHERE NOT is_adoption AND "CreatorAnalyticsFactPublication"."currentValue" IS DISTINCT FROM EXCLUDED."currentValue";
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
   INSERT INTO "CreatorAnalyticsPublicationState"("agencyId","creatorId") VALUES(row_data->>'agencyId',row_data->>'creatorId') ON CONFLICT DO NOTHING;
   PERFORM "phase2_publish_domain_work"(row_data->>'agencyId','ANALYTICS_FACT_PUBLICATION','CreatorAccount',row_data->>'creatorId',row_data->>'creatorId',row_data->>'creatorId',NULL,NULL,NULL,0,clock_timestamp());
 END IF;
END $$;

CREATE FUNCTION "analytics_capture_fact_v1"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 PERFORM "analytics_stage_fact_v1"(TG_TABLE_NAME,CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,TG_OP='DELETE',FALSE);
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER "CreatorSale_analytics_publication_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorSale" FOR EACH ROW EXECUTE FUNCTION "analytics_capture_fact_v1"();
CREATE TRIGGER "CreatorTip_analytics_publication_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorTip" FOR EACH ROW EXECUTE FUNCTION "analytics_capture_fact_v1"();
CREATE TRIGGER "CreatorSubscriptionEvent_analytics_publication_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorSubscriptionEvent" FOR EACH ROW EXECUTE FUNCTION "analytics_capture_fact_v1"();
CREATE TRIGGER "CreatorPaidSubscription_analytics_publication_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorPaidSubscription" FOR EACH ROW EXECUTE FUNCTION "analytics_capture_fact_v1"();
CREATE TRIGGER "CreatorPostLike_analytics_publication_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorPostLike" FOR EACH ROW EXECUTE FUNCTION "analytics_capture_fact_v1"();
CREATE TRIGGER "CreatorPostComment_analytics_publication_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorPostComment" FOR EACH ROW EXECUTE FUNCTION "analytics_capture_fact_v1"();
CREATE TRIGGER "CreatorFinancialTransaction_analytics_publication_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorFinancialTransaction" FOR EACH ROW EXECUTE FUNCTION "analytics_capture_fact_v1"();
CREATE TRIGGER "CreatorMessagesDaily_analytics_publication_v1" AFTER INSERT OR UPDATE OR DELETE ON "CreatorMessagesDaily" FOR EACH ROW EXECUTE FUNCTION "analytics_capture_fact_v1"();

CREATE FUNCTION "analytics_new_creator_v1"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO "CreatorAnalyticsPublicationState"("agencyId","creatorId","initialized") VALUES(NEW."agencyId",NEW."id",TRUE) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER "CreatorAccount_analytics_publication_v1" AFTER INSERT ON "CreatorAccount" FOR EACH ROW EXECUTE FUNCTION "analytics_new_creator_v1"();

-- Same trigger entrypoint as the old bridge, but a new queue generation. This
-- captures the association before a later writer can replace sourceJobId.
CREATE OR REPLACE FUNCTION "phase5_notification_fact_consequences"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE job RECORD;
BEGIN
 FOR job IN SELECT "id","params" FROM "JobInstance" WHERE "id" IN (NEW."sourceJobId",CASE WHEN TG_OP='UPDATE' THEN OLD."sourceJobId" ELSE NULL END)
   AND "agencyId"=NEW."agencyId" AND "creatorId"=NEW."creatorId" AND "jobKey"='catchup_notifications_scan'
 LOOP
   INSERT INTO "NotificationFactReceipt"("jobId","kind","factId","agencyId","creatorId","historical")
     VALUES(job.id,TG_TABLE_NAME,NEW.id,NEW."agencyId",NEW."creatorId",COALESCE(job.params->>'notificationMode','')<>'catchup') ON CONFLICT DO NOTHING;
   PERFORM "phase2_publish_domain_work"(NEW."agencyId",'NOTIFICATION_FACT_RECEIPTS','JobInstance',job.id,NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,clock_timestamp());
 END LOOP;
 RETURN NEW;
END $$;

CREATE FUNCTION "analytics_published_writer_v1"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('onlinod.analytics_publication_writer',true) IS DISTINCT FROM '1' THEN
   RAISE EXCEPTION 'ANALYTICS_PUBLICATION_WRITER_REQUIRED';
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER "CreatorAnalyticsDay_writer_v1" BEFORE INSERT OR UPDATE ON "CreatorAnalyticsDay" FOR EACH ROW EXECUTE FUNCTION "analytics_published_writer_v1"();
CREATE TRIGGER "CreatorAnalyticsDayMember_writer_v1" BEFORE INSERT OR UPDATE ON "CreatorAnalyticsDayMember" FOR EACH ROW EXECUTE FUNCTION "analytics_published_writer_v1"();
CREATE FUNCTION "analytics_fact_publication_guard_v1"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW."creatorId",NEW."agencyId",NEW."kind",NEW."factId") IS DISTINCT FROM (OLD."creatorId",OLD."agencyId",OLD."kind",OLD."factId") THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_SCOPE_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND (NEW."publishedValue" IS DISTINCT FROM OLD."publishedValue" OR (OLD.dirty AND NOT NEW.dirty))
   AND current_setting('onlinod.analytics_publication_writer',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_WRITER_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "CreatorAnalyticsFactPublication_guard_v1" BEFORE INSERT OR UPDATE ON "CreatorAnalyticsFactPublication" FOR EACH ROW EXECUTE FUNCTION "analytics_fact_publication_guard_v1"();
CREATE FUNCTION "notification_fact_receipt_guard_v1"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'NOTIFICATION_FACT_RECEIPT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "NotificationFactReceipt_guard_v1" BEFORE UPDATE ON "NotificationFactReceipt" FOR EACH ROW EXECUTE FUNCTION "notification_fact_receipt_guard_v1"();

-- No fact scan, no rewrite of already-applied migrations, no falsified coverage.
INSERT INTO "MaintenanceLaneState"("key","generation","activeGeneration","cursor","progress","lastOutcome","createdAt","updatedAt")
SELECT k,k,k,jsonb_build_object('afterId','','upperId',COALESCE((SELECT id FROM "CreatorAccount" ORDER BY id DESC LIMIT 1),''),'cutoffAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'{}','PENDING',clock_timestamp(),clock_timestamp()
FROM unnest(ARRAY['analytics_publication_adoption_v1','phase5_notification_history_v3']) k ON CONFLICT DO NOTHING;
COMMIT;
