-- ONLINOD v19.31 bump cancelAt backfill/guard.
-- Rows created by earlier desktop builds could have result.cancelAt/cancelAt missing.
-- Distributed cancel workers need cancelAt to claim jobs deterministically.
-- Default mirrors the current product timeout: sentAt + 5 hours.

UPDATE "AutomationDelivery"
SET "cancelAt" = COALESCE(
  "cancelAt",
  NULLIF("result"->>'cancelAt', '')::timestamptz,
  "sentAt" + INTERVAL '5 hours'
)
WHERE "status" IN ('pending_reply', 'sent', 'checking_reply', 'cancel_claimed')
  AND "cancelAt" IS NULL
  AND "sentAt" IS NOT NULL;

-- If a dead worker claimed a row before this deploy and the lease is already stale,
-- return it to the claimable pending queue. This keeps the table compact and mutable.
UPDATE "AutomationDelivery"
SET
  "status" = 'pending_reply',
  "claimedByDeviceId" = NULL,
  "claimedAt" = NULL,
  "claimUntil" = NULL,
  "error" = 'stale cancel claim reset by v19.31 migration'
WHERE "status" = 'cancel_claimed'
  AND "claimUntil" IS NOT NULL
  AND "claimUntil" < CURRENT_TIMESTAMP;
