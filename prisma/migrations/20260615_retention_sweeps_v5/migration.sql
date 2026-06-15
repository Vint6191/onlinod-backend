-- Retention sweep indexes for high-volume normalized analytics tables.
-- No schema-breaking changes; only indexes for fast batch deletes/cleanup scans.

CREATE INDEX IF NOT EXISTS "TeamActivityEvent_type_ts_idx"
  ON "TeamActivityEvent"("type", "ts");

CREATE INDEX IF NOT EXISTS "TrafficSourceMember_retention_idx"
  ON "TrafficSourceMember"("lastRevenueAt", "lastSeenAt", "needsValueRefresh");

CREATE INDEX IF NOT EXISTS "TrafficFanValueSnapshot_fetchedAt_idx"
  ON "TrafficFanValueSnapshot"("fetchedAt");

CREATE INDEX IF NOT EXISTS "CreatorSubscriptionLedger_retention_idx"
  ON "CreatorSubscriptionLedger"("sourceId", "organicConfirmed", "amountCents", "occurredAt");

CREATE INDEX IF NOT EXISTS "TrafficDailyAggregate_day_idx"
  ON "TrafficDailyAggregate"("day");
