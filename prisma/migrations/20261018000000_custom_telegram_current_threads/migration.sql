-- Current inbound correlation must not materialize lifetime sender history.
-- Direct Reply retains its existing exact historical provider-message lookup.
CREATE INDEX "CustomOrder_current_thread_order_idx"
  ON "CustomOrder" ("agencyId", "id") WHERE "status" = 'PENDING';
CREATE INDEX "TelegramDeliveryIntent_current_thread_lookup_idx"
  ON "TelegramDeliveryIntent" ("agencyId", "customOrderId", "accountId", "remoteRecipientTelegramUserId", "kind", "confirmedAt" DESC, "id" DESC)
  WHERE "state" = 'CONFIRMED' AND "kind" IN ('TASK', 'REVISION_REQUEST');
