CREATE TABLE "CreatorNotificationSyncState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
  "mode" TEXT NOT NULL DEFAULT 'full',
  "scanRunId" TEXT,
  "nextCursor" TEXT,
  "headNotificationId" TEXT,
  "tailNotificationId" TEXT,
  "oldestOccurredAt" TIMESTAMP(3),
  "newestOccurredAt" TIMESTAMP(3),
  "pagesScanned" INTEGER NOT NULL DEFAULT 0,
  "eventsAccepted" INTEGER NOT NULL DEFAULT 0,
  "eventsRejected" INTEGER NOT NULL DEFAULT 0,
  "ignoredEvents" INTEGER NOT NULL DEFAULT 0,
  "fullBackfillCompletedAt" TIMESTAMP(3),
  "fullBackfillVerifiedAt" TIMESTAMP(3),
  "lastCatchupCompletedAt" TIMESTAMP(3),
  "lastSocketEventAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "sourceDeviceId" TEXT,
  "sourceJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CreatorNotificationSyncState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorNotificationSyncState_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CreatorNotificationSyncState_mode_check"
    CHECK ("mode" IN ('full', 'catchup', 'live')),
  CONSTRAINT "CreatorNotificationSyncState_counts_check"
    CHECK ("pagesScanned" >= 0 AND "eventsAccepted" >= 0 AND "eventsRejected" >= 0 AND "ignoredEvents" >= 0),
  CONSTRAINT "CreatorNotificationSyncState_scanRunId_check"
    CHECK ("scanRunId" IS NULL OR length("scanRunId") BETWEEN 8 AND 80),
  CONSTRAINT "CreatorNotificationSyncState_cursor_length_check"
    CHECK (("nextCursor" IS NULL OR length("nextCursor") <= 220)
       AND ("headNotificationId" IS NULL OR length("headNotificationId") <= 220)
       AND ("tailNotificationId" IS NULL OR length("tailNotificationId") <= 220))
);

CREATE UNIQUE INDEX "CreatorNotificationSyncState_creatorId_key"
  ON "CreatorNotificationSyncState"("creatorId");
CREATE UNIQUE INDEX "CreatorNotificationSyncState_agency_creator_key"
  ON "CreatorNotificationSyncState"("agencyId", "creatorId");
CREATE INDEX "CreatorNotificationSyncState_agencyId_status_updatedAt_idx"
  ON "CreatorNotificationSyncState"("agencyId", "status", "updatedAt");
CREATE INDEX "CreatorNotificationSyncState_creator_full_idx"
  ON "CreatorNotificationSyncState"("creatorId", "fullBackfillCompletedAt");
CREATE INDEX "CreatorNotificationSyncState_sourceJobId_idx"
  ON "CreatorNotificationSyncState"("sourceJobId");

-- The previous protocol used one cursor per notification type and could mark a
-- five-type scan complete after only the first branch. Those continuations are
-- not safely convertible to the single ALL stream. Fence every pending legacy
-- lease so the next scheduler/refresh starts one fresh schema-v4 full backfill.
UPDATE "JobInstance"
SET
  "status" = 'CANCELLED',
  "completedAt" = CURRENT_TIMESTAMP,
  "claimedAt" = NULL,
  "claimedByDeviceId" = NULL,
  "leaseUntil" = NULL,
  "leaseTokenHash" = NULL,
  "leaseRevision" = "leaseRevision" + 1,
  "workId" = NULL,
  "continuation" = NULL,
  "lastError" = 'superseded_by_notification_all_v4',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "jobKey" = 'catchup_notifications_scan'
  AND "status" IN ('SCHEDULED', 'CLAIMED');
