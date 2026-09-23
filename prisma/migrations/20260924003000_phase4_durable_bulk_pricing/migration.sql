BEGIN;
-- R1/R2 migrations are already applied and must remain immutable.
ALTER TABLE "AdminCommand" DROP CONSTRAINT "AdminCommand_status_check";
ALTER TABLE "AdminCommand" ADD CONSTRAINT "AdminCommand_status_check"
 CHECK ("status" IN ('RUNNING','SUCCEEDED','REJECTED','QUEUED','PAUSED_AUTH','STOPPED_TARGET','COMPLETED_WITH_REJECTIONS','CANCELLED','RESUMED')) NOT VALID;
ALTER TABLE "AdminCommand" VALIDATE CONSTRAINT "AdminCommand_status_check";
ALTER TABLE "AdminCommand" ADD COLUMN "executionPayload" JSONB, ADD COLUMN "executionProgress" JSONB;
INSERT INTO "Phase2WorkGenerationAuthority"("workClass","activeGeneration","projectionVersion","revision","activatedAt","createdAt","updatedAt")
VALUES ('ADMIN_BILLING_PRICING','phase4_admin_pricing_v1','phase4_admin_pricing_v1',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
-- Detached receipts survive Agency cascade. This locks no Agency/actor rows.
CREATE FUNCTION onlinod_admin_bulk_work_deleted_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command_row "AdminCommand"%ROWTYPE;
BEGIN
 IF OLD."workClass"='ADMIN_BILLING_PRICING' AND OLD."objectType"='AdminCommand' THEN
  UPDATE "AdminCommand" SET "status"='STOPPED_TARGET',"completedAt"=clock_timestamp(),
   "executionProgress"=COALESCE("executionProgress",'{}'::jsonb)||jsonb_build_object('stoppedCode','ADMIN_WORK_REMOVED')
   WHERE "id"=OLD."objectId" AND "scopeAgencyId"=OLD."agencyId" AND "action"='billing.pricing.bulk' AND "status" IN ('QUEUED','RUNNING')
   RETURNING * INTO command_row;
  IF FOUND THEN
   INSERT INTO "AdminCommandAudit"("id","commandId","sequence","actorId","action","targetId","scopeAgencyId","event","reason","detail","createdAt")
   VALUES('admin-work-removed-'||md5(command_row."id"),command_row."id",2147483647,command_row."actorId",command_row."action",command_row."targetId",command_row."scopeAgencyId",'STOPPED_TARGET',command_row."reason",jsonb_build_object('code','ADMIN_WORK_REMOVED','progress',command_row."executionProgress"),clock_timestamp());
  END IF;
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER "DomainWorkItem_admin_receipt_delete_v1" BEFORE DELETE ON "DomainWorkItem"
 FOR EACH ROW EXECUTE FUNCTION onlinod_admin_bulk_work_deleted_v1();
COMMIT;
