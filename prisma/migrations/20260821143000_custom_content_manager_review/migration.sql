-- V20.5: typed manager review state for finalized custom content submissions.
CREATE TYPE "CustomContentReviewStatus" AS ENUM ('WAITING_REVIEW', 'REVISION_REQUESTED', 'APPROVED');

ALTER TABLE "CustomContentSubmission"
  ADD COLUMN "reviewStatus" "CustomContentReviewStatus" NOT NULL DEFAULT 'WAITING_REVIEW',
  ADD COLUMN "reviewComment" TEXT,
  ADD COLUMN "reviewedByMemberId" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "CustomContentSubmission"
  ADD CONSTRAINT "CustomContentSubmission_reviewedByMemberId_fkey"
  FOREIGN KEY ("reviewedByMemberId") REFERENCES "AgencyMember"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CustomContentSubmission_agencyId_reviewStatus_receivedAt_idx"
  ON "CustomContentSubmission"("agencyId", "reviewStatus", "receivedAt");
CREATE INDEX "CustomContentSubmission_reviewedByMemberId_idx"
  ON "CustomContentSubmission"("reviewedByMemberId");

-- One final approved submission per custom order. Prisma cannot express partial
-- unique indexes, so keep this invariant in the migration and service layer.
CREATE UNIQUE INDEX "CustomContentSubmission_one_approved_per_order_key"
  ON "CustomContentSubmission"("customOrderId")
  WHERE "reviewStatus" = 'APPROVED' AND "customOrderId" IS NOT NULL;
