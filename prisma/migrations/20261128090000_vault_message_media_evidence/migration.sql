-- Complete attachment evidence is independent of canonical financial state.
-- Existing facts are retained; a validated explicit fan-ownership correction
-- updates the derived contribution through the existing bounded media owner.
CREATE TABLE "CreatorMediaMessageEvidence" (
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL,
  "creatorMediaIds" JSONB NOT NULL,
  "excludedMediaIds" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "manifestHash" TEXT NOT NULL,
  "dirty" BOOLEAN NOT NULL DEFAULT true,
  "pendingFacts" BOOLEAN NOT NULL DEFAULT true,
  "cursor" TEXT NOT NULL DEFAULT '',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorMediaMessageEvidence_pkey" PRIMARY KEY ("creatorId", "sourceKey", "messageId"),
  CONSTRAINT "CreatorMediaMessageEvidence_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorMediaMessageEvidence_dirty_idx" ON "CreatorMediaMessageEvidence"("creatorId", "dirty", "sourceKey", "messageId");
CREATE INDEX "CreatorMediaMessageEvidence_pending_idx" ON "CreatorMediaMessageEvidence"("creatorId") WHERE "dirty" OR "pendingFacts";
