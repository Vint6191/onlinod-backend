-- Phase 2: human command target fencing for Team Schedule.
ALTER TABLE "TeamShift"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- Human review commands must target the exact submission-to-Custom binding the manager saw.
ALTER TABLE "CustomContentSubmission"
  ADD COLUMN "bindingRevision" INTEGER NOT NULL DEFAULT 1;
