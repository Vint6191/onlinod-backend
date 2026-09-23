-- Exactly one operational OWNER for each live Agency. Retired Agency history may
-- be cleaned up; restoration must re-establish this invariant in its transaction.
-- Existing ambiguous ownership is a blocker, never an arbitrary auto-demotion.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('phase2:release-activation:TEAM_CONTROL_PLANE'));
LOCK TABLE "Agency", "User", "AgencyMember" IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE blocker TEXT;
BEGIN
  SELECT a."id" INTO blocker FROM "Agency" a
  LEFT JOIN "AgencyMember" m ON m."agencyId"=a."id" AND m."deletedAt" IS NULL
    AND (m."roleKey"='owner' OR m."role"='OWNER')
  LEFT JOIN "User" u ON u."id"=m."userId"
  GROUP BY a."id",a."deletedAt"
  HAVING count(m."id")>1 OR (a."deletedAt" IS NULL AND
    (count(m."id")<>1 OR count(m."id") FILTER (WHERE m."deactivatedAt" IS NULL AND u."disabledAt" IS NULL)<>1))
  ORDER BY a."id" LIMIT 1;
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE4_SINGLE_OWNER_PREFLIGHT_FAILED agency=%',blocker
      USING ERRCODE='23514', HINT='Resolve ownership explicitly before rollout. No owner is selected or demoted by this migration.';
  END IF;
END $$;
CREATE UNIQUE INDEX "AgencyMember_single_owner_agency_idx" ON "AgencyMember" ("agencyId")
  WHERE "deletedAt" IS NULL AND ("roleKey"='owner' OR "role"='OWNER');
CREATE OR REPLACE FUNCTION phase4_assert_single_owner(agency_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE owner_count INT; operational_count INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agency" WHERE "id"=agency_id AND "deletedAt" IS NULL) THEN RETURN; END IF;
  SELECT count(*),count(*) FILTER (WHERE m."deactivatedAt" IS NULL AND u."disabledAt" IS NULL)
    INTO owner_count,operational_count FROM "AgencyMember" m JOIN "User" u ON u."id"=m."userId"
    WHERE m."agencyId"=agency_id AND m."deletedAt" IS NULL AND (m."roleKey"='owner' OR m."role"='OWNER');
  IF owner_count<>1 OR operational_count<>1 THEN
    RAISE EXCEPTION 'PHASE4_EXACTLY_ONE_OPERATIONAL_OWNER_REQUIRED agency=%',agency_id USING ERRCODE='23514';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION phase4_check_member_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' AND (OLD."roleKey"='owner' OR OLD."role"='OWNER') THEN PERFORM phase4_assert_single_owner(OLD."agencyId"); END IF;
  IF TG_OP<>'DELETE' AND (NEW."roleKey"='owner' OR NEW."role"='OWNER') THEN PERFORM phase4_assert_single_owner(NEW."agencyId"); END IF;
  RETURN NULL;
END $$;
-- Only owner lifecycle/role changes schedule a deferred check. Hot accessEpoch,
-- ordinary role/scope edits and historical non-owner rows do not scan ownership.
CREATE CONSTRAINT TRIGGER "phase4_owner_member_insert" AFTER INSERT ON "AgencyMember" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."roleKey"='owner' OR NEW."role"='OWNER') EXECUTE FUNCTION phase4_check_member_owner();
CREATE CONSTRAINT TRIGGER "phase4_owner_member_delete" AFTER DELETE ON "AgencyMember" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."roleKey"='owner' OR OLD."role"='OWNER') EXECUTE FUNCTION phase4_check_member_owner();
CREATE CONSTRAINT TRIGGER "phase4_owner_member_update" AFTER UPDATE ON "AgencyMember" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN ((OLD."roleKey"='owner' OR OLD."role"='OWNER' OR NEW."roleKey"='owner' OR NEW."role"='OWNER') AND
    (OLD."agencyId" IS DISTINCT FROM NEW."agencyId" OR OLD."userId" IS DISTINCT FROM NEW."userId" OR OLD."roleKey" IS DISTINCT FROM NEW."roleKey" OR OLD."role" IS DISTINCT FROM NEW."role" OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt" OR OLD."deactivatedAt" IS DISTINCT FROM NEW."deactivatedAt"))
  EXECUTE FUNCTION phase4_check_member_owner();
CREATE OR REPLACE FUNCTION phase4_check_agency_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN PERFORM phase4_assert_single_owner(NEW."id"); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER "phase4_owner_agency_insert" AFTER INSERT ON "Agency" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase4_check_agency_owner();
CREATE CONSTRAINT TRIGGER "phase4_owner_agency_restore" AFTER UPDATE ON "Agency" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt" AND NEW."deletedAt" IS NULL) EXECUTE FUNCTION phase4_check_agency_owner();
CREATE OR REPLACE FUNCTION phase4_check_user_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE agency_id TEXT;
BEGIN
  FOR agency_id IN SELECT "agencyId" FROM "AgencyMember" WHERE "userId"=NEW."id" AND "deletedAt" IS NULL AND ("roleKey"='owner' OR "role"='OWNER')
    LOOP PERFORM phase4_assert_single_owner(agency_id); END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "phase4_owner_user_disable" AFTER UPDATE ON "User" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt" AND NEW."disabledAt" IS NOT NULL) EXECUTE FUNCTION phase4_check_user_owner();
COMMIT;
