BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "AdminCommand" DROP CONSTRAINT "AdminCommand_status_check";
ALTER TABLE "AdminCommand" ADD CONSTRAINT "AdminCommand_status_check" CHECK (
 "status" IN ('RUNNING','SUCCEEDED','REJECTED','QUEUED','PAUSED_AUTH','STOPPED_TARGET','COMPLETED_WITH_REJECTIONS','CANCELLED','RESUMED')
 OR ("action" = 'retention.run' AND "status" IN ('PARTIAL','FAILED'))
) NOT VALID;
ALTER TABLE "AdminCommand" VALIDATE CONSTRAINT "AdminCommand_status_check";
ALTER TABLE "SystemSetting" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SystemSetting" ADD CONSTRAINT "SystemSetting_revision_positive" CHECK ("revision" > 0);
CREATE FUNCTION phase4_retention_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP <> 'INSERT' AND OLD."key" = 'retention.policy.v1') OR (TG_OP <> 'DELETE' AND NEW."key" = 'retention.policy.v1') THEN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."key" <> OLD."key") THEN
   RAISE EXCEPTION 'RETENTION_POLICY_RESET_REQUIRES_REVISION';
  END IF;
  IF current_setting('onlinod.retention_policy_command', true) IS DISTINCT FROM 'v1' THEN
   RAISE EXCEPTION 'RETENTION_POLICY_COMMAND_REQUIRED';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW."revision" := OLD."revision" + 1;
  ELSE NEW."revision" := 1; END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "phase4_retention_policy_revision" BEFORE INSERT OR UPDATE OR DELETE ON "SystemSetting"
 FOR EACH ROW EXECUTE FUNCTION phase4_retention_policy_revision();
CREATE UNIQUE INDEX "AdminCommand_one_active_retention_run" ON "AdminCommand" ("action")
 WHERE "action" = 'retention.run' AND "status" IN ('QUEUED','RUNNING') AND "executionPayload" IS NOT NULL;
CREATE INDEX "AdminCommand_actorId_action_createdAt_id_idx" ON "AdminCommand" ("actorId","action","createdAt","id");
COMMIT;
