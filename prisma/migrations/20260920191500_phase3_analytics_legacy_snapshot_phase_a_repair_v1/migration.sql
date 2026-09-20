-- Phase 3 Analytics legacy snapshot Phase-A repair.
--
-- Some production databases already applied the earlier destructive revision of
-- 20260920123000_phase3_analytics_final_authority_cutover_v1, which replaced the
-- three legacy writable tables with zero-row read-only tombstone views. The
-- current source keeps that migration non-destructive for databases that have
-- not applied it yet, but an already-applied migration is never re-run.
--
-- This forward-only repair therefore restores the exact legacy writable table
-- contracts for the rolling-deploy / rollback window. Current Phase-3 runtime
-- does not read these tables as authority. They exist only so an older backend
-- revision can finish in-flight Prisma upserts safely until Phase B.

DO $$
DECLARE
  relation_kind "char";
  relation_comment text;
  relation_rows bigint;
BEGIN
  SELECT c.relkind, obj_description(c.oid, 'pg_class')
    INTO relation_kind, relation_comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = 'AnalyticsSnapshot'
  LIMIT 1;

  IF relation_kind = 'v' THEN
    EXECUTE 'SELECT COUNT(*)::bigint FROM "AnalyticsSnapshot"' INTO relation_rows;
    IF relation_rows <> 0 OR relation_comment IS DISTINCT FROM 'Phase-3 rolling-deploy tombstone; zero rows; remove after legacy revision drain' THEN
      RAISE EXCEPTION 'Refusing to replace unexpected AnalyticsSnapshot view (rows=%, comment=%)', relation_rows, relation_comment;
    END IF;
    DROP VIEW "AnalyticsSnapshot";
  ELSIF relation_kind IS NOT NULL AND relation_kind <> 'r' THEN
    RAISE EXCEPTION 'Unexpected AnalyticsSnapshot relkind: %', relation_kind;
  END IF;
END $$;

DO $$
DECLARE
  relation_kind "char";
  relation_comment text;
  relation_rows bigint;
BEGIN
  SELECT c.relkind, obj_description(c.oid, 'pg_class')
    INTO relation_kind, relation_comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = 'CreatorCampaignsSnapshot'
  LIMIT 1;

  IF relation_kind = 'v' THEN
    EXECUTE 'SELECT COUNT(*)::bigint FROM "CreatorCampaignsSnapshot"' INTO relation_rows;
    IF relation_rows <> 0 OR relation_comment IS DISTINCT FROM 'Phase-3 rolling-deploy tombstone; zero rows; remove after legacy revision drain' THEN
      RAISE EXCEPTION 'Refusing to replace unexpected CreatorCampaignsSnapshot view (rows=%, comment=%)', relation_rows, relation_comment;
    END IF;
    DROP VIEW "CreatorCampaignsSnapshot";
  ELSIF relation_kind IS NOT NULL AND relation_kind <> 'r' THEN
    RAISE EXCEPTION 'Unexpected CreatorCampaignsSnapshot relkind: %', relation_kind;
  END IF;
END $$;

DO $$
DECLARE
  relation_kind "char";
  relation_comment text;
  relation_rows bigint;
BEGIN
  SELECT c.relkind, obj_description(c.oid, 'pg_class')
    INTO relation_kind, relation_comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = 'CreatorEarningsSnapshot'
  LIMIT 1;

  IF relation_kind = 'v' THEN
    EXECUTE 'SELECT COUNT(*)::bigint FROM "CreatorEarningsSnapshot"' INTO relation_rows;
    IF relation_rows <> 0 OR relation_comment IS DISTINCT FROM 'Phase-3 rolling-deploy tombstone; zero rows; remove after legacy revision drain' THEN
      RAISE EXCEPTION 'Refusing to replace unexpected CreatorEarningsSnapshot view (rows=%, comment=%)', relation_rows, relation_comment;
    END IF;
    DROP VIEW "CreatorEarningsSnapshot";
  ELSIF relation_kind IS NOT NULL AND relation_kind <> 'r' THEN
    RAISE EXCEPTION 'Unexpected CreatorEarningsSnapshot relkind: %', relation_kind;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "AnalyticsSnapshot" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "rangeKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AnalyticsSnapshot_agencyId_scope_rangeKey_key" ON "AnalyticsSnapshot"("agencyId", "scope", "rangeKey");
CREATE INDEX IF NOT EXISTS "AnalyticsSnapshot_agencyId_scope_idx" ON "AnalyticsSnapshot"("agencyId", "scope");
CREATE INDEX IF NOT EXISTS "AnalyticsSnapshot_capturedAt_idx" ON "AnalyticsSnapshot"("capturedAt");

CREATE TABLE IF NOT EXISTS "CreatorCampaignsSnapshot" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "rangeKey" TEXT NOT NULL DEFAULT '7d',
  "campaigns" JSONB NOT NULL DEFAULT '[]',
  "totalActive" INTEGER NOT NULL DEFAULT 0,
  "totalClaimers" INTEGER NOT NULL DEFAULT 0,
  "totalClicks" INTEGER NOT NULL DEFAULT 0,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedByDeviceId" TEXT,
  "capturedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorCampaignsSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorCampaignsSnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CreatorCampaignsSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CreatorCampaignsSnapshot_creatorId_key" ON "CreatorCampaignsSnapshot"("creatorId");
CREATE INDEX IF NOT EXISTS "CreatorCampaignsSnapshot_agencyId_idx" ON "CreatorCampaignsSnapshot"("agencyId");

CREATE TABLE IF NOT EXISTS "CreatorEarningsSnapshot" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "rangeKey" TEXT NOT NULL,
  "rangeStartAt" TIMESTAMP(3),
  "rangeEndAt" TIMESTAMP(3),
  "totalCents" BIGINT NOT NULL DEFAULT 0,
  "grossCents" BIGINT NOT NULL DEFAULT 0,
  "deltaCents" BIGINT NOT NULL DEFAULT 0,
  "salesCount" INTEGER NOT NULL DEFAULT 0,
  "uniqueFans" INTEGER NOT NULL DEFAULT 0,
  "avgSaleCents" INTEGER NOT NULL DEFAULT 0,
  "fanLtvCents" INTEGER NOT NULL DEFAULT 0,
  "raw" JSONB,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedByDeviceId" TEXT,
  "capturedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorEarningsSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorEarningsSnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CreatorEarningsSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CreatorEarningsSnapshot_creator_range_key" ON "CreatorEarningsSnapshot"("creatorId", "rangeKey");
CREATE INDEX IF NOT EXISTS "CreatorEarningsSnapshot_agencyId_idx" ON "CreatorEarningsSnapshot"("agencyId");
CREATE INDEX IF NOT EXISTS "CreatorEarningsSnapshot_capturedAt_idx" ON "CreatorEarningsSnapshot"("capturedAt");
