"use strict";

// Planner DTOs cross API/JSON boundaries. Keep the original in-process Error
// separately so retry policy can inspect its type/code without trusting a
// user-facing reason string or changing the serialized result.
const SCHEDULER_FAILURE_CAUSE = Symbol.for("onlinod.scheduler.failureCause");

function attachSchedulerFailureCause(result, error) {
  if (result && typeof result === "object" && error instanceof Error) {
    Object.defineProperty(result, SCHEDULER_FAILURE_CAUSE, { value: error, configurable: true });
  }
  return result;
}

function readSchedulerFailureCause(result) {
  const error = result?.[SCHEDULER_FAILURE_CAUSE];
  return error instanceof Error ? error : null;
}

// Callers supply EVERY failed/malformed substep, not just the first failure.
// Missing evidence keeps the aggregate bounded; SQL + contract failures must
// never become an indefinitely retried SQL outage merely by association.
function inheritSchedulerFailureCauses(result, failedDecisions) {
  if (!Array.isArray(failedDecisions) || !failedDecisions.length) return result;
  const causes = failedDecisions.map(readSchedulerFailureCause);
  if (causes.some(error => !error)) return result;
  const unique = [...new Set(causes)];
  return attachSchedulerFailureCause(result, unique.length === 1 ? unique[0]
    : new AggregateError(unique, "Scheduler substeps failed"));
}

module.exports = { SCHEDULER_FAILURE_CAUSE, attachSchedulerFailureCause, readSchedulerFailureCause, inheritSchedulerFailureCauses };
