-- A dedicated monotone revision for the identity fields consumed by CRM audience reads.
CREATE TABLE IF NOT EXISTS "CreatorFanIdentityHead" (
  "creatorId" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId",id) ON DELETE CASCADE
);
INSERT INTO "CreatorFanIdentityHead" ("creatorId","agencyId",revision)
SELECT "creatorId","agencyId",1 FROM "CreatorFan" GROUP BY "creatorId","agencyId" ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION nod_bump_fan_identity_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid text; aid text;
BEGIN
  IF TG_OP='UPDATE' AND ROW(OLD."creatorId",OLD."agencyId",OLD."onlyFansUserId",OLD.username,OLD."displayName")
    IS NOT DISTINCT FROM ROW(NEW."creatorId",NEW."agencyId",NEW."onlyFansUserId",NEW.username,NEW."displayName") THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN
    cid:=OLD."creatorId"; aid:=OLD."agencyId";
    INSERT INTO "CreatorFanIdentityHead"("creatorId","agencyId",revision)
      SELECT cid,aid,1 WHERE EXISTS(SELECT 1 FROM "CreatorAccount" WHERE id=cid AND "agencyId"=aid)
    ON CONFLICT ("creatorId") DO UPDATE SET revision="CreatorFanIdentityHead".revision+1;
  END IF;
  IF TG_OP='INSERT' OR TG_OP='UPDATE' AND ROW(OLD."creatorId",OLD."agencyId") IS DISTINCT FROM ROW(NEW."creatorId",NEW."agencyId") THEN
    INSERT INTO "CreatorFanIdentityHead"("creatorId","agencyId",revision) VALUES(NEW."creatorId",NEW."agencyId",1)
    ON CONFLICT ("creatorId") DO UPDATE SET revision="CreatorFanIdentityHead".revision+1;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS nod_creator_fan_identity_revision ON "CreatorFan";
CREATE TRIGGER nod_creator_fan_identity_revision AFTER INSERT OR DELETE OR UPDATE OF "creatorId","agencyId","onlyFansUserId",username,"displayName"
  ON "CreatorFan" FOR EACH ROW EXECUTE FUNCTION nod_bump_fan_identity_revision();

-- Stable snapshot fence for server-paged template management.
CREATE TABLE IF NOT EXISTS "AutomationTemplateScopeRevision" (
  "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY("agencyId","creatorId"),
  FOREIGN KEY("agencyId") REFERENCES "Agency"(id) ON DELETE CASCADE
);
INSERT INTO "AutomationTemplateScopeRevision"("agencyId","creatorId",revision)
SELECT "agencyId",coalesce("creatorId",''),1 FROM "AutomationTask" GROUP BY "agencyId","creatorId" ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION nod_bump_automation_template_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO "AutomationTemplateScopeRevision"("agencyId","creatorId",revision)
    SELECT OLD."agencyId",coalesce(OLD."creatorId",''),1 WHERE EXISTS(SELECT 1 FROM "Agency" WHERE id=OLD."agencyId")
    ON CONFLICT("agencyId","creatorId") DO UPDATE SET revision="AutomationTemplateScopeRevision".revision+1;
  END IF;
  IF TG_OP='INSERT' OR TG_OP='UPDATE' AND ROW(OLD."agencyId",OLD."creatorId") IS DISTINCT FROM ROW(NEW."agencyId",NEW."creatorId") THEN
    INSERT INTO "AutomationTemplateScopeRevision"("agencyId","creatorId",revision) VALUES(NEW."agencyId",coalesce(NEW."creatorId",''),1)
    ON CONFLICT("agencyId","creatorId") DO UPDATE SET revision="AutomationTemplateScopeRevision".revision+1;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS nod_automation_template_revision ON "AutomationTask";
CREATE TRIGGER nod_automation_template_revision AFTER INSERT OR UPDATE OR DELETE ON "AutomationTask"
  FOR EACH ROW EXECUTE FUNCTION nod_bump_automation_template_revision();
