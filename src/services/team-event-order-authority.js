"use strict";

function clean(value, max = 220) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function dateOrNull(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function canonicalTelemetryEventId(row) {
  return clean(row?.telemetryEventId ?? row?.id, 220);
}

function canonicalReplyEventId(reply) {
  // TeamSentMessageLedger.id is a ledger identity, not a canonical telemetry
  // ordering identity. Only telemetryEventId can be compared to TeamActivityEvent.id.
  return clean(reply?.telemetryEventId, 220);
}

function compareCanonicalEventOrder(aAt, aId, bAt, bId) {
  const a = dateOrNull(aAt);
  const b = dateOrNull(bAt);
  if (!a || !b) return null;
  const delta = a.getTime() - b.getTime();
  if (delta) return delta < 0 ? -1 : 1;
  const left = clean(aId, 220);
  const right = clean(bId, 220);
  if (!left || !right) return null;
  const idDelta = left.localeCompare(right);
  return idDelta < 0 ? -1 : idDelta > 0 ? 1 : 0;
}

function replyBoundary(reply) {
  return {
    at: dateOrNull(reply?.sentAt ?? reply?.ts),
    eventId: canonicalReplyEventId(reply),
    ledgerId: clean(reply?.id, 220),
  };
}

function sameReplyBoundary(progress, reply) {
  const current = replyBoundary(reply);
  const pAt = dateOrNull(progress?.replyAt);
  const pEventId = clean(progress?.replyEventId, 220);
  const pLedgerId = clean(progress?.replyLedgerId, 220);
  return (current.at?.getTime?.() ?? null) === (pAt?.getTime?.() ?? null)
    && current.eventId === pEventId
    && current.ledgerId === pLedgerId;
}

module.exports = {
  canonicalTelemetryEventId,
  canonicalReplyEventId,
  compareCanonicalEventOrder,
  replyBoundary,
  sameReplyBoundary,
};
