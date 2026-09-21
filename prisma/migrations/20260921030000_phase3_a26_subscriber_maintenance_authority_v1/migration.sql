-- Phase 3 A26: durable creator-scoped Subscriber publication recovery + retention authority.
-- Recovery fairness and replica exclusion are owned by a SKIP LOCKED signal lane;
-- retention is durable and may never delete unfinished publication debt.

CREATE TABLE IF NOT EXISTS "SubscriberDirectoryMaintenanceSignal" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" VARCHAR(64) NOT NULL DEFAULT 'PUBLICATION_DEBT',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimToken" VARCHAR(120),
  "claimUntil" TIMESTAMP(3),
  "lastError" VARCHAR(1000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriberDirectoryMaintenanceSignal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SubscriberDirectoryMaintenanceSignal_kind_check" CHECK ("kind" IN ('RECOVERY','RETENTION')),
  CONSTRAINT "SubscriberDirectoryMaintenanceSignal_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "SubscriberDirectoryMaintenanceSignal_attempts_nonnegative" CHECK ("attempts" >= 0)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='SubscriberDirectoryMaintenanceSignal_agencyId_fkey') THEN
    ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
      ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_agencyId_fkey"
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='SubscriberDirectoryMaintenanceSignal_creator_fkey') THEN
    ALTER TABLE "SubscriberDirectoryMaintenanceSignal"
      ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_creator_fkey"
      FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "SubscriberDirectoryMaintenanceSignal_creator_kind_key"
  ON "SubscriberDirectoryMaintenanceSignal"("creatorId","kind");

-- Claim query: oldest due creator first. attempts<100 is the durable poison/dead-letter boundary.
CREATE INDEX IF NOT EXISTS "SubscriberDirectoryMaintenanceSignal_due_claim_idx"
  ON "SubscriberDirectoryMaintenanceSignal"(
    "dueAt",
    "creatorId",
    "kind",
    (COALESCE("claimUntil", '-infinity'::timestamp))
  )
  WHERE "attempts" < 100;

-- Bounded retention candidate query, excluding every unfinished publication phase by predicate.
CREATE INDEX IF NOT EXISTS "SubscriberScanRun_retention_eligible_idx"
  ON "SubscriberScanRun"("creatorId","createdAt" DESC,"id")
  WHERE "status" IN ('SUPERSEDED','FAILED')
    AND "publicationStatus" = 'COMPLETE';

CREATE INDEX IF NOT EXISTS "SubscriberScanRun_creator_reconcile_idx"
  ON "SubscriberScanRun"("creatorId","updatedAt","id")
  WHERE "status" IN ('PUBLISHED','SUPERSEDED')
    AND "publicationStatus" = 'COMPLETE'
    AND "publicationJobReconciledAt" IS NULL;

-- Repair/seed state authority for every durable publication debt creator. Never lower a generation.
WITH debt AS (
  SELECT r."agencyId", r."creatorId",
         MAX(r."publicationGeneration")::integer AS "maxGeneration",
         MAX(CASE WHEN r."status" IN ('PUBLISHED','SUPERSEDED') AND r."publicationStatus"='COMPLETE'
                  THEN r."publicationGeneration" ELSE 0 END)::integer AS "maxPublishedGeneration"
  FROM "SubscriberScanRun" r
  WHERE (r."hasMore"=false AND r."fanProjectionStatus"='COMPLETE' AND r."publicationStatus" IN ('PENDING','CURRENT','PREVIOUS','FINALIZE'))
     OR (r."status" IN ('PUBLISHED','SUPERSEDED') AND r."publicationStatus"='COMPLETE' AND r."publicationJobReconciledAt" IS NULL)
  GROUP BY r."agencyId", r."creatorId"
)
INSERT INTO "SubscriberDirectoryState" (
  "id","agencyId","creatorId","status","publicationGeneration","publishedGeneration","summary","createdAt","updatedAt"
)
SELECT
  'substate_a26_' || md5(d."creatorId"), d."agencyId", d."creatorId", 'SCANNING',
  GREATEST(d."maxGeneration",1), GREATEST(d."maxPublishedGeneration",0), '{}'::jsonb,
  clock_timestamp(), clock_timestamp()
FROM debt d
ON CONFLICT ("creatorId") DO UPDATE SET
  "publicationGeneration" = GREATEST("SubscriberDirectoryState"."publicationGeneration", EXCLUDED."publicationGeneration"),
  "publishedGeneration" = GREATEST("SubscriberDirectoryState"."publishedGeneration", EXCLUDED."publishedGeneration"),
  "updatedAt" = clock_timestamp();

-- Existing stranded publication/reconciliation debt enters the durable recovery queue.
WITH debt AS (
  SELECT r."agencyId", r."creatorId", MIN(r."updatedAt") AS "dueAt"
  FROM "SubscriberScanRun" r
  WHERE (r."hasMore"=false AND r."fanProjectionStatus"='COMPLETE' AND r."publicationStatus" IN ('PENDING','CURRENT','PREVIOUS','FINALIZE'))
     OR (r."status" IN ('PUBLISHED','SUPERSEDED') AND r."publicationStatus"='COMPLETE' AND r."publicationJobReconciledAt" IS NULL)
  GROUP BY r."agencyId", r."creatorId"
)
INSERT INTO "SubscriberDirectoryMaintenanceSignal" (
  "id","agencyId","creatorId","kind","dueAt","reason","revision","attempts","createdAt","updatedAt"
)
SELECT 'submaint_a26_' || md5(d."creatorId" || ':RECOVERY'), d."agencyId", d."creatorId", 'RECOVERY', d."dueAt",
       'A26_BACKFILL_PUBLICATION_DEBT', 1, 0, clock_timestamp(), clock_timestamp()
FROM debt d
ON CONFLICT ("creatorId","kind") DO UPDATE SET
  "dueAt"=LEAST("SubscriberDirectoryMaintenanceSignal"."dueAt",EXCLUDED."dueAt"),
  "revision"="SubscriberDirectoryMaintenanceSignal"."revision"+1,
  "attempts"=0,
  "lastError"=NULL,
  "updatedAt"=clock_timestamp();

-- Existing safely completed history enters bounded durable retention.
WITH retention AS (
  SELECT r."agencyId", r."creatorId", MIN(r."updatedAt") AS "dueAt"
  FROM "SubscriberScanRun" r
  WHERE r."status" IN ('SUPERSEDED','FAILED') AND r."publicationStatus"='COMPLETE'
  GROUP BY r."agencyId", r."creatorId"
)
INSERT INTO "SubscriberDirectoryMaintenanceSignal" (
  "id","agencyId","creatorId","kind","dueAt","reason","revision","attempts","createdAt","updatedAt"
)
SELECT 'submaint_a26_' || md5(x."creatorId" || ':RETENTION'), x."agencyId", x."creatorId", 'RETENTION', x."dueAt",
       'A26_BACKFILL_RETENTION', 1, 0, clock_timestamp(), clock_timestamp()
FROM retention x
ON CONFLICT ("creatorId","kind") DO UPDATE SET
  "dueAt"=LEAST("SubscriberDirectoryMaintenanceSignal"."dueAt",EXCLUDED."dueAt"),
  "revision"="SubscriberDirectoryMaintenanceSignal"."revision"+1,
  "attempts"=0,
  "lastError"=NULL,
  "updatedAt"=clock_timestamp();
