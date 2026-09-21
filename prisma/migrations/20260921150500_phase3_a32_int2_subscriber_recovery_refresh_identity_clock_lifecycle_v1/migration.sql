-- Phase 3 A32 INT2: close Subscriber recovery lease semantics, derived refresh identity,
-- and creator-partitioned observation clock lifecycle.
--
-- FanObservationCreatorClock is live creator execution chronology. Historical
-- orphan rows (hard-deleted creators) and rows owned by already-retired creators
-- must not survive into the FK-backed lifecycle contract.
DELETE FROM "FanObservationCreatorClock" c
USING "CreatorAccount" a
WHERE a."id" = c."creatorId"
  AND a."deletedAt" IS NOT NULL;

DELETE FROM "FanObservationCreatorClock" c
WHERE NOT EXISTS (
  SELECT 1
  FROM "CreatorAccount" a
  WHERE a."id" = c."creatorId"
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = current_schema()
      AND rel.relname = 'FanObservationCreatorClock'
      AND con.conname = 'FanObservationCreatorClock_creatorId_fkey'
  ) THEN
    ALTER TABLE "FanObservationCreatorClock"
      ADD CONSTRAINT "FanObservationCreatorClock_creatorId_fkey"
      FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
