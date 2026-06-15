-- ONLINOD v19.2 — automation retention indexes + scheduler cleanup support.
-- Tables already exist from automation_server_core_v7; this migration only adds
-- indexes that make daily retention sweeps cheap and lock-light.

CREATE INDEX IF NOT EXISTS "AutomationJob_status_completedAt_idx"
  ON "AutomationJob"("status", "completedAt");

CREATE INDEX IF NOT EXISTS "AutomationJob_status_updatedAt_idx"
  ON "AutomationJob"("status", "updatedAt");

CREATE INDEX IF NOT EXISTS "AutomationEvent_createdAt_idx"
  ON "AutomationEvent"("createdAt");

CREATE INDEX IF NOT EXISTS "AutomationTask_status_deletedAt_idx"
  ON "AutomationTask"("status", "deletedAt");
