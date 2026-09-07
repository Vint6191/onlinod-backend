-- Legacy creator-retirement closure.
--
-- Before Custom Content Pipeline Authority existed, a creator could be soft-deleted
-- while durable provider/submission/write facts were still unresolved. The new
-- runtime correctly blocks that transition prospectively; this migration makes
-- any historical debt explicit without inventing a successful external outcome.

-- 1) Proven-precommit CUSTOM relay writes cannot execute for an already-retired
-- creator. RUNNING is still precommit in Audit17; COMMITTING and
-- RECONCILE_REQUIRED are deliberately preserved for explicit outcome settlement.
UPDATE "AutomationDelivery" AS d
SET
  "status" = 'CANCELED',
  "failureCode" = 'custom_pipeline_legacy_creator_retired_precommit',
  "failureCategory" = 'TERMINAL',
  "lastError" = 'Creator was retired before Custom Content Pipeline Authority cutover; precommit relay was cancelled without claiming an external outcome',
  "finishedAt" = COALESCE(d."finishedAt", NOW()),
  "claimedByDeviceId" = NULL,
  "claimedAt" = NULL,
  "claimUntil" = NULL,
  "leaseTokenHash" = NULL,
  "leaseRevision" = d."leaseRevision" + 1,
  "lastCheckedAt" = NOW(),
  "updatedAt" = NOW()
FROM "CreatorAccount" AS c
WHERE c."id" = d."creatorId"
  AND c."agencyId" = d."agencyId"
  AND c."deletedAt" IS NOT NULL
  AND d."actionType" = 'CUSTOM_RELAY_SEND'
  AND d."status" IN ('QUEUED', 'RETRY_SCHEDULED', 'CLAIMED', 'RUNNING');

-- 2) Unmaterialized provider media is durable work too. A deleted creator cannot
-- silently turn PENDING/FAILED_RETRYABLE into "nothing"; route it to the existing
-- audited manager exception workflow instead. No media is discarded here.
UPDATE "TelegramInboundEvent" AS e
SET
  "projectionState" = 'REVIEW_REQUIRED',
  "projectionReason" = 'CREATOR_RETIRED_LEGACY',
  "projectedAt" = COALESCE(e."projectedAt", NOW()),
  "updatedAt" = NOW()
FROM "CreatorAccount" AS c
WHERE c."id" = e."creatorId"
  AND c."agencyId" = e."agencyId"
  AND c."deletedAt" IS NOT NULL
  AND e."hasMedia" = TRUE
  AND e."submissionId" IS NULL
  AND e."projectionState" IN ('PENDING', 'FAILED_RETRYABLE');

-- 3) Existing unresolved submissions remain business facts. Mark them blocked so
-- broad managers can see the migration debt in Pipeline Resolution. Do NOT
-- ARCHIVE/ABANDON confirmed media automatically: a historical CreatorMediaAsset
-- row is not proof of current pinned Vault settlement.
UPDATE "CustomContentSubmission" AS s
SET
  "pipelineBlockedCode" = 'CUSTOM_SUBMISSION_CREATOR_RETIRED_LEGACY',
  "pipelineBlockedAt" = COALESCE(s."pipelineBlockedAt", NOW()),
  "pipelineNextAttemptAt" = NULL,
  "updatedAt" = NOW()
FROM "CreatorAccount" AS c
WHERE c."id" = s."creatorId"
  AND c."agencyId" = s."agencyId"
  AND c."deletedAt" IS NOT NULL
  AND (
    s."pipelineDisposition" = 'SALVAGE'
    OR (s."pipelineDisposition" = 'ACTIVE' AND s."customOrderId" IS NULL)
    OR (
      s."pipelineDisposition" = 'ACTIVE'
      AND EXISTS (
        SELECT 1
        FROM "CustomOrder" AS o
        WHERE o."id" = s."customOrderId"
          AND o."agencyId" = s."agencyId"
          AND o."creatorId" = s."creatorId"
          AND o."type" = 'CONTENT'
          AND o."status" = 'PENDING'
          AND o."fanDeliveredAt" IS NULL
      )
    )
  );
