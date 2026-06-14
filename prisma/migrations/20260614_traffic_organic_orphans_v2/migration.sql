-- Avoid repeatedly re-checking permanent organic subscriptions that never map to a traffic source.
ALTER TABLE "CreatorSubscriptionLedger"
  ADD COLUMN IF NOT EXISTS "attributionAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "organicConfirmed" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "CreatorSubscriptionLedger_agencyId_creatorId_organicConfirmed_attributionAttempts_idx"
  ON "CreatorSubscriptionLedger"("agencyId", "creatorId", "organicConfirmed", "attributionAttempts");
