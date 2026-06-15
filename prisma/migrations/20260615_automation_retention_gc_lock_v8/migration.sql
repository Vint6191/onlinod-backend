-- ONLINOD v19.7 — automation retention indexes + self-healing core tables.
--
-- Why this migration is intentionally defensive:
-- Some deployments may have the v7 migration recorded in _prisma_migrations
-- while the AutomationTask/AutomationJob/AutomationEvent tables are missing
-- because of an interrupted/bad deploy state. v8 used to assume v7 created the
-- tables and failed with: relation "AutomationJob" does not exist.
--
-- Keep the CREATE TABLE IF NOT EXISTS block here. It makes v8 safe whether:
-- 1) v7 runs normally before v8,
-- 2) v7 was already applied correctly,
-- 3) v7 was marked/applied but the tables are missing.

CREATE TABLE IF NOT EXISTS "AutomationTask" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT,
  "clientId" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT 'Untitled automation',
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "status" TEXT NOT NULL DEFAULT 'active',
  "config" JSONB NOT NULL DEFAULT '{}',
  "triggers" JSONB NOT NULL DEFAULT '{}',
  "rules" JSONB NOT NULL DEFAULT '{}',
  "schedule" JSONB NOT NULL DEFAULT '{}',
  "stats" JSONB NOT NULL DEFAULT '{}',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT,
  "updatedByUserId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "AutomationJob" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "taskId" TEXT,
  "creatorId" TEXT,
  "accountId" TEXT,
  "fanId" TEXT,
  "dialogId" TEXT,
  "type" TEXT NOT NULL,
  "action" TEXT NOT NULL DEFAULT 'run',
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedByDeviceId" TEXT,
  "claimedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "dedupeKey" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "AutomationEvent" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "taskId" TEXT,
  "jobId" TEXT,
  "creatorId" TEXT,
  "accountId" TEXT,
  "fanId" TEXT,
  "dialogId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'info',
  "messageId" TEXT,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Core indexes from automation_server_core_v7, repeated with IF NOT EXISTS for repair safety.
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationTask_agencyId_clientId_key" ON "AutomationTask"("agencyId", "clientId");
CREATE INDEX IF NOT EXISTS "AutomationTask_agencyId_type_status_idx" ON "AutomationTask"("agencyId", "type", "status");
CREATE INDEX IF NOT EXISTS "AutomationTask_creatorId_type_status_idx" ON "AutomationTask"("creatorId", "type", "status");
CREATE INDEX IF NOT EXISTS "AutomationTask_enabled_idx" ON "AutomationTask"("enabled");
CREATE INDEX IF NOT EXISTS "AutomationTask_deletedAt_idx" ON "AutomationTask"("deletedAt");
CREATE INDEX IF NOT EXISTS "AutomationTask_updatedAt_idx" ON "AutomationTask"("updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "AutomationJob_agencyId_dedupeKey_key" ON "AutomationJob"("agencyId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "AutomationJob_agencyId_status_runAfter_idx" ON "AutomationJob"("agencyId", "status", "runAfter");
CREATE INDEX IF NOT EXISTS "AutomationJob_agencyId_type_status_idx" ON "AutomationJob"("agencyId", "type", "status");
CREATE INDEX IF NOT EXISTS "AutomationJob_creatorId_status_idx" ON "AutomationJob"("creatorId", "status");
CREATE INDEX IF NOT EXISTS "AutomationJob_taskId_status_idx" ON "AutomationJob"("taskId", "status");
CREATE INDEX IF NOT EXISTS "AutomationJob_claimedByDeviceId_claimedAt_idx" ON "AutomationJob"("claimedByDeviceId", "claimedAt");
CREATE INDEX IF NOT EXISTS "AutomationJob_fanId_idx" ON "AutomationJob"("fanId");
CREATE INDEX IF NOT EXISTS "AutomationJob_createdAt_idx" ON "AutomationJob"("createdAt");

CREATE INDEX IF NOT EXISTS "AutomationEvent_agencyId_createdAt_idx" ON "AutomationEvent"("agencyId", "createdAt");
CREATE INDEX IF NOT EXISTS "AutomationEvent_agencyId_type_createdAt_idx" ON "AutomationEvent"("agencyId", "type", "createdAt");
CREATE INDEX IF NOT EXISTS "AutomationEvent_creatorId_fanId_idx" ON "AutomationEvent"("creatorId", "fanId");
CREATE INDEX IF NOT EXISTS "AutomationEvent_taskId_idx" ON "AutomationEvent"("taskId");
CREATE INDEX IF NOT EXISTS "AutomationEvent_jobId_idx" ON "AutomationEvent"("jobId");
CREATE INDEX IF NOT EXISTS "AutomationEvent_messageId_idx" ON "AutomationEvent"("messageId");

-- Retention indexes from v8.
CREATE INDEX IF NOT EXISTS "AutomationJob_status_completedAt_idx"
  ON "AutomationJob"("status", "completedAt");

CREATE INDEX IF NOT EXISTS "AutomationJob_status_updatedAt_idx"
  ON "AutomationJob"("status", "updatedAt");

CREATE INDEX IF NOT EXISTS "AutomationEvent_createdAt_idx"
  ON "AutomationEvent"("createdAt");

CREATE INDEX IF NOT EXISTS "AutomationTask_status_deletedAt_idx"
  ON "AutomationTask"("status", "deletedAt");
