"use strict";

// Claims count scheduling units, not failures: a healthy enumeration may claim
// thousands of pages. Only failed executions of the same revision spend this
// budget. Unknown errors are bounded too; they must never become an infinite loop.
const MAX_CONSECUTIVE_FAILURES = 8;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const CONTRACT_CODES = new Set([
  "P2000", "P2003", "P2004", "P2005", "P2006", "P2007", "P2009", "P2011", "P2012",
  "P2013", "P2014", "P2018", "P2021", "P2022", "P2023", "P2025",
  "22001", "22003", "22P02", "23502", "23503", "23514", "42703", "42P01",
  "PHASE2_COVERAGE_FAMILY_UNSUPPORTED", "CUSTOM_EXTERNAL_WORK_TYPE_UNSUPPORTED",
  "CUSTOM_REMINDER_WORK_PARENT_REQUIRED", "TEAM_DIALOG_WORK_TYPE_UNSUPPORTED",
  "TEAM_DIALOG_WORK_IDENTITY_INVALID", "TEAM_RESPONSE_RANGE_WORK_TYPE_UNSUPPORTED",
  "TEAM_READ_SUMMARY_WORK_TYPE_UNSUPPORTED", "TELEGRAM_INBOUND_WORK_TYPE_UNSUPPORTED",
  "TELEGRAM_CONFIRMED_WORK_TYPE_UNSUPPORTED", "CUSTOM_SUBMISSION_SOURCE_IDENTITY_REQUIRED",
  "DOMAIN_WORK_IDENTITY_REQUIRED", "DOMAIN_WORK_DEPENDENCY_REQUIRED",
  "DOMAIN_DEPENDENCY_WAKE_IDENTITY_REQUIRED",
  "CUSTOM_SUBMISSION_EXECUTION_PROFILE_LEGACY_BINDING_CONFLICT",
  "CUSTOM_SUBMISSION_EXECUTION_PROFILE_LEGACY_RECIPIENT_CONFLICT",
]);

function domainWorkFailureOutcome({ error, consecutiveFailures }) {
  const code = String(error?.code || "DOMAIN_WORK_FAILED").slice(0, 120);
  const sqlCode = String(error?.meta?.code || error?.cause?.code || "");
  const contract = error?.retryable === false || CONTRACT_CODES.has(code) || CONTRACT_CODES.has(sqlCode)
    || ["TypeError", "ReferenceError", "SyntaxError", "PrismaClientValidationError", "ZodError"].includes(error?.name);
  const exhausted = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  return {
    code,
    state: contract || exhausted ? "RECONCILE_REQUIRED" : "READY",
    errorClass: contract ? "CONTRACT" : exhausted ? "RETRY_EXHAUSTED" : "TRANSIENT",
    terminalCause: contract ? code : exhausted ? `RETRY_EXHAUSTED:${code}` : null,
    delayMs: Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(10, consecutiveFailures)),
  };
}

module.exports = { domainWorkFailureOutcome, MAX_CONSECUTIVE_FAILURES, MAX_RETRY_DELAY_MS };
