ALTER TABLE "TeamActivityEvent"
  ADD COLUMN "pendingProjectionVersion" TEXT,
  ADD COLUMN "pendingProjectedAt" TIMESTAMP(3);

CREATE TABLE "TeamPendingDialogState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "fanId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'CLEAR',
  "episodeKey" TEXT,
  "firstIncomingEventId" TEXT,
  "lastIncomingEventId" TEXT,
  "firstIncomingMessageId" TEXT,
  "lastIncomingMessageId" TEXT,
  "firstIncomingAt" TIMESTAMP(3),
  "lastIncomingAt" TIMESTAMP(3),
  "incomingCount" INTEGER NOT NULL DEFAULT 0,
  "firstSeenAt" TIMESTAMP(3),
  "firstSeenMemberId" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "lastSeenMemberId" TEXT,
  "ownerMemberId" TEXT,
  "ownerAssignedAt" TIMESTAMP(3),
  "ownerReason" TEXT,
  "replyAt" TIMESTAMP(3),
  "replyMessageId" TEXT,
  "repliedByMemberId" TEXT,
  "derivationVersion" TEXT NOT NULL DEFAULT 'team_pending_v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TeamPendingDialogState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamPendingDialogState_agencyId_creatorId_dialogId_key"
  ON "TeamPendingDialogState"("agencyId", "creatorId", "dialogId");
CREATE INDEX "TeamPendingDialogState_agencyId_status_firstIncomingAt_idx"
  ON "TeamPendingDialogState"("agencyId", "status", "firstIncomingAt");
CREATE INDEX "TeamPendingDialogState_agencyId_ownerMemberId_status_idx"
  ON "TeamPendingDialogState"("agencyId", "ownerMemberId", "status");
CREATE INDEX "TeamPendingDialogState_agencyId_creatorId_status_firstIncomingAt_idx"
  ON "TeamPendingDialogState"("agencyId", "creatorId", "status", "firstIncomingAt");
CREATE INDEX "TeamActivityEvent_agencyId_pendingProjectionVersion_ts_idx"
  ON "TeamActivityEvent"("agencyId", "pendingProjectionVersion", "ts");

ALTER TABLE "TeamPendingDialogState"
  ADD CONSTRAINT "TeamPendingDialogState_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamPendingDialogState"
  ADD CONSTRAINT "TeamPendingDialogState_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
