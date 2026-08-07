CREATE TYPE "CreatorNotificationScanOutcome" AS ENUM ('ACCEPTED', 'REJECTED', 'IGNORED');
CREATE TYPE "CreatorNotificationScanFactType" AS ENUM ('PURCHASE', 'TIP', 'SUBSCRIPTION', 'LIKE', 'COMMENT');

CREATE TABLE "CreatorNotificationScanItem" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "sourceJobId" TEXT NOT NULL,
  "scanRunId" TEXT NOT NULL,
  "page" INTEGER NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "notificationId" TEXT,
  "sourceType" TEXT,
  "sourceSubType" TEXT,
  "factType" "CreatorNotificationScanFactType",
  "occurredAt" TIMESTAMP(3),
  "fanOnlyFansUserId" TEXT,
  "postId" TEXT,
  "commentId" TEXT,
  "messageId" TEXT,
  "amountCents" INTEGER,
  "currency" TEXT,
  "outcome" "CreatorNotificationScanOutcome" NOT NULL,
  "reasonCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CreatorNotificationScanItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorNotificationScanItem_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CreatorNotificationScanItem_sourceJob_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CreatorNotificationScanItem_scanRunId_check"
    CHECK (length("scanRunId") BETWEEN 8 AND 80),
  CONSTRAINT "CreatorNotificationScanItem_page_ordinal_check"
    CHECK ("page" > 0 AND "ordinal" >= 0 AND "ordinal" < 100),
  CONSTRAINT "CreatorNotificationScanItem_lengths_check"
    CHECK (("notificationId" IS NULL OR length("notificationId") <= 220)
       AND ("sourceType" IS NULL OR length("sourceType") <= 120)
       AND ("sourceSubType" IS NULL OR length("sourceSubType") <= 160)
       AND ("fanOnlyFansUserId" IS NULL OR length("fanOnlyFansUserId") <= 180)
       AND ("postId" IS NULL OR length("postId") <= 220)
       AND ("commentId" IS NULL OR length("commentId") <= 220)
       AND ("messageId" IS NULL OR length("messageId") <= 220)
       AND ("amountCents" IS NULL OR abs("amountCents"::bigint) <= 2147483647)
       AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
       AND ("reasonCode" IS NULL OR length("reasonCode") <= 160))
);

CREATE UNIQUE INDEX "CreatorNotificationScanItem_run_page_ordinal_key"
  ON "CreatorNotificationScanItem"("creatorId", "scanRunId", "page", "ordinal");
CREATE INDEX "CreatorNotificationScanItem_job_outcome_page_idx"
  ON "CreatorNotificationScanItem"("creatorId", "sourceJobId", "outcome", "page");
CREATE INDEX "CreatorNotificationScanItem_run_page_idx"
  ON "CreatorNotificationScanItem"("creatorId", "scanRunId", "page");
CREATE INDEX "CreatorNotificationScanItem_sourceJobId_idx"
  ON "CreatorNotificationScanItem"("sourceJobId");
CREATE INDEX "CreatorNotificationScanItem_reason_idx"
  ON "CreatorNotificationScanItem"("creatorId", "reasonCode");

-- Notification history collection is manual while Creator Analytics is under
-- development. Fence any job queued/leased by the older automatic scheduler;
-- existing completed rows remain available for historical diagnosis.
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
  "lastError" = 'notification_scan_manual_only_v1',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "jobKey" = 'catchup_notifications_scan'
  AND "status" IN ('SCHEDULED', 'CLAIMED');
