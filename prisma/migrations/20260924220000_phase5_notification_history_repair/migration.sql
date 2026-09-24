-- Populated deployments build these online in preflight before migrate deploy.
CREATE INDEX IF NOT EXISTS "CreatorSale_consequence_job_cursor_idx" ON "CreatorSale"("agencyId","creatorId","sourceJobId","id");
CREATE INDEX IF NOT EXISTS "CreatorSale_history_repair_cursor_idx" ON "CreatorSale"("agencyId","creatorId","createdAt","id");
CREATE INDEX IF NOT EXISTS "CreatorTip_consequence_job_cursor_idx" ON "CreatorTip"("agencyId","creatorId","sourceJobId","id");
CREATE INDEX IF NOT EXISTS "CreatorTip_history_repair_cursor_idx" ON "CreatorTip"("agencyId","creatorId","createdAt","id");
CREATE INDEX IF NOT EXISTS "CreatorSubscriptionEvent_consequence_job_cursor_idx" ON "CreatorSubscriptionEvent"("agencyId","creatorId","sourceJobId","id");
CREATE INDEX IF NOT EXISTS "CreatorSubscriptionEvent_history_repair_cursor_idx" ON "CreatorSubscriptionEvent"("agencyId","creatorId","createdAt","id");

-- One indexed catalog upper bound, no platform-wide fact scan in migration.
-- A durable short-transaction enumerator publishes ten creator intents per step.
INSERT INTO "MaintenanceLaneState" ("key","generation","activeGeneration","cursor","progress","lastOutcome","createdAt","updatedAt")
SELECT 'phase5_notification_history_v1','phase5_notification_history_v1','phase5_notification_history_v1',
  jsonb_build_object('afterId','','upperId',COALESCE((SELECT "id" FROM "CreatorAccount" ORDER BY "id" DESC LIMIT 1),''),
    'cutoffAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  '{"enumerated":0,"published":0}'::jsonb,'PENDING',clock_timestamp(),clock_timestamp()
ON CONFLICT ("key") DO NOTHING;
