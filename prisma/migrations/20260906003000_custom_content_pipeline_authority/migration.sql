-- Custom Content Pipeline Authority: pin execution configuration and separate
-- durable business disposition from derived execution stage.
ALTER TABLE "CustomContentSubmission"
  ADD COLUMN "executionVaultFolderId" TEXT,
  ADD COLUMN "executionRelayRecipient" TEXT,
  ADD COLUMN "executionProfileRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "executionPinnedAt" TIMESTAMP(3),
  ADD COLUMN "vaultSettlementFolderId" TEXT,
  ADD COLUMN "vaultSettlementProfileRevision" INTEGER,
  ADD COLUMN "vaultSettlementMediaFingerprint" TEXT,
  ADD COLUMN "vaultSettlementConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "vaultSettlementConfirmedByDeviceId" TEXT,
  ADD COLUMN "pipelineDisposition" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "pipelineDispositionReason" TEXT,
  ADD COLUMN "pipelineDispositionChangedAt" TIMESTAMP(3),
  ADD COLUMN "pipelineBlockedCode" TEXT,
  ADD COLUMN "pipelineBlockedAt" TIMESTAMP(3),
  ADD COLUMN "pipelineLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "pipelineNextAttemptAt" TIMESTAMP(3);

-- Existing submissions attached to a provider-proven fan delivery are already
-- terminal success history. They must not reappear as operator SALVAGE work or
-- block creator retirement after migration.
UPDATE "CustomContentSubmission" AS submission
SET "pipelineDisposition" = 'ARCHIVED',
    "pipelineDispositionReason" = 'MIGRATION_FAN_DELIVERED',
    "pipelineDispositionChangedAt" = CURRENT_TIMESTAMP
FROM "CustomOrder" AS custom_order
WHERE submission."customOrderId" = custom_order."id"
  AND custom_order."fanDeliveredAt" IS NOT NULL;

-- Any other terminal CustomOrder is fail-closed. A status such as COMPLETED
-- without the canonical fanDeliveredAt proof is not enough to infer successful
-- content delivery; preserve/reconcile confirmed external media through SALVAGE.
UPDATE "CustomContentSubmission" AS submission
SET "pipelineDisposition" = 'SALVAGE',
    "pipelineDispositionReason" = 'MIGRATION_TERMINAL_CUSTOM',
    "pipelineDispositionChangedAt" = CURRENT_TIMESTAMP
FROM "CustomOrder" AS custom_order
WHERE submission."customOrderId" = custom_order."id"
  AND custom_order."fanDeliveredAt" IS NULL
  AND custom_order."status" <> 'PENDING';

CREATE INDEX "CustomContentSubmission_agency_pipelineDisposition_receivedAt_idx"
  ON "CustomContentSubmission"("agencyId", "pipelineDisposition", "receivedAt");
CREATE INDEX "CustomContentSubmission_agency_sourceAccount_pipelineDisposition_receivedAt_idx"
  ON "CustomContentSubmission"("agencyId", "telegramSourceAccountId", "pipelineDisposition", "receivedAt");

CREATE INDEX "CustomContentSubmission_agency_pipelineDisposition_nextAttempt_receivedAt_idx"
  ON "CustomContentSubmission"("agencyId", "pipelineDisposition", "pipelineNextAttemptAt", "receivedAt");
