-- Phase 3 INT4.3C
-- `usedForever` means a target completed an ONLINOD-owned SFS cycle. Older
-- planners also set it for transient current ineligibility (paid/comments off),
-- which permanently excluded targets that could later become eligible.
UPDATE "SfsTargetCandidate"
SET
  "usedForever" = false,
  "state" = 'CANDIDATE',
  "phase" = 'IDLE',
  "completedAt" = NULL,
  "latestError" = NULL
WHERE "usedForever" = true
  AND "state" = 'SKIPPED'
  AND "eligibilityReason" IN ('paid_target', 'comments_disabled');
