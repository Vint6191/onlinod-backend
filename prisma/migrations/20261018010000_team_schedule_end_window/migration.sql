-- Retained schedule windows overlap by end time. A start-time-only index can
-- scan an agency's entire completed history before rejecting old shifts.
-- Keep arbitrary historical durations valid; do not infer a 36-hour DB bound.
CREATE INDEX "TeamShift_agencyId_endsAt_idx" ON "TeamShift" ("agencyId", "endsAt");
