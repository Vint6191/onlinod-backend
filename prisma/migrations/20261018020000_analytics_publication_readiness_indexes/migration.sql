-- Selected-range readiness uses independent current and published dates.
-- A moved/deleted fact blocks its former day until the old contribution is removed.
CREATE INDEX "AnalyticsFactPublication_dirty_current_day_idx"
  ON "CreatorAnalyticsFactPublication" ("creatorId",kind,(left(COALESCE("currentValue"->>'purchasedAt',"currentValue"->>'tippedAt',"currentValue"->>'occurredAt',"currentValue"->>'paidAt',"currentValue"->>'likedAt',"currentValue"->>'commentedAt',"currentValue"->>'date'),10))) WHERE dirty;
CREATE INDEX "AnalyticsFactPublication_dirty_published_day_idx"
  ON "CreatorAnalyticsFactPublication" ("creatorId",kind,(left(COALESCE("publishedValue"->>'purchasedAt',"publishedValue"->>'tippedAt',"publishedValue"->>'occurredAt',"publishedValue"->>'paidAt',"publishedValue"->>'likedAt',"publishedValue"->>'commentedAt',"publishedValue"->>'date'),10))) WHERE dirty;
