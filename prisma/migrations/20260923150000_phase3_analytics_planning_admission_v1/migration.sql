-- Fixed-size projection for periodic Campaign-directory planning admission.
-- Canonical jobs and provider-start authority are unchanged. One row; no backfill.
CREATE TABLE "AnalyticsPlanningBudget" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "reservedCalls" INTEGER NOT NULL CHECK ("reservedCalls" >= 0),
  "reservedJobs" INTEGER NOT NULL CHECK ("reservedJobs" >= 0),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
