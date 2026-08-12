CREATE TABLE "TeamCoverageSession" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "coverageId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "startReason" TEXT,
    "endReason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'team_v13',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamCoverageSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeamDialogSession" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "dialogId" TEXT NOT NULL,
    "fanId" TEXT,
    "sessionId" TEXT NOT NULL,
    "coverageId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "wallSeconds" INTEGER NOT NULL DEFAULT 0,
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "seenAt" TIMESTAMP(3),
    "activityEvents" INTEGER NOT NULL DEFAULT 0,
    "endReason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'team_v13',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamDialogSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeamResponseCase" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "fanId" TEXT,
    "replyMessageId" TEXT NOT NULL,
    "firstIncomingMessageId" TEXT,
    "incomingCount" INTEGER NOT NULL DEFAULT 1,
    "incomingAt" TIMESTAMP(3) NOT NULL,
    "lastIncomingAt" TIMESTAMP(3) NOT NULL,
    "replyAt" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3),
    "coverageId" TEXT,
    "coverageStartedAt" TIMESTAMP(3),
    "handoffFromMemberId" TEXT,
    "classification" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "wallClockSeconds" INTEGER NOT NULL DEFAULT 0,
    "coverageResponseSeconds" INTEGER,
    "seenResponseSeconds" INTEGER,
    "slaEligible" BOOLEAN NOT NULL DEFAULT false,
    "sla5Pass" BOOLEAN,
    "sla15Pass" BOOLEAN,
    "derivationVersion" TEXT NOT NULL DEFAULT 'team_response_v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamResponseCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamCoverageSession_agencyId_coverageId_key" ON "TeamCoverageSession"("agencyId", "coverageId");
CREATE INDEX "TeamCoverageSession_agencyId_memberId_startedAt_idx" ON "TeamCoverageSession"("agencyId", "memberId", "startedAt");
CREATE INDEX "TeamCoverageSession_agencyId_creatorId_startedAt_idx" ON "TeamCoverageSession"("agencyId", "creatorId", "startedAt");
CREATE INDEX "TeamCoverageSession_agencyId_creatorId_memberId_startedAt_idx" ON "TeamCoverageSession"("agencyId", "creatorId", "memberId", "startedAt");
CREATE INDEX "TeamCoverageSession_endedAt_idx" ON "TeamCoverageSession"("endedAt");

CREATE UNIQUE INDEX "TeamDialogSession_agencyId_sessionId_key" ON "TeamDialogSession"("agencyId", "sessionId");
CREATE INDEX "TeamDialogSession_agencyId_memberId_startedAt_idx" ON "TeamDialogSession"("agencyId", "memberId", "startedAt");
CREATE INDEX "TeamDialogSession_agencyId_creatorId_dialogId_startedAt_idx" ON "TeamDialogSession"("agencyId", "creatorId", "dialogId", "startedAt");
CREATE INDEX "TeamDialogSession_agencyId_memberId_creatorId_dialogId_startedAt_idx" ON "TeamDialogSession"("agencyId", "memberId", "creatorId", "dialogId", "startedAt");

CREATE UNIQUE INDEX "TeamResponseCase_agencyId_replyMessageId_key" ON "TeamResponseCase"("agencyId", "replyMessageId");
CREATE INDEX "TeamResponseCase_agencyId_memberId_replyAt_idx" ON "TeamResponseCase"("agencyId", "memberId", "replyAt");
CREATE INDEX "TeamResponseCase_agencyId_creatorId_dialogId_replyAt_idx" ON "TeamResponseCase"("agencyId", "creatorId", "dialogId", "replyAt");
CREATE INDEX "TeamResponseCase_agencyId_classification_replyAt_idx" ON "TeamResponseCase"("agencyId", "classification", "replyAt");
CREATE INDEX "TeamResponseCase_agencyId_slaEligible_replyAt_idx" ON "TeamResponseCase"("agencyId", "slaEligible", "replyAt");

ALTER TABLE "TeamCoverageSession" ADD CONSTRAINT "TeamCoverageSession_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamCoverageSession" ADD CONSTRAINT "TeamCoverageSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamCoverageSession" ADD CONSTRAINT "TeamCoverageSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamDialogSession" ADD CONSTRAINT "TeamDialogSession_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamDialogSession" ADD CONSTRAINT "TeamDialogSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamDialogSession" ADD CONSTRAINT "TeamDialogSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamResponseCase" ADD CONSTRAINT "TeamResponseCase_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamResponseCase" ADD CONSTRAINT "TeamResponseCase_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamResponseCase" ADD CONSTRAINT "TeamResponseCase_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
