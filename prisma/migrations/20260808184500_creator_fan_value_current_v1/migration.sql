CREATE TABLE "CreatorFanValueCurrent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "totalNetCents" BIGINT NOT NULL DEFAULT 0,
    "messagesNetCents" BIGINT NOT NULL DEFAULT 0,
    "subscriptionsNetCents" BIGINT NOT NULL DEFAULT 0,
    "tipsNetCents" BIGINT NOT NULL DEFAULT 0,
    "postsNetCents" BIGINT NOT NULL DEFAULT 0,
    "streamsNetCents" BIGINT NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ONLYFANS_SUBSCRIBER_PROFILE',
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "scanRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorFanValueCurrent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorFanValueCurrent_creatorId_fanId_key"
ON "CreatorFanValueCurrent"("creatorId", "fanId");

CREATE INDEX "CreatorFanValueCurrent_agencyId_creatorId_fetchedAt_idx"
ON "CreatorFanValueCurrent"("agencyId", "creatorId", "fetchedAt");

CREATE INDEX "CreatorFanValueCurrent_creatorId_totalNetCents_idx"
ON "CreatorFanValueCurrent"("creatorId", "totalNetCents");

CREATE INDEX "CreatorFanValueCurrent_sourceDeviceId_idx"
ON "CreatorFanValueCurrent"("sourceDeviceId");

CREATE INDEX "CreatorFanValueCurrent_sourceJobId_idx"
ON "CreatorFanValueCurrent"("sourceJobId");

ALTER TABLE "CreatorFanValueCurrent"
ADD CONSTRAINT "CreatorFanValueCurrent_agencyId_creatorId_fkey"
FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorFanValueCurrent"
ADD CONSTRAINT "CreatorFanValueCurrent_creatorId_fanId_fkey"
FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorFanValueCurrent"
ADD CONSTRAINT "CreatorFanValueCurrent_sourceDeviceId_fkey"
FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorFanValueCurrent"
ADD CONSTRAINT "CreatorFanValueCurrent_sourceJobId_fkey"
FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
