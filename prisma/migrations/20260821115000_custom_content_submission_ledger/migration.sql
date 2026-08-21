CREATE TABLE "CustomContentSubmission" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "customOrderId" TEXT,
    "telegramMessageIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "ofMediaIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "comment" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomContentSubmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomContentSubmission_agencyId_creatorId_receivedAt_idx"
    ON "CustomContentSubmission"("agencyId", "creatorId", "receivedAt");

CREATE INDEX "CustomContentSubmission_customOrderId_receivedAt_idx"
    ON "CustomContentSubmission"("customOrderId", "receivedAt");

ALTER TABLE "CustomContentSubmission"
    ADD CONSTRAINT "CustomContentSubmission_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomContentSubmission"
    ADD CONSTRAINT "CustomContentSubmission_agencyId_creatorId_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomContentSubmission"
    ADD CONSTRAINT "CustomContentSubmission_customOrderId_fkey"
    FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
