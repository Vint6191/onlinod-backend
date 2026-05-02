-- Orchestration v1
-- Storage for creator metrics (earnings, campaigns) + job queue.

-- ───────────────────────────────────────────────────────────────
-- CreatorEarningsSnapshot — last known earnings per (creator, range)
-- One row per (creatorId, rangeKey). Upserted by chatter machines
-- via /api/stats/earnings/upsert. Owner UI reads via /api/stats/...
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CreatorEarningsSnapshot" (
  "id"                TEXT NOT NULL,
  "creatorId"         TEXT NOT NULL,
  "agencyId"          TEXT NOT NULL,
  "rangeKey"          TEXT NOT NULL,         -- "24h" | "7d" | "30d" | "90d" | ...
  "rangeStartAt"      TIMESTAMP(3),
  "rangeEndAt"        TIMESTAMP(3),
  "totalCents"        BIGINT NOT NULL DEFAULT 0,
  "grossCents"        BIGINT NOT NULL DEFAULT 0,
  "deltaCents"        BIGINT NOT NULL DEFAULT 0,
  "salesCount"        INTEGER NOT NULL DEFAULT 0,
  "uniqueFans"        INTEGER NOT NULL DEFAULT 0,
  "avgSaleCents"      INTEGER NOT NULL DEFAULT 0,
  "fanLtvCents"       INTEGER NOT NULL DEFAULT 0,
  "raw"               JSONB,                  -- full earnings payload for debug
  "capturedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedByDeviceId" TEXT,
  "capturedByUserId"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorEarningsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorEarningsSnapshot_creator_range_key"
  ON "CreatorEarningsSnapshot"("creatorId", "rangeKey");
CREATE INDEX IF NOT EXISTS "CreatorEarningsSnapshot_agencyId_idx" ON "CreatorEarningsSnapshot"("agencyId");
CREATE INDEX IF NOT EXISTS "CreatorEarningsSnapshot_capturedAt_idx" ON "CreatorEarningsSnapshot"("capturedAt");

ALTER TABLE "CreatorEarningsSnapshot"
  DROP CONSTRAINT IF EXISTS "CreatorEarningsSnapshot_creatorId_fkey";
ALTER TABLE "CreatorEarningsSnapshot"
  ADD CONSTRAINT "CreatorEarningsSnapshot_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorEarningsSnapshot"
  DROP CONSTRAINT IF EXISTS "CreatorEarningsSnapshot_agencyId_fkey";
ALTER TABLE "CreatorEarningsSnapshot"
  ADD CONSTRAINT "CreatorEarningsSnapshot_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────────────────────────────────────────
-- CreatorCampaignsSnapshot — last known campaigns list per creator
-- Campaigns is account-scoped (not range-scoped) — one row per creator.
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CreatorCampaignsSnapshot" (
  "id"                TEXT NOT NULL,
  "creatorId"         TEXT NOT NULL,
  "agencyId"          TEXT NOT NULL,
  "rangeKey"          TEXT NOT NULL DEFAULT '7d', -- range used for mini-trend
  "campaigns"         JSONB NOT NULL DEFAULT '[]',
  "totalActive"       INTEGER NOT NULL DEFAULT 0,
  "totalClaimers"     INTEGER NOT NULL DEFAULT 0,
  "totalClicks"       INTEGER NOT NULL DEFAULT 0,
  "capturedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedByDeviceId" TEXT,
  "capturedByUserId"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorCampaignsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorCampaignsSnapshot_creatorId_key"
  ON "CreatorCampaignsSnapshot"("creatorId");
CREATE INDEX IF NOT EXISTS "CreatorCampaignsSnapshot_agencyId_idx" ON "CreatorCampaignsSnapshot"("agencyId");

ALTER TABLE "CreatorCampaignsSnapshot"
  DROP CONSTRAINT IF EXISTS "CreatorCampaignsSnapshot_creatorId_fkey";
ALTER TABLE "CreatorCampaignsSnapshot"
  ADD CONSTRAINT "CreatorCampaignsSnapshot_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorCampaignsSnapshot"
  DROP CONSTRAINT IF EXISTS "CreatorCampaignsSnapshot_agencyId_fkey";
ALTER TABLE "CreatorCampaignsSnapshot"
  ADD CONSTRAINT "CreatorCampaignsSnapshot_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────────────────────────────────────────
-- JobInstance — work queue with leases
-- Each row = one piece of work (e.g. "fetch earnings for Bella, 7d range")
-- States:
--   SCHEDULED  → waiting for a worker, available for claim
--   CLAIMED    → a worker took it, leaseUntil tells when lease expires
--   DONE       → worker reported success
--   FAILED     → worker reported failure, attempts++, requeued after backoff
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "JobInstance" (
  "id"                TEXT NOT NULL,
  "jobKey"            TEXT NOT NULL,         -- "fetch_earnings" | "fetch_campaigns" | ...
  "scope"             TEXT NOT NULL,         -- "creator" | "agency" | "global"
  "creatorId"         TEXT,
  "agencyId"          TEXT,
  "params"            JSONB,                  -- e.g. { rangeKey: "7d" }
  "status"            TEXT NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED|CLAIMED|RUNNING|DONE|FAILED
  "priority"          INTEGER NOT NULL DEFAULT 0,        -- higher = picked first; refresh-now bumps to 100
  "scheduledAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextRunAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt"         TIMESTAMP(3),
  "claimedByDeviceId" TEXT,
  "leaseUntil"        TIMESTAMP(3),
  "startedAt"         TIMESTAMP(3),
  "completedAt"       TIMESTAMP(3),
  "lastError"         TEXT,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "result"            JSONB,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobInstance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobInstance_status_nextRunAt_idx"  ON "JobInstance"("status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "JobInstance_creatorId_idx"          ON "JobInstance"("creatorId");
CREATE INDEX IF NOT EXISTS "JobInstance_agencyId_idx"           ON "JobInstance"("agencyId");
CREATE INDEX IF NOT EXISTS "JobInstance_jobKey_idx"             ON "JobInstance"("jobKey");
CREATE INDEX IF NOT EXISTS "JobInstance_claimedByDeviceId_idx"  ON "JobInstance"("claimedByDeviceId");
CREATE INDEX IF NOT EXISTS "JobInstance_leaseUntil_idx"         ON "JobInstance"("leaseUntil");

ALTER TABLE "JobInstance"
  DROP CONSTRAINT IF EXISTS "JobInstance_creatorId_fkey";
ALTER TABLE "JobInstance"
  ADD CONSTRAINT "JobInstance_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobInstance"
  DROP CONSTRAINT IF EXISTS "JobInstance_agencyId_fkey";
ALTER TABLE "JobInstance"
  ADD CONSTRAINT "JobInstance_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────────────────────────────────────────
-- Convenience: prevent duplicate "scheduled" jobs for the same
-- creator+jobKey+rangeKey. We do this in code (not via partial
-- unique index) because (params->>'rangeKey') is awkward to index
-- portably. See routes/jobs.js scheduleEarningsJob().
-- ───────────────────────────────────────────────────────────────
