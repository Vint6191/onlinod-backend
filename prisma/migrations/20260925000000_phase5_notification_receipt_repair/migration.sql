BEGIN;
SET LOCAL lock_timeout = '5s';

-- Separate work generation: old history claims and cursors are never reset.
-- V2 repairs retained facts with the I6 policy, including old rows updated
-- after the V1 cutoff. A creation-time tail alone would miss those updates. Effects
-- remain paged; the migration scans neither facts nor jobs.
INSERT INTO "MaintenanceLaneState" ("key","generation","activeGeneration","cursor","progress","lastOutcome","createdAt","updatedAt")
SELECT 'phase5_notification_history_v2','phase5_notification_history_v2','phase5_notification_history_v2',
  jsonb_build_object('afterId','','upperId',COALESCE((SELECT "id" FROM "CreatorAccount" ORDER BY "id" DESC LIMIT 1),''),
    'tailFrom',(SELECT "cursor"->>'cutoffAt' FROM "MaintenanceLaneState" WHERE "key"='phase5_notification_history_v1'),
    'cutoffAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  '{"enumerated":0,"published":0}'::jsonb,'PENDING',clock_timestamp(),clock_timestamp()
ON CONFLICT ("key") DO NOTHING;

-- Bridge the interval between migration commit and the last old replica stopping.
-- Old binaries do not publish full-scan consequences. Canonical row changes now
-- publish V2 in their own commit; V1 consumers cannot claim this generation.
CREATE OR REPLACE FUNCTION "phase5_notification_fact_consequences"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."sourceJobId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "JobInstance" j
    WHERE j."id"=NEW."sourceJobId" AND j."agencyId"=NEW."agencyId"
      AND j."creatorId"=NEW."creatorId" AND j."jobKey"='catchup_notifications_scan'
  ) THEN
    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'NOTIFICATION_CONSEQUENCES_V2','JobInstance',NEW."sourceJobId",
      NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,clock_timestamp()
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CreatorSale_phase5_notification_consequences"
AFTER INSERT OR UPDATE ON "CreatorSale"
FOR EACH ROW EXECUTE FUNCTION "phase5_notification_fact_consequences"();
CREATE TRIGGER "CreatorTip_phase5_notification_consequences"
AFTER INSERT OR UPDATE ON "CreatorTip"
FOR EACH ROW EXECUTE FUNCTION "phase5_notification_fact_consequences"();
CREATE TRIGGER "CreatorSubscriptionEvent_phase5_notification_consequences"
AFTER INSERT OR UPDATE ON "CreatorSubscriptionEvent"
FOR EACH ROW EXECUTE FUNCTION "phase5_notification_fact_consequences"();
COMMIT;
