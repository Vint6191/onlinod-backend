-- Custom Orders V1
-- Shared agency-side journal for custom-content requests. Additive only.

CREATE TYPE "CustomOrderStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

CREATE TABLE "CustomOrder" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "createdByMemberId" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "internalNote" TEXT,
    "status" "CustomOrderStatus" NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "mediaIds" TEXT NOT NULL DEFAULT '',
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomOrder_agencyId_status_dueAt_idx" ON "CustomOrder"("agencyId", "status", "dueAt");
CREATE INDEX "CustomOrder_agencyId_creatorId_status_dueAt_idx" ON "CustomOrder"("agencyId", "creatorId", "status", "dueAt");
CREATE INDEX "CustomOrder_agencyId_creatorId_dialogId_createdAt_idx" ON "CustomOrder"("agencyId", "creatorId", "dialogId", "createdAt");
CREATE INDEX "CustomOrder_creatorId_dialogId_status_idx" ON "CustomOrder"("creatorId", "dialogId", "status");

ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_agencyId_creatorId_fkey"
  FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_createdByMemberId_fkey"
  FOREIGN KEY ("createdByMemberId") REFERENCES "AgencyMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
