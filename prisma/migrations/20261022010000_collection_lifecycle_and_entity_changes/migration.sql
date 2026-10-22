-- Persist episode exhaustion and collection continuity across devices/restarts.
ALTER TABLE "CreatorRecoveryIntent"
 ADD COLUMN "failedAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "stoppedAt" TIMESTAMP(3),
 ADD COLUMN "lastError" TEXT,
 ADD COLUMN "lastProgressAt" TIMESTAMP(3);
ALTER TABLE "CreatorRecoveryIntent" ADD CONSTRAINT "CreatorRecoveryIntent_attempts_check" CHECK ("failedAttempts" >= 0);
ALTER TABLE "CreatorRecoveryIntent" DROP CONSTRAINT "CreatorRecoveryIntent_status_check";
ALTER TABLE "CreatorRecoveryIntent" ADD CONSTRAINT "CreatorRecoveryIntent_status_check" CHECK (status IN ('PENDING','RUNNING','COMPLETE','STOPPED'));
ALTER TABLE "CreatorRealtimeSession" ADD COLUMN "captureFromAt" TIMESTAMP(3);
ALTER TABLE "CreatorMediaUsageSourceState" ADD COLUMN "coverage" JSONB;
ALTER TABLE "CreatorMediaUsageSourceState" ADD COLUMN "factProtocol" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CreatorMediaUsageSourceState" ADD CONSTRAINT "CreatorMediaUsageSourceState_fact_protocol_check" CHECK ("factProtocol" IN (0,2));
ALTER TABLE "CreatorMediaUsageContribution" ADD COLUMN "factBaseline" JSONB;
-- Legacy activation visits only original aggregate rows. New fact-only rows
-- never enlarge this bounded upgrade set or require a source-history count.
CREATE INDEX "CreatorMediaUsageContribution_legacy_pending_idx"
 ON "CreatorMediaUsageContribution"("creatorId","sourceKey")
 WHERE "factBaseline" IS NULL OR "factBaseline"->>'legacyPending' = 'true';
CREATE TABLE "CreatorMediaUsageFact" (
 "id" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
 "sourceKey" TEXT NOT NULL, "sourceMessageId" TEXT NOT NULL, "mediaId" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "purchased" BOOLEAN NOT NULL DEFAULT false,
 "sourceRevision" TEXT NOT NULL, "lastSeenRunId" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "CreatorMediaUsageFact_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CreatorMediaUsageFact_identity_key" ON "CreatorMediaUsageFact"("creatorId","sourceKey","sourceMessageId","mediaId");
CREATE INDEX "CreatorMediaUsageFact_source_idx" ON "CreatorMediaUsageFact"("creatorId","sourceKey");
CREATE INDEX "CreatorMediaUsageFact_media_idx" ON "CreatorMediaUsageFact"("creatorId","mediaId");
CREATE INDEX "CreatorMediaUsageFact_run_idx" ON "CreatorMediaUsageFact"("creatorId","sourceKey","lastSeenRunId");

-- A due job ages independently of priority. Yield/retry moves it behind older
-- ready work. These indexes bound candidate reads to the active queue.
CREATE INDEX "JobInstance_due_fair_idx" ON "JobInstance" ("status","nextRunAt","priority" DESC,"id");
CREATE INDEX "JobInstance_creator_due_fair_idx" ON "JobInstance" ("creatorId","status","nextRunAt","priority" DESC,"id");

-- A head row remains locked through owner COMMIT. Revisions therefore follow
-- commit order; a slow transaction cannot become invisible behind a cursor.
CREATE TABLE "CreatorEntityChangeHead" (
 "creatorId" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL,
 "lastRevision" BIGINT NOT NULL DEFAULT 0, "retainedFrom" BIGINT NOT NULL DEFAULT 1,
 "nextRetentionAt" TIMESTAMP(3),
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CreatorEntityChangeHead_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CreatorEntityChangeHead_revisions_check" CHECK ("lastRevision">=0 AND "retainedFrom">=1 AND "retainedFrom"<="lastRevision"+1)
);
CREATE INDEX "CreatorEntityChangeHead_updatedAt_creatorId_idx" ON "CreatorEntityChangeHead"("updatedAt","creatorId");
CREATE INDEX "CreatorEntityChangeHead_retention_due_idx" ON "CreatorEntityChangeHead"("nextRetentionAt","creatorId");
CREATE UNIQUE INDEX "CreatorEntityChangeHead_agencyId_creatorId_key" ON "CreatorEntityChangeHead"("agencyId","creatorId");
CREATE TABLE "CreatorEntityChange" (
 "creatorId" TEXT NOT NULL, "revision" BIGINT NOT NULL, "agencyId" TEXT NOT NULL,
 "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL,
 "sourceIdentity" TEXT NOT NULL, "sourceVersion" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "tombstone" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CreatorEntityChange_pkey" PRIMARY KEY ("creatorId","revision"),
 CONSTRAINT "CreatorEntityChange_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CreatorEntityChange_revision_check" CHECK ("revision">0)
);
CREATE INDEX "CreatorEntityChange_createdAt_creatorId_revision_idx" ON "CreatorEntityChange"("createdAt","creatorId","revision");
CREATE INDEX "CreatorEntityChange_agencyId_creatorId_revision_idx" ON "CreatorEntityChange"("agencyId","creatorId","revision");
CREATE TABLE "CreatorEntityCurrent" (
 "creatorId" TEXT NOT NULL, "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL,
 "agencyId" TEXT NOT NULL, "revision" BIGINT NOT NULL,
 "sourceIdentity" TEXT NOT NULL, "sourceVersion" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "tombstone" BOOLEAN NOT NULL DEFAULT false,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CreatorEntityCurrent_pkey" PRIMARY KEY ("creatorId","entityType","entityId"),
 CONSTRAINT "CreatorEntityCurrent_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CreatorEntityCurrent_revision_check" CHECK ("revision">0)
);
CREATE INDEX "CreatorEntityCurrent_agencyId_creatorId_entityType_entityId_idx" ON "CreatorEntityCurrent"("agencyId","creatorId","entityType","entityId");
INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","admissionSequence")
 VALUES ('onlinod_maintenance_v1','creatorEntityChangeRetention',38,0,0);
