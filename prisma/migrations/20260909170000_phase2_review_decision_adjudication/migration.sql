-- Phase 2: manager review decisions are durable history; current decision may be explicitly superseded.
ALTER TABLE "CustomContentSubmission"
  ADD COLUMN "reviewDecisionRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CustomContentReviewDecision" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "customOrderId" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "decisionRevision" INTEGER NOT NULL,
  "decision" TEXT NOT NULL,
  "comment" TEXT,
  "actorMemberId" TEXT,
  "decidedAt" TIMESTAMP(3) NOT NULL,
  "supersedesDecisionRevision" INTEGER,
  "supersessionReason" TEXT,
  "source" TEXT NOT NULL DEFAULT 'MANAGER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomContentReviewDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomContentReviewDecision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "CustomContentSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CustomContentReviewDecision_revision_positive" CHECK ("decisionRevision" >= 1),
  CONSTRAINT "CustomContentReviewDecision_decision_valid" CHECK ("decision" IN ('APPROVE', 'REQUEST_REVISION'))
);

CREATE UNIQUE INDEX "CustomContentReviewDecision_submission_revision_key"
  ON "CustomContentReviewDecision"("submissionId", "decisionRevision");
CREATE INDEX "CustomContentReviewDecision_agency_order_decided_idx"
  ON "CustomContentReviewDecision"("agencyId", "customOrderId", "decidedAt");
CREATE INDEX "CustomContentReviewDecision_agency_actor_decided_idx"
  ON "CustomContentReviewDecision"("agencyId", "actorMemberId", "decidedAt");

-- Existing manager decisions become revision 1.  This preserves history without inventing
-- a second decision or pretending that a dispatch occurred.
UPDATE "CustomContentSubmission"
SET "reviewDecisionRevision" = 1
WHERE "reviewStatus" IN ('APPROVED', 'REVISION_REQUESTED')
  AND "reviewedAt" IS NOT NULL;

INSERT INTO "CustomContentReviewDecision" (
  "id", "agencyId", "creatorId", "customOrderId", "submissionId", "decisionRevision",
  "decision", "comment", "actorMemberId", "decidedAt", "source", "createdAt"
)
SELECT
  'legacy_' || md5(s."id"),
  s."agencyId", s."creatorId", s."customOrderId", s."id", 1,
  CASE WHEN s."reviewStatus" = 'APPROVED' THEN 'APPROVE' ELSE 'REQUEST_REVISION' END,
  s."reviewComment", s."reviewedByMemberId", s."reviewedAt", 'LEGACY_BACKFILL', s."reviewedAt"
FROM "CustomContentSubmission" s
WHERE s."customOrderId" IS NOT NULL
  AND s."reviewStatus" IN ('APPROVED', 'REVISION_REQUESTED')
  AND s."reviewedAt" IS NOT NULL
ON CONFLICT ("submissionId", "decisionRevision") DO NOTHING;
