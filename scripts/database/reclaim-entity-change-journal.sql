-- ONE-TIME, EXPLICIT maintenance in the main DATABASE_URL database (neondb).
-- Deploy Backend 187 first and stop Desktop while running this entire script.
-- Only the recoverable delivery journal is emptied. Current entity snapshots,
-- canonical financial facts, messages, work items and CRM are not truncated.
-- Failure (including lock timeout) rolls the whole transaction back. Do not add
-- CASCADE, RESTART IDENTITY, or another table to TRUNCATE.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Publishers and readers take the head before touching the journal. Take the
-- table lock in that same order; new creators cannot escape a row-only fence.
LOCK TABLE "public"."CreatorEntityChangeHead" IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."_prisma_migrations"
      WHERE migration_name = '20261027010000_entity_change_window187'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'BACKEND_187_MIGRATION_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."CreatorEntityChangeHead" h
      WHERE h."lastRevision" > 0 AND NOT EXISTS (
        SELECT 1 FROM "public"."CreatorEntityCurrent" c
        WHERE c."creatorId"=h."creatorId" AND c."agencyId"=h."agencyId" AND c.revision=h."lastRevision"))
    OR EXISTS (SELECT 1 FROM "public"."CreatorEntityCurrent" c
      LEFT JOIN "public"."CreatorEntityChangeHead" h ON h."creatorId"=c."creatorId"
      WHERE h."creatorId" IS NULL OR h."agencyId"<>c."agencyId" OR c.revision>h."lastRevision") THEN
    RAISE EXCEPTION 'ENTITY_CURRENT_SNAPSHOT_REQUIRED';
  END IF;
END
$guard$;
TRUNCATE TABLE "public"."CreatorEntityChange";
UPDATE "public"."CreatorEntityChangeHead"
SET "retainedFrom"="lastRevision"+1, "nextRetentionAt"=NULL, "updatedAt"=clock_timestamp();
COMMIT;

-- Verify the physical result, not just a deleted-row count.
SELECT current_database() AS database,
       pg_total_relation_size('public."CreatorEntityChange"'::regclass) AS journal_bytes,
       pg_database_size(current_database()) AS database_bytes,
       (SELECT coalesce(sum(pg_database_size(oid)),0)::bigint FROM pg_database
        WHERE NOT datistemplate AND has_database_privilege(oid,'CONNECT')) AS branch_bytes;
