-- Runtime recovery reads only this exact quarantine, never all historical work.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "DomainWorkItem_notification_refresh_recovery_idx"
ON "DomainWorkItem" ("id")
WHERE "state"='RECONCILE_REQUIRED'
  AND "terminalCause"='RETRY_EXHAUSTED:NOTIFICATION_BUMP_PROJECTION_FAILED:FAN_DATA_REFRESH_BACKLOG_FULL'
  AND "workClass" IN ('NOTIFICATION_CONSEQUENCES','NOTIFICATION_CONSEQUENCES_V2','NOTIFICATION_FACT_RECEIPTS')
  AND ("lastRepair"->>'kind') IS DISTINCT FROM 'notification_refresh_capacity_recovery_v1';
