-- Phase 2 / Actual56 final closure C5+C6
-- One bounded Agency creator-catalog revision replaces O(all live members)
-- accessEpoch/event fanout on Creator creation. Human Creator writes are fenced
-- in application code by the canonical management commit authority.

BEGIN;

-- Baseline + trigger publication is atomic. Render may keep the previous binary
-- serving while migrations run, so no live Creator membership change may land
-- between the initial catalog snapshot and publication of its bump trigger.
LOCK TABLE "CreatorAccount" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS "AgencyCreatorCatalogState" (
  "agencyId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgencyCreatorCatalogState_pkey" PRIMARY KEY ("agencyId"),
  CONSTRAINT "AgencyCreatorCatalogState_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgencyCreatorCatalogState_generation_positive" CHECK ("generation" > 0)
);

INSERT INTO "AgencyCreatorCatalogState" ("agencyId", "generation", "updatedAt")
SELECT a."id", 1, clock_timestamp()
FROM "Agency" a
ON CONFLICT ("agencyId") DO NOTHING;

CREATE OR REPLACE FUNCTION phase2_bump_creator_catalog_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_agency_id TEXT;
  v_old_live BOOLEAN := FALSE;
  v_new_live BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_live := OLD."deletedAt" IS NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_live := NEW."deletedAt" IS NULL;
  END IF;

  -- Ignore metadata-only updates: the catalog membership did not change.
  IF TG_OP = 'UPDATE'
     AND OLD."agencyId" IS NOT DISTINCT FROM NEW."agencyId"
     AND v_old_live = v_new_live THEN
    RETURN NEW;
  END IF;

  -- If an UPDATE moves a live Creator across Agencies, advance both catalogs.
  IF TG_OP = 'UPDATE'
     AND OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
     AND v_old_live THEN
    INSERT INTO "AgencyCreatorCatalogState" ("agencyId", "generation", "updatedAt")
    VALUES (OLD."agencyId", 1, clock_timestamp())
    ON CONFLICT ("agencyId") DO UPDATE
      SET "generation" = "AgencyCreatorCatalogState"."generation" + 1,
          "updatedAt" = clock_timestamp();
  END IF;

  IF (TG_OP = 'DELETE' AND v_old_live) OR (TG_OP = 'UPDATE' AND v_old_live AND NOT v_new_live) THEN
    v_agency_id := OLD."agencyId";
  ELSIF (TG_OP = 'INSERT' AND v_new_live) OR (TG_OP = 'UPDATE' AND v_new_live AND (NOT v_old_live OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId")) THEN
    v_agency_id := NEW."agencyId";
  ELSE
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  INSERT INTO "AgencyCreatorCatalogState" ("agencyId", "generation", "updatedAt")
  VALUES (v_agency_id, 1, clock_timestamp())
  ON CONFLICT ("agencyId") DO UPDATE
    SET "generation" = "AgencyCreatorCatalogState"."generation" + 1,
        "updatedAt" = clock_timestamp();

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_phase2_creator_catalog_generation ON "CreatorAccount";
CREATE TRIGGER trg_phase2_creator_catalog_generation
AFTER INSERT OR DELETE OR UPDATE OF "agencyId", "deletedAt"
ON "CreatorAccount"
FOR EACH ROW
EXECUTE FUNCTION phase2_bump_creator_catalog_generation();

COMMIT;
