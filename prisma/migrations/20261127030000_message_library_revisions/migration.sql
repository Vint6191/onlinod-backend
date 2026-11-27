BEGIN;
SET LOCAL lock_timeout = '5s';
-- A listing token covers every persisted collection/block mutation, including
-- background trash cleanup and writers that predate the paginated client.
CREATE TABLE "MessageLibraryScopeRevision" (
  "agencyId" text NOT NULL,
  "creatorId" text NOT NULL,
  "revision" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "MessageLibraryScopeRevision_pkey" PRIMARY KEY ("agencyId", "creatorId"),
  CONSTRAINT "MessageLibraryScopeRevision_revision_nonnegative" CHECK ("revision" >= 0)
);

INSERT INTO "MessageLibraryScopeRevision" ("agencyId", "creatorId", "revision")
SELECT DISTINCT "agencyId", "creatorId", 1 FROM "ContentCollection"
WHERE "kind" = 'message_library_script' AND "creatorId" IS NOT NULL;

CREATE FUNCTION message_library_collection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_agency text; prior_creator text; next_agency text; next_creator text; affected record;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."kind" = 'message_library_script' THEN
    prior_agency := OLD."agencyId"; prior_creator := OLD."creatorId";
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."kind" = 'message_library_script' THEN
    next_agency := NEW."agencyId"; next_creator := NEW."creatorId";
  END IF;
  FOR affected IN SELECT DISTINCT a, c FROM (VALUES (prior_agency, prior_creator), (next_agency, next_creator)) AS scopes(a,c)
    WHERE a IS NOT NULL AND c IS NOT NULL ORDER BY a,c LOOP
    INSERT INTO "MessageLibraryScopeRevision" ("agencyId", "creatorId", "revision") VALUES (affected.a, affected.c, 1)
    ON CONFLICT ("agencyId", "creatorId") DO UPDATE SET "revision" = "MessageLibraryScopeRevision"."revision" + 1;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION message_library_block_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_id text; next_id text; affected record;
BEGIN
  IF TG_OP <> 'INSERT' THEN prior_id := OLD."collectionId"; END IF;
  IF TG_OP <> 'DELETE' THEN next_id := NEW."collectionId"; END IF;
  FOR affected IN SELECT DISTINCT "agencyId", "creatorId" FROM "ContentCollection"
    WHERE "id" IN (prior_id,next_id) AND "kind" = 'message_library_script' AND "creatorId" IS NOT NULL
    ORDER BY "agencyId","creatorId" LOOP
    INSERT INTO "MessageLibraryScopeRevision" ("agencyId", "creatorId", "revision") VALUES (affected."agencyId", affected."creatorId", 1)
    ON CONFLICT ("agencyId", "creatorId") DO UPDATE SET "revision" = "MessageLibraryScopeRevision"."revision" + 1;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "ContentCollection_message_library_revision"
AFTER INSERT OR UPDATE OR DELETE ON "ContentCollection"
FOR EACH ROW EXECUTE FUNCTION message_library_collection_revision();

CREATE TRIGGER "ContentBlock_message_library_revision"
AFTER INSERT OR UPDATE OR DELETE ON "ContentBlock"
FOR EACH ROW EXECUTE FUNCTION message_library_block_revision();

COMMIT;
