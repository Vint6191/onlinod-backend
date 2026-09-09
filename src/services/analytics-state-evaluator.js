"use strict";

const { trustedCollectionTimestamp } = require("./analytics-freshness-policy");

function date(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function evaluateCollectionState({
  status,
  proofStatus = null,
  lastVerifiedAt = null,
  retryAfterAt = null,
  now = new Date(),
  freshnessMs = null,
  partialUsable = false,
  forceDue = false,
} = {}) {
  const currentNow = date(now) || new Date();
  const normalizedStatus = String(status || "MISSING").toUpperCase();
  const complete = normalizedStatus === "COMPLETE";
  const partial = normalizedStatus === "PARTIAL";
  const proven = String(proofStatus || "").toUpperCase() === "COMMITTED";
  const usable = proven && (complete || (partialUsable && partial));
  const verifiedAt = date(lastVerifiedAt);
  const trustedVerifiedAt = trustedCollectionTimestamp(verifiedAt, currentNow);
  const futurePoisoned = Boolean(verifiedAt && !trustedVerifiedAt);
  const policyMs = Number(freshnessMs);
  const withinFreshness = Boolean(
    usable && trustedVerifiedAt && Number.isFinite(policyMs) && policyMs >= 0
    && currentNow.getTime() - trustedVerifiedAt.getTime() <= policyMs
  );
  const retryAt = date(retryAfterAt);
  const deferred = !forceDue && !withinFreshness && Boolean(retryAt && retryAt > currentNow);
  const stale = usable && !withinFreshness;
  const unavailable = !usable && !partial;
  const due = forceDue || (!withinFreshness && !deferred);
  return Object.freeze({
    complete,
    partial,
    proven,
    usable,
    fresh: withinFreshness,
    stale,
    due,
    deferred,
    failed: normalizedStatus === "FAILED",
    unavailable,
    status: normalizedStatus,
    lastVerifiedAt: verifiedAt,
    retryAfterAt: retryAt,
    futurePoisoned,
  });
}

function evaluateAggregateCollectionState({
  expectedUnits,
  completeUnits = 0,
  provenUsableUnits = 0,
  freshUsableUnits = 0,
  partialUnits = 0,
  retryAfterAt = null,
  now = new Date(),
  forceDue = false,
} = {}) {
  const expected = Math.max(0, Number(expectedUnits || 0));
  const completeCount = Math.max(0, Number(completeUnits || 0));
  const provenCount = Math.max(0, Number(provenUsableUnits || 0));
  const freshCount = Math.max(0, Number(freshUsableUnits || 0));
  const partialCount = Math.max(0, Number(partialUnits || 0));
  const complete = expected > 0 && completeCount >= expected;
  const proven = expected > 0 && provenCount >= expected;
  const usable = proven;
  const fresh = proven && freshCount >= expected;
  const partial = (!proven && provenCount > 0) || (!complete && partialCount > 0);
  const currentNow = date(now) || new Date();
  const retryAt = date(retryAfterAt);
  const deferred = !forceDue && !fresh && Boolean(retryAt && retryAt > currentNow);
  const stale = usable && !fresh;
  const due = forceDue || (!fresh && !deferred);
  return Object.freeze({
    expectedUnits: expected,
    completeUnits: completeCount,
    provenUsableUnits: provenCount,
    freshUsableUnits: freshCount,
    partialUnits: partialCount,
    complete,
    partial,
    proven,
    usable,
    fresh,
    stale,
    due,
    deferred,
    failed: false,
    unavailable: provenCount === 0,
    retryAfterAt: retryAt,
  });
}

function evaluateDurableCollectorState({
  status,
  baselineCompletedAt = null,
  baselineVerifiedAt = null,
  lastVerifiedAt = null,
  retryAfterAt = null,
  now = new Date(),
  freshnessMs = null,
} = {}) {
  const currentNow = date(now) || new Date();
  const normalizedStatus = String(status || "MISSING").toUpperCase();
  const completedAt = date(baselineCompletedAt) || date(baselineVerifiedAt);
  const provenAt = date(baselineVerifiedAt);
  const verifiedAt = date(lastVerifiedAt) || provenAt;
  const complete = Boolean(completedAt);
  const trustedProvenAt = trustedCollectionTimestamp(provenAt, currentNow);
  const trustedVerifiedAt = trustedCollectionTimestamp(verifiedAt, currentNow);
  const proven = Boolean(trustedProvenAt);
  const usable = proven;
  const partial = complete && !proven;
  const policyMs = Number(freshnessMs);
  const futurePoisoned = Boolean((provenAt && !trustedProvenAt) || (verifiedAt && !trustedVerifiedAt));
  const fresh = Boolean(
    usable && trustedVerifiedAt && Number.isFinite(policyMs) && policyMs >= 0
    && currentNow.getTime() - trustedVerifiedAt.getTime() <= policyMs
  );
  const retryAt = date(retryAfterAt);
  const deferred = !fresh && Boolean(retryAt && retryAt > currentNow);
  const failed = normalizedStatus === "FAILED";
  const terminalFailed = failed && !deferred;
  const stale = usable && !fresh;
  const due = !fresh && !deferred && !terminalFailed;
  return Object.freeze({
    complete, partial, proven, usable, fresh, stale, due, deferred, failed,
    unavailable: !usable && !partial,
    collecting: normalizedStatus === "SCANNING",
    status: normalizedStatus,
    baselineCompletedAt: completedAt,
    baselineVerifiedAt: provenAt,
    lastVerifiedAt: verifiedAt,
    retryAfterAt: retryAt,
    futurePoisoned,
  });
}

function stateVocabulary(state) {
  if (!state) return "UNAVAILABLE";
  if (state.deferred) return state.stale || state.partial ? "STALE_DEFERRED" : "DEFERRED";
  if (state.failed) return "FAILED";
  if (state.fresh) return "FRESH";
  if (state.stale) return "STALE";
  if (state.partial) return "PARTIAL";
  if (state.due) return "DUE";
  return "UNAVAILABLE";
}

module.exports = { evaluateCollectionState, evaluateAggregateCollectionState, evaluateDurableCollectorState, stateVocabulary };
