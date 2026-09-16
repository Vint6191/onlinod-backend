"use strict";

function date(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Build server-owned temporal provenance for a known automation write result.
 *
 * Canonical FanData chronology must never be advanced by settlement time or by
 * an arbitrary producer wall clock. The server write-commit permit is the
 * trusted lower-bound timestamp for the physical effect. A producer timestamp
 * is retained only as bounded evidence when it falls inside the server-owned
 * [writeCommitAt, settlementReceivedAt] interval; it never owns canonical
 * ordering.
 */
function buildAutomationEffectTimeEvidence(delivery, result, settlementReceivedAt = new Date()) {
  const writeCommitAt = date(delivery?.writeCommitAt);
  if (!writeCommitAt) return null;
  const receiptAt = date(settlementReceivedAt) || new Date();
  const raw = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const producerAt = date(raw.effectObservedAt);
  const producerTimeAccepted = Boolean(
    producerAt
    && producerAt.getTime() >= writeCommitAt.getTime()
    && producerAt.getTime() <= receiptAt.getTime(),
  );
  return {
    authorityObservedAt: writeCommitAt,
    effectTimeBasis: "SERVER_WRITE_COMMIT_LOWER_BOUND",
    settlementReceivedAt: receiptAt,
    producerEffectObservedAt: producerTimeAccepted ? producerAt : null,
    producerTimeAccepted,
  };
}

function sanitizeAutomationSettlementResult(result, evidence) {
  const raw = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const { effectObservedAt: _untrustedProducerTime, ...rest } = raw;
  if (!evidence) return rest;
  return {
    ...rest,
    effectAuthorityObservedAt: evidence.authorityObservedAt.toISOString(),
    effectTimeBasis: evidence.effectTimeBasis,
    settlementReceivedAt: evidence.settlementReceivedAt.toISOString(),
    producerEffectObservedAt: evidence.producerEffectObservedAt?.toISOString?.() || null,
    producerEffectObservedAtAccepted: evidence.producerTimeAccepted === true,
  };
}

module.exports = {
  buildAutomationEffectTimeEvidence,
  sanitizeAutomationSettlementResult,
};
