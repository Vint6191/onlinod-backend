-- Custom Content Pipeline closure: retryable Telegram inbound projections are
-- scheduled by last-attempt time so a persistently failing oldest batch cannot
-- starve later durable provider observations.
CREATE INDEX IF NOT EXISTS "TelegramInboundEvent_agencyId_projectionState_updatedAt_idx"
  ON "TelegramInboundEvent"("agencyId", "projectionState", "updatedAt");
