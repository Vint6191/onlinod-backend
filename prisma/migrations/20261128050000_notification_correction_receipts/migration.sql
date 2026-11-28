-- A canonical subscription keeps one receipt when its exact provider identity
-- gains a transaction ID or its amount/fan is corrected. Legacy adoption reads
-- only this creator, owner and exact notification identity.
CREATE INDEX "TrafficReceipt_notification_identity_v3"
  ON "CreatorSubscriptionLedger"("creatorId", "source", "externalEventId");
