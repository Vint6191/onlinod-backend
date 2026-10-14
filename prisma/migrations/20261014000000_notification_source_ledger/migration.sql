BEGIN;
SET LOCAL lock_timeout = '15s';
-- Additive only: the applied current baseline and all existing facts are preserved.
ALTER TABLE "CreatorNotificationScanItem"
 ADD COLUMN "eventKind" TEXT,
 ADD COLUMN "targetState" TEXT,
 ADD COLUMN "persistenceStatus" TEXT,
 ADD COLUMN "normalizerVersion" TEXT,
 ADD COLUMN "canonicalEventId" TEXT;
CREATE TABLE "CreatorNotificationEvent" (
 "id" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
 "identityKey" TEXT NOT NULL, "notificationId" TEXT, "transactionId" TEXT,
 "sourceType" TEXT, "sourceSubType" TEXT, "category" TEXT, "eventType" TEXT,
 "occurredAt" TIMESTAMP(3), "fanOnlyFansUserId" TEXT, "fanUsernameAtEvent" TEXT,
 "fanDisplayNameAtEvent" TEXT, "fanAvatarUrlAtEvent" TEXT,
 "messageId" TEXT, "postId" TEXT, "commentId" TEXT, "targetState" TEXT NOT NULL,
 "amountCents" INTEGER, "currency" TEXT, "disposition" TEXT NOT NULL, "reasonCode" TEXT,
 "persistenceStatus" TEXT NOT NULL, "canonicalFactId" TEXT, "normalizerVersion" TEXT NOT NULL,
 "sourceChecksum" TEXT NOT NULL, "sourceEvidence" JSONB NOT NULL,
 "sourceJobId" TEXT, "scanRunId" TEXT NOT NULL,
 "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CreatorNotificationEvent_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CreatorNotificationEvent_disposition_check" CHECK ("disposition" IN ('FACT','INFORMATION','UNRESOLVED','IGNORED','REJECTED')),
 CONSTRAINT "CreatorNotificationEvent_targetState_check" CHECK ("targetState" IN ('AVAILABLE','UNAVAILABLE','DELETED','DEACTIVATED','NOT_APPLICABLE')),
 CONSTRAINT "CreatorNotificationEvent_persistenceStatus_check" CHECK ("persistenceStatus" IN ('FACT_COMMITTED','EVENT_STORED','TARGET_UNAVAILABLE','IGNORED_STORED','REJECTED')),
 CONSTRAINT "CreatorNotificationEvent_evidence_size_check" CHECK (octet_length("sourceEvidence"::text) <= 16384)
);
CREATE UNIQUE INDEX "CreatorNotificationEvent_creatorId_identityKey_key" ON "CreatorNotificationEvent"("creatorId","identityKey");
CREATE INDEX "CreatorNotificationEvent_agencyId_creatorId_occurredAt_id_idx" ON "CreatorNotificationEvent"("agencyId","creatorId","occurredAt","id");
CREATE INDEX "CreatorNotificationEvent_creatorId_disposition_lastObservedAt_idx" ON "CreatorNotificationEvent"("creatorId","disposition","lastObservedAt");
CREATE TABLE "CreatorNotificationCorrection" (
 "id" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
 "notificationId" TEXT NOT NULL, "formerModel" TEXT NOT NULL, "formerFactId" TEXT NOT NULL,
 "newEventType" TEXT, "reasonCode" TEXT NOT NULL, "priorEvidence" JSONB NOT NULL,
 "normalizerVersion" TEXT NOT NULL, "sourceJobId" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CreatorNotificationCorrection_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorNotificationCorrection_creatorId_notificationId_createdAt_idx" ON "CreatorNotificationCorrection"("creatorId","notificationId","createdAt");
ALTER TABLE "CreatorNotificationSyncState" ADD COLUMN "normalizerVersion" TEXT;
ALTER TABLE "CreatorNotificationScanItem" ADD COLUMN "sourcePhase" TEXT;
COMMIT;
