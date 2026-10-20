-- One-time deployment adoption of already-collected publication work. Read the
-- two existing partial indexes, not the creator catalog or scan history. The
-- ordinary maintenance pump resumes each durable publication cursor in chunks.
WITH publication_debt AS (
  SELECT "agencyId", "creatorId" FROM "SubscriberScanRun"
  WHERE "fanProjectionStatus"='COMPLETE' AND "hasMore"=false
    AND "publicationStatus" IN ('PENDING','CURRENT','PREVIOUS','FINALIZE')
  UNION
  SELECT "agencyId", "creatorId" FROM "SubscriberScanRun"
  WHERE "status" IN ('PUBLISHED','SUPERSEDED') AND "publicationStatus"='COMPLETE'
    AND "publicationJobReconciledAt" IS NULL
)
INSERT INTO "SubscriberDirectoryMaintenanceSignal" (
  "id","agencyId","creatorId","kind","dueAt","reason","revision","attempts","createdAt","updatedAt"
)
SELECT 'submaint_recovery_' || md5(d."creatorId"),d."agencyId",d."creatorId",'RECOVERY',
  (clock_timestamp() AT TIME ZONE 'UTC'),'PUBLICATION_DEBT',1,0,
  (clock_timestamp() AT TIME ZONE 'UTC'),(clock_timestamp() AT TIME ZONE 'UTC')
FROM publication_debt d
JOIN "CreatorAccount" c ON c."id"=d."creatorId" AND c."agencyId"=d."agencyId" AND c."deletedAt" IS NULL
JOIN "Agency" a ON a."id"=d."agencyId" AND a."deletedAt" IS NULL
ON CONFLICT ("creatorId","kind") DO NOTHING;

-- Older workers charged temporary SQL outages against the permanent poison
-- budget. Match only the exact stored diagnostics accepted by db-retry-policy;
-- a generic timeout/P2028 or domain contradiction is deliberately insufficient.
-- No live lease, healthy backoff, retention task or completed history is reset.
WITH publication_debt AS (
  SELECT "agencyId", "creatorId" FROM "SubscriberScanRun"
  WHERE "fanProjectionStatus"='COMPLETE' AND "hasMore"=false
    AND "publicationStatus" IN ('PENDING','CURRENT','PREVIOUS','FINALIZE')
  UNION
  SELECT "agencyId", "creatorId" FROM "SubscriberScanRun"
  WHERE "status" IN ('PUBLISHED','SUPERSEDED') AND "publicationStatus"='COMPLETE'
    AND "publicationJobReconciledAt" IS NULL
)
UPDATE "SubscriberDirectoryMaintenanceSignal" s SET
  "attempts"=0,"lastError"=NULL,"claimToken"=NULL,"claimUntil"=NULL,
  "dueAt"=LEAST(s."dueAt",(clock_timestamp() AT TIME ZONE 'UTC')),
  "reason"='TRANSIENT_DATABASE_RECOVERY',"revision"=s."revision"+1,
  "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
FROM publication_debt d
JOIN "CreatorAccount" c ON c."id"=d."creatorId" AND c."agencyId"=d."agencyId" AND c."deletedAt" IS NULL
JOIN "Agency" a ON a."id"=d."agencyId" AND a."deletedAt" IS NULL
WHERE s."agencyId"=d."agencyId" AND s."creatorId"=d."creatorId" AND s."kind"='RECOVERY'
  AND s."attempts">=100
  AND COALESCE(s."claimUntil",'-infinity'::timestamp)<=(clock_timestamp() AT TIME ZONE 'UTC')
  AND (
    s."lastError" ~ '^\[TRANSIENT_DB:(P1001|P1002|P1008|P1017|P2024|P2034|08000|08001|08003|08006|08007|40001|40P01|55P03|57014|57P01|57P02|57P03|53300|DB_COMMIT_DEADLINE_EXCEEDED|P2028|DB_TRANSIENT_AGGREGATE)\] '
    OR s."lastError" ~* 'Unable to start a transaction in the given time\y'
    OR (s."lastError" ~* 'cannot be executed on an expired transaction\y'
      AND s."lastError" ~* 'The timeout for this transaction was [0-9]+ ms, however [0-9]+ ms passed\y')
    OR s."lastError" ~ 'Raw query failed\. Code: [`''"](08000|08001|08003|08006|08007|40001|40P01|55P03|57014|57P01|57P02|57P03|53300)[`''"]'
    OR s."lastError" ~ '^[[:space:]]*Timed out fetching a new connection from the connection pool\.'
    OR s."lastError" ~ '^[[:space:]]*Can''t reach database server at [^\r\n]+(\r?\n[[:space:]]*Please make sure your database server is running at [^\r\n]+\.)?[[:space:]]*$'
    OR s."lastError" ~ '^[[:space:]]*Server has closed the connection\.?[[:space:]]*$'
    -- Prisma 5.22 query initialization errors may retain only this invocation
    -- envelope. Require both its prefix and an exact terminal DB diagnostic.
    OR (s."lastError" ~ '^[[:space:]]*Invalid `[^`\r\n]+` invocation( in)?(:|[[:space:]])'
      AND s."lastError" ~ '\n[[:space:]]*\n(Timed out fetching a new connection from the connection pool\..*|Can''t reach database server at [^\r\n]+(\r?\n[[:space:]]*Please make sure your database server is running at [^\r\n]+\.)?|Server has closed the connection\.?)[[:space:]]*$')
  );
