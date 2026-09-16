"use strict";

function date(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Build server-owned temporal provenance for a known automation write result.
 *
 * A write permit is only a lower bound and settlement receipt is only an upper
 * bound for the physical OF effect. Neither timestamp is the effect time. The
 * Desktop timestamp is retained as bounded forensic evidence only; it never
 * owns canonical FanData ordering. Relationship current is healed by a new
 * server-generated point refresh scheduled after successful settlement.
 */
function buildAutomationEffectTimeEvidence(delivery, result, settlementReceivedAt = new Date()) {
  const lowerAt = date(delivery?.writeCommitAt);
  if (!lowerAt) return null;
  const upperAt = date(settlementReceivedAt) || new Date();
  const raw = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const producerAt = date(raw.effectObservedAt);
  const producerTimeAccepted = Boolean(
    producerAt
    && producerAt.getTime() >= lowerAt.getTime()
    && producerAt.getTime() <= upperAt.getTime(),
  );
  return {
    causalLowerAt: lowerAt,
    causalUpperAt: upperAt,
    effectTimeBasis: "SERVER_CAUSAL_INTERVAL_RECONCILE",
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
    effectTimeBasis: evidence.effectTimeBasis,
    effectCausalLowerAt: evidence.causalLowerAt.toISOString(),
    effectCausalUpperAt: evidence.causalUpperAt.toISOString(),
    producerEffectObservedAt: evidence.producerEffectObservedAt?.toISOString?.() || null,
    producerEffectObservedAtAccepted: evidence.producerTimeAccepted === true,
    fanDataReconcileRequired: true,
  };
}

module.exports = {
  buildAutomationEffectTimeEvidence,
  sanitizeAutomationSettlementResult,
};
