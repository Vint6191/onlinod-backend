-- V9: a separate, ordered lane for legacy continuations misclassified as poison.
-- Recovery is bounded by the ordinary worker claim quantum. Do not bulk-reset
-- signals, remove scan receipts, restart collectors, or retry real poison work.
CREATE INDEX "SubscriberDirectoryMaintenanceSignal_legacy_yield_idx"
ON "SubscriberDirectoryMaintenanceSignal" ("dueAt", "creatorId", "kind")
WHERE "attempts" >= 100 AND ("lastError" IS NULL OR "lastError" IN
  ('subscriber_recovery_budget_exhausted','maintenance_budget_exhausted','publication_debt'));
