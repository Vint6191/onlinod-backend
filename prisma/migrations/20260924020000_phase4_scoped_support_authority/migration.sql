-- Support uses its own admin identity and bounded diagnostic grant. Customer
-- impersonation is retired at the database boundary during a rolling deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE "User", "RefreshSession", "ImpersonationToken" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE "AdminSupportGrant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "actorAccessEpoch" INTEGER NOT NULL,
  "agencyId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "AdminSupportGrant_epoch_positive" CHECK ("actorAccessEpoch">=1),
  CONSTRAINT "AdminSupportGrant_expiry" CHECK ("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '30 minutes')
);
CREATE OR REPLACE FUNCTION phase4_support_grant_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."actorId",NEW."sessionId",NEW."actorAccessEpoch",NEW."agencyId",NEW."reason",NEW."createdAt",NEW."expiresAt")
     IS DISTINCT FROM ROW(OLD."id",OLD."actorId",OLD."sessionId",OLD."actorAccessEpoch",OLD."agencyId",OLD."reason",OLD."createdAt",OLD."expiresAt")
     OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "phase4_support_grant_immutable" BEFORE UPDATE ON "AdminSupportGrant" FOR EACH ROW EXECUTE FUNCTION phase4_support_grant_immutable();
-- Identity values deliberately survive source row retention, as command receipts
-- do. Every read revalidates the current admin, session and agency under locks.
CREATE INDEX "AdminSupportGrant_actorId_createdAt_id_idx" ON "AdminSupportGrant"("actorId","createdAt","id");
CREATE INDEX "AdminSupportGrant_sessionId_idx" ON "AdminSupportGrant"("sessionId");
CREATE INDEX "AdminSupportGrant_expiresAt_idx" ON "AdminSupportGrant"("expiresAt");
-- Legacy access JWTs have no support marker and cannot be distinguished from
-- direct unbound JWTs. Invalidate access for affected users only; preserve all
-- refresh history and record the operational effect in the migration audit.
WITH affected AS (
  UPDATE "User" u SET "sessionsRevokedAt"=timezone('UTC',clock_timestamp())
  WHERE EXISTS (SELECT 1 FROM "RefreshSession" r WHERE r."userId"=u."id" AND r."impersonatedByAdminId" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "ImpersonationToken" i WHERE i."targetUserId"=u."id")
  RETURNING u."id"
)
INSERT INTO "AdminActionLog"("id","adminUserId","action","targetType","targetId","after","reason","createdAt")
SELECT 'phase4:scoped-support-cutover:v1','SYSTEM_MIGRATION','support.legacy_retired','system','support',
 jsonb_build_object('affectedUsers',count(*),'legacyCustomerSessionsRetired',true),'Replace customer impersonation with scoped admin diagnostics',timezone('UTC',clock_timestamp()) FROM affected;
UPDATE "RefreshSession" SET "revokedAt"=COALESCE("revokedAt",timezone('UTC',clock_timestamp())) WHERE "impersonatedByAdminId" IS NOT NULL AND "revokedAt" IS NULL;
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_no_live_impersonation" CHECK ("impersonatedByAdminId" IS NULL OR "revokedAt" IS NOT NULL) NOT VALID;
ALTER TABLE "RefreshSession" VALIDATE CONSTRAINT "RefreshSession_no_live_impersonation";
CREATE OR REPLACE FUNCTION phase4_reject_legacy_impersonation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'LEGACY_IMPERSONATION_RETIRED' USING ERRCODE='55000'; END $$;
CREATE TRIGGER "phase4_impersonation_token_retired" BEFORE INSERT OR UPDATE ON "ImpersonationToken" FOR EACH ROW EXECUTE FUNCTION phase4_reject_legacy_impersonation();
COMMIT;
