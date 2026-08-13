-- Team Content + Schedule V1 (additive only)
ALTER TABLE "TeamActivityEvent" ADD COLUMN "contentId" TEXT;
CREATE INDEX "TeamActivityEvent_agencyId_contentId_idx" ON "TeamActivityEvent"("agencyId", "contentId");

CREATE TABLE "TeamShift" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "note" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamShift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeamShiftCreator" (
    "shiftId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamShiftCreator_pkey" PRIMARY KEY ("shiftId", "creatorId")
);

CREATE INDEX "TeamShift_agencyId_startsAt_idx" ON "TeamShift"("agencyId", "startsAt");
CREATE INDEX "TeamShift_agencyId_status_startsAt_idx" ON "TeamShift"("agencyId", "status", "startsAt");
CREATE INDEX "TeamShift_memberId_startsAt_idx" ON "TeamShift"("memberId", "startsAt");
CREATE INDEX "TeamShiftCreator_creatorId_shiftId_idx" ON "TeamShiftCreator"("creatorId", "shiftId");

ALTER TABLE "TeamShift" ADD CONSTRAINT "TeamShift_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamShift" ADD CONSTRAINT "TeamShift_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TeamShiftCreator" ADD CONSTRAINT "TeamShiftCreator_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "TeamShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamShiftCreator" ADD CONSTRAINT "TeamShiftCreator_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
