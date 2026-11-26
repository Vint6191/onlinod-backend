BEGIN;

-- Aggregate version protects every writer, including ownership and platform administration.
-- accessEpoch and housekeeping are deliberately not edit fields.
CREATE OR REPLACE FUNCTION nod_member_edit_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."displayName", NEW."roleKey", NEW."role", NEW."permissions", NEW."assignedCreators",
         NEW."deactivatedAt", NEW."deletedAt", NEW."initials", NEW."tone", NEW."commission",
         NEW."statusBadge", NEW."isTest")
     IS DISTINCT FROM
     ROW(OLD."displayName", OLD."roleKey", OLD."role", OLD."permissions", OLD."assignedCreators",
         OLD."deactivatedAt", OLD."deletedAt", OLD."initials", OLD."tone", OLD."commission",
         OLD."statusBadge", OLD."isTest") THEN
    NEW."editRevision" := OLD."editRevision" + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AgencyMember_edit_revision"
BEFORE UPDATE ON "AgencyMember"
FOR EACH ROW EXECUTE FUNCTION nod_member_edit_revision();

ALTER TABLE "CreatorRealtimeSession" ADD COLUMN "unackedThroughAt" TIMESTAMP(3);

CREATE INDEX "TeamPpvResolveJob_agency_status_created_id_idx" ON "TeamPpvResolveJob" ("agencyId", "status", "createdAt", "id");
CREATE INDEX "TeamPpvResolveJob_creator_status_created_id_idx" ON "TeamPpvResolveJob" ("agencyId", "creatorId", "status", "createdAt", "id");

COMMIT;
