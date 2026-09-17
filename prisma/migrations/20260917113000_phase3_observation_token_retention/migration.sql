-- Phase 3 / INT5.5C-1
-- Observation tokens are short-lived execution authority, not a durable ledger.
-- Consumed rows are deleted on use; this index keeps opportunistic stale-token
-- cleanup bounded for abandoned/unconsumed tokens.

CREATE INDEX IF NOT EXISTS "FanObservationToken_createdAt_idx"
  ON "FanObservationToken" ("createdAt");
