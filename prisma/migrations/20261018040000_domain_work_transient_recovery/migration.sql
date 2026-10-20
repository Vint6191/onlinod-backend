-- Pure SQL planners/projections must survive database outages. This index also
-- lets health checks distinguish an empty queue from durable quarantined work.
CREATE INDEX IF NOT EXISTS "DomainWorkItem_reconcile_class_current_idx"
  ON "DomainWorkItem" ("workClass", "activeGeneration", "id")
  WHERE "isOutstanding" AND "state"='RECONCILE_REQUIRED';

-- One-time adoption of work quarantined by the old eight-error policy. Do not
-- touch live leases, other generations, contract failures, provider writes, or
-- an ambiguous P2028 transaction error. Executors still recheck scope/lifecycle.
UPDATE "DomainWorkItem" w SET
  "state"='READY', "ownerToken"=NULL,
  "leaseUntil"=(clock_timestamp() AT TIME ZONE 'UTC'),
  "availableAt"=(clock_timestamp() AT TIME ZONE 'UTC'), "nextAttemptAt"=NULL,
  "consecutiveFailures"=0, "failureRevision"=0, "lastFailureAt"=NULL,
  "errorClass"=NULL, "lastError"=NULL, "terminalCause"=NULL,
  "lastRepair"=jsonb_build_object(
    'kind','database_outage_recovery_v1', 'at',clock_timestamp(),
    'previousError',w."lastError", 'previousCause',w."terminalCause",
    'previousFailures',w."consecutiveFailures"),
  "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
WHERE w."isOutstanding" AND w."state"='RECONCILE_REQUIRED'
  AND w."activeGeneration"='phase2_domain_work_v3_actual55'
  AND w."workClass" IN ('CREATOR_RECURRING_PLANNING','ANALYTICS_PUBLICATION','ANALYTICS_FACT_PUBLICATION','ANALYTICS_FACT_ADOPTION')
  AND w."errorClass"='RETRY_EXHAUSTED'
  AND (
    w."terminalCause" IN (
      'RETRY_EXHAUSTED:P1001','RETRY_EXHAUSTED:P1002','RETRY_EXHAUSTED:P1008','RETRY_EXHAUSTED:P1017',
      'RETRY_EXHAUSTED:P2024','RETRY_EXHAUSTED:P2034',
      'RETRY_EXHAUSTED:08000','RETRY_EXHAUSTED:08001','RETRY_EXHAUSTED:08003','RETRY_EXHAUSTED:08006','RETRY_EXHAUSTED:08007',
      'RETRY_EXHAUSTED:40001','RETRY_EXHAUSTED:40P01','RETRY_EXHAUSTED:55P03','RETRY_EXHAUSTED:57014',
      'RETRY_EXHAUSTED:57P01','RETRY_EXHAUSTED:57P02','RETRY_EXHAUSTED:57P03','RETRY_EXHAUSTED:53300',
      'RETRY_EXHAUSTED:DB_COMMIT_DEADLINE_EXCEEDED'
    )
    OR (w."terminalCause"='RETRY_EXHAUSTED:P2028' AND (
      w."lastError" LIKE '%Unable to start a transaction in the given time%'
      OR (w."lastError" LIKE '%cannot be executed on an expired transaction%'
        AND w."lastError" ~ 'The timeout for this transaction was [0-9]+ ms, however [0-9]+ ms passed')
    ))
    OR (w."terminalCause"='RETRY_EXHAUSTED:P2010'
      AND w."lastError" ~ 'Raw query failed\. Code: [`''"](08000|08001|08003|08006|08007|40001|40P01|55P03|57014|57P01|57P02|57P03|53300)[`''"]')
    OR (w."workClass"='CREATOR_RECURRING_PLANNING'
      AND w."terminalCause"='RETRY_EXHAUSTED:CREATOR_RECURRING_PLANNING_DEGRADED'
      AND w."lastError" ~ '^CREATOR_RECURRING_PLANNING_DEGRADED: (analytics_planning|creator_planning|daily_vault_intelligence|creator_analytics|subscriber_directory_scan|follow_back_plan|bumps_plan|likes_plan|follow_automation_plan|sfs_plan):(P1001|P1002|P1008|P1017|P2024|P2034|08000|08001|08003|08006|08007|40001|40P01|55P03|57014|57P01|57P02|57P03|53300|DB_COMMIT_DEADLINE_EXCEEDED)(; (analytics_planning|creator_planning|daily_vault_intelligence|creator_analytics|subscriber_directory_scan|follow_back_plan|bumps_plan|likes_plan|follow_automation_plan|sfs_plan):(P1001|P1002|P1008|P1017|P2024|P2034|08000|08001|08003|08006|08007|40001|40P01|55P03|57014|57P01|57P02|57P03|53300|DB_COMMIT_DEADLINE_EXCEEDED))*$')
  )
  AND EXISTS (SELECT 1 FROM "Agency" a WHERE a.id=w."agencyId" AND a."deletedAt" IS NULL)
  AND EXISTS (SELECT 1 FROM "CreatorAccount" c WHERE c.id=w."creatorId" AND c."agencyId"=w."agencyId" AND c."deletedAt" IS NULL);
