-- Notification Facts V1 AUDITED V2 hardening.
-- The original V1 migration is intentionally immutable for already-deployed databases.

-- Quick V1 used one generic coverage type and had lossy normalization. Never
-- keep claiming that old coverage is authoritative after the audited upgrade.
UPDATE "AnalyticsCoverage"
SET
  "status" = 'PARTIAL',
  "lastErrorCode" = 'NOTIFICATION_V1_RESCAN_REQUIRED',
  "lastErrorMessage" = 'Notification Facts V1 was superseded by audited typed collectors; rescan required',
  "retryAfterAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "dataType" = 'NOTIFICATIONS'
  AND "status" = 'COMPLETE';

-- Quick V1 also fabricated range-end timestamps when a notification had no
-- trustworthy occurredAt and converted unknown money into zero. Positive rows
-- with a fabricated timestamp cannot be distinguished from genuine facts after
-- the fact, so no Quick-V1 business row is safe to retain. The notification
-- tables did not exist before Quick V1; purge them and force a clean audited
-- rescan instead of exposing potentially false history.
DELETE FROM "CreatorSale";
DELETE FROM "CreatorTip";
DELETE FROM "CreatorSubscriptionEvent";

-- CreatorFan was introduced by the ledger core and, before this audited
-- notification collector, had no writer other than Quick V1. Remove orphaned
-- fan identities as well so fabricated firstSeenAt/lastSeenAt values cannot
-- survive the upgrade.
DELETE FROM "CreatorFan"
WHERE NOT EXISTS (SELECT 1 FROM "CreatorSale" WHERE "CreatorSale"."fanId" = "CreatorFan"."id")
  AND NOT EXISTS (SELECT 1 FROM "CreatorTip" WHERE "CreatorTip"."fanId" = "CreatorFan"."id")
  AND NOT EXISTS (SELECT 1 FROM "CreatorSubscriptionEvent" WHERE "CreatorSubscriptionEvent"."fanId" = "CreatorFan"."id");

ALTER TABLE "CreatorSale" DROP CONSTRAINT IF EXISTS "CreatorSale_amount_check";
ALTER TABLE "CreatorSale"
  ADD CONSTRAINT "CreatorSale_amount_positive_check" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "CreatorSale_target_consistency_check" CHECK (
    ("saleType" = 'MESSAGE' AND "messageId" IS NOT NULL AND "postId" IS NULL) OR
    ("saleType" = 'POST' AND "postId" IS NOT NULL AND "messageId" IS NULL) OR
    ("saleType" IN ('STREAM', 'OTHER') AND NOT ("messageId" IS NOT NULL AND "postId" IS NOT NULL))
  ),
  ADD CONSTRAINT "CreatorSale_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "CreatorTip" DROP CONSTRAINT IF EXISTS "CreatorTip_amount_check";
ALTER TABLE "CreatorTip"
  ADD CONSTRAINT "CreatorTip_amount_positive_check" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "CreatorTip_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "CreatorSubscriptionEvent" DROP CONSTRAINT IF EXISTS "CreatorSubscriptionEvent_price_check";
ALTER TABLE "CreatorSubscriptionEvent"
  ADD CONSTRAINT "CreatorSubscriptionEvent_price_semantics_check" CHECK (
    ("eventType" = 'SUBSCRIBED_FREE' AND "observedPriceCents" = 0) OR
    ("eventType" = 'SUBSCRIBED_PAID' AND "observedPriceCents" > 0) OR
    ("eventType" NOT IN ('SUBSCRIBED_FREE', 'SUBSCRIBED_PAID') AND ("observedPriceCents" IS NULL OR "observedPriceCents" >= 0))
  ),
  ADD CONSTRAINT "CreatorSubscriptionEvent_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');
