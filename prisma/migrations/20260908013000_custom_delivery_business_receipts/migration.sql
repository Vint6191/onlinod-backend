CREATE TABLE "CustomDeliveryReceipt" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "customOrderId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "writeId" TEXT,
    "writeCommitRevision" INTEGER,
    "idempotencyKey" TEXT,
    "dialogId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "actorMemberId" TEXT,
    "actorUserId" TEXT,
    "sentMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvedMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchedMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "newlyDeliveredMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "duplicateMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedPriceCents" INTEGER NOT NULL DEFAULT 0,
    "actualPriceCents" INTEGER NOT NULL DEFAULT 0,
    "totalPriceCents" INTEGER NOT NULL DEFAULT 0,
    "paidAmountCents" INTEGER NOT NULL DEFAULT 0,
    "remainingAmountCents" INTEGER NOT NULL DEFAULT 0,
    "previousDeliveryOfferedCents" INTEGER NOT NULL DEFAULT 0,
    "deliveryOfferedCents" INTEGER NOT NULL DEFAULT 0,
    "paymentStatus" TEXT,
    "paymentMismatch" TEXT,
    "overrideReason" TEXT,
    "duplicateOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "priceMismatchOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "receiptFingerprint" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomDeliveryReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomDeliveryReceipt_provider_message_key"
  ON "CustomDeliveryReceipt"("agencyId", "creatorId", "messageId");
CREATE UNIQUE INDEX "CustomDeliveryReceipt_write_revision_key"
  ON "CustomDeliveryReceipt"("writeId", "writeCommitRevision");
CREATE INDEX "CustomDeliveryReceipt_agencyId_occurredAt_idx"
  ON "CustomDeliveryReceipt"("agencyId", "occurredAt");
CREATE INDEX "CustomDeliveryReceipt_agencyId_creatorId_occurredAt_idx"
  ON "CustomDeliveryReceipt"("agencyId", "creatorId", "occurredAt");
CREATE INDEX "CustomDeliveryReceipt_customOrderId_occurredAt_idx"
  ON "CustomDeliveryReceipt"("customOrderId", "occurredAt");
CREATE INDEX "CustomDeliveryReceipt_submissionId_occurredAt_idx"
  ON "CustomDeliveryReceipt"("submissionId", "occurredAt");

ALTER TABLE "CustomDeliveryReceipt"
  ADD CONSTRAINT "CustomDeliveryReceipt_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomDeliveryReceipt"
  ADD CONSTRAINT "CustomDeliveryReceipt_customOrderId_fkey"
  FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomDeliveryReceipt"
  ADD CONSTRAINT "CustomDeliveryReceipt_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "CustomContentSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
