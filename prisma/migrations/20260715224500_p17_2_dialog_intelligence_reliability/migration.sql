-- P17.2 Dialog Intelligence Reliability Hotfix

ALTER TABLE "DialogScanState"
  ADD COLUMN IF NOT EXISTS "confirmedWatermarkMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "confirmedWatermarkAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "incrementalGapOpen" BOOLEAN NOT NULL DEFAULT false;

UPDATE "DialogScanState"
SET
  "confirmedWatermarkMessageId" = COALESCE("confirmedWatermarkMessageId", "forwardCursor", "newestMessageId"),
  "confirmedWatermarkAt" = COALESCE("confirmedWatermarkAt", "newestMessageAt")
WHERE "initialScanComplete" = true;

CREATE TABLE "DialogReconciliationTarget" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "fanId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'targeted_reconciliation',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "priority" INTEGER NOT NULL DEFAULT 120,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DialogReconciliationTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DialogReconciliationTarget_creatorId_dialogId_messageId_key"
  ON "DialogReconciliationTarget"("creatorId", "dialogId", "messageId");
CREATE INDEX "DialogReconciliationTarget_agencyId_status_priority_requestedAt_idx"
  ON "DialogReconciliationTarget"("agencyId", "status", "priority", "requestedAt");
CREATE INDEX "DialogReconciliationTarget_creatorId_dialogId_status_priority_requestedAt_idx"
  ON "DialogReconciliationTarget"("creatorId", "dialogId", "status", "priority", "requestedAt");

ALTER TABLE "DialogReconciliationTarget"
  ADD CONSTRAINT "DialogReconciliationTarget_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogReconciliationTarget"
  ADD CONSTRAINT "DialogReconciliationTarget_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
