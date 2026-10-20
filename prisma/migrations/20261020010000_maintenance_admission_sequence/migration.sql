-- Lifetime offer counts are telemetry, not queue position. Appending lanes at
-- count zero must not suspend old lanes while new ones catch up with history.
-- Initializing only this new scheduling field admits every existing class in
-- one bounded catalog round. Original counters and timestamps remain intact.
ALTER TABLE "MaintenanceAdmissionClassState"
  ADD COLUMN "admissionSequence" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "MaintenanceAdmissionClassState"
  ADD CONSTRAINT "MaintenanceAdmissionClassState_sequence_check"
  CHECK ("admissionSequence" >= 0);
CREATE INDEX "MaintenanceAdmissionClassState_sequence_idx"
  ON "MaintenanceAdmissionClassState" ("generation", "admissionSequence", "ordinal");
