"use strict";

const FAILURE_CATEGORIES = Object.freeze({
  DEFINITE_NO_WRITE_RETRYABLE: "DEFINITE_NO_WRITE_RETRYABLE",
  OUTCOME_UNKNOWN_RECONCILE: "OUTCOME_UNKNOWN_RECONCILE",
  TERMINAL: "TERMINAL",
  CONTROL_BLOCKED: "CONTROL_BLOCKED",
  SESSION_UNAVAILABLE: "SESSION_UNAVAILABLE",
  IDEMPOTENT_RETRYABLE: "IDEMPOTENT_RETRYABLE",
});

const SAFE_RETRY_CATEGORIES = Object.freeze([
  FAILURE_CATEGORIES.DEFINITE_NO_WRITE_RETRYABLE,
  FAILURE_CATEGORIES.IDEMPOTENT_RETRYABLE,
  FAILURE_CATEGORIES.SESSION_UNAVAILABLE,
]);

const CONTROL_CODES = new Set([
  "workspace_disabled", "creator_disabled", "module_disabled", "access_revoked",
  "creator_access_revoked", "member_access_epoch_stale", "member_creator_scope_revoked",
]);
const SESSION_CODES = new Set([
  "creator_unavailable", "session_unavailable", "session_write_unavailable", "write_pacing",
]);
const DEFINITE_NO_WRITE_CODES = new Set([
  "backend_temporary_error", "rate_limited", "global_gate_unavailable", "global_gate_rejected",
]);
const IDEMPOTENT_RETRY_CODES = new Set([
  "content_not_found", "fan_not_found", "dialog_not_found",
]);
const OUTCOME_UNKNOWN_CODES = new Set([
  "send_result_unknown", "comment_result_unknown", "relay_send_result_unknown", "vault_create_list_result_unknown", "write_outcome_unknown", "write_outcome_ambiguous", "write_result_unknown", "network_error",
  "timeout", "temporary_of_error", "lease_lost", "send_reconcile_pending", "reconciliation_lease_lost",
]);

function normalizeFailureCategory(value) {
  const text = String(value || "").trim().toUpperCase();
  return Object.values(FAILURE_CATEGORIES).includes(text) ? text : null;
}

function classifyAutomationFailure({
  failureCode,
  deliveryStatus,
  provenNoEffect = false,
  idempotent = false,
  endpointSemantics = null,
  writeReachedWire = false,
  outcomeState = null,
  transportCode = null,
} = {}) {
  const code = String(failureCode || "unknown").trim().toLowerCase() || "unknown";
  const semantics = String(endpointSemantics || "").trim().toUpperCase();
  const isIdempotent = idempotent === true || semantics === "IDEMPOTENT_WRITE";
  const reachedWire = writeReachedWire === true
    || String(outcomeState || "").trim().toUpperCase() === "ON_WIRE_UNKNOWN"
    || String(deliveryStatus || "").trim().toUpperCase() === "COMMITTING";
  const transport = String(transportCode || "").trim().toLowerCase();

  if (CONTROL_CODES.has(code)) return FAILURE_CATEGORIES.CONTROL_BLOCKED;
  if (SESSION_CODES.has(code)) return FAILURE_CATEGORIES.SESSION_UNAVAILABLE;

  // Proof of no external effect is stronger than a string code. Once no effect
  // is proven, a later attempt is safe regardless of how the transport failed.
  if (provenNoEffect === true) {
    return isIdempotent || IDEMPOTENT_RETRY_CODES.has(code)
      ? FAILURE_CATEGORIES.IDEMPOTENT_RETRYABLE
      : FAILURE_CATEGORIES.DEFINITE_NO_WRITE_RETRYABLE;
  }

  // Desired-state writes may repeat after an ambiguous response. This is a
  // property of the endpoint registry, not a Desktop retryable hint.
  if (isIdempotent && (reachedWire || OUTCOME_UNKNOWN_CODES.has(code) || OUTCOME_UNKNOWN_CODES.has(transport) || code === "write_outcome_ambiguous" || code === "delete_not_confirmed")) {
    return FAILURE_CATEGORIES.IDEMPOTENT_RETRYABLE;
  }

  // For a non-idempotent commit, reached-wire evidence is sufficient to force
  // reconciliation even if a future failure code is not yet in a Set.
  if (reachedWire && !isIdempotent) return FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE;

  if (code === "unknown") return FAILURE_CATEGORIES.TERMINAL;
  if (DEFINITE_NO_WRITE_CODES.has(code)) return FAILURE_CATEGORIES.DEFINITE_NO_WRITE_RETRYABLE;
  if (IDEMPOTENT_RETRY_CODES.has(code)) return FAILURE_CATEGORIES.IDEMPOTENT_RETRYABLE;
  if (OUTCOME_UNKNOWN_CODES.has(code) || OUTCOME_UNKNOWN_CODES.has(transport)) return FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE;
  return FAILURE_CATEGORIES.TERMINAL;
}
function categoryAllowsBlindRetry(category) {
  return SAFE_RETRY_CATEGORIES.includes(normalizeFailureCategory(category));
}

module.exports = {
  FAILURE_CATEGORIES,
  SAFE_RETRY_CATEGORIES,
  normalizeFailureCategory,
  classifyAutomationFailure,
  categoryAllowsBlindRetry,
};
