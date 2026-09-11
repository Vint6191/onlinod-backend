-- Phase 2 / Actual54 Root B closure.
-- Cross-family Team chronology uses TeamSentMessageLedger.telemetryEventId as the
-- bridge to canonical TeamActivityEvent.id. This partial current-order index keeps
-- same-dialog reply-boundary seeks bounded without pretending historical rows with
-- no telemetry identity are orderable at equal timestamps.
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_dialog_canonical_order_idx"
  ON "TeamSentMessageLedger" ("agencyId", "creatorId", "dialogId", "sentAt", "telemetryEventId", "id")
  WHERE "source" IN ('manual', 'manual_chat');

-- F54-04: bounded late-repair pages walk (ts,id); this expression index gives
-- the duplicate-identity anti-join a direct lookup for messageId/localId/id
-- instead of making localId-only historical rows degrade into broad rescans.
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_pending_repair_identity_idx"
  ON "TeamActivityEvent"(
    "agencyId","creatorId","dialogId","eventKind",
    (COALESCE(NULLIF("messageId",''),NULLIF("localId",''),"id")),"ts","id"
  )
  WHERE "eventKind"='FAN_MESSAGE_RECEIVED';

-- F54-03: reply-family chronology itself is (sentAt, ledger id). Keep this
-- separate from telemetryEventId, which exists only as the incoming<->reply
-- cross-family bridge. This partial index keeps previous/successor reply seeks
-- bounded for mixed historical/modern ledgers.
CREATE INDEX IF NOT EXISTS "TeamSentMessageLedger_dialog_reply_order_idx"
  ON "TeamSentMessageLedger" ("agencyId", "creatorId", "dialogId", "sentAt", "id")
  WHERE "source" IN ('manual', 'manual_chat');
