"use strict";
const PROTOCOL = "MASS_OBSERVATION_V2";
const PAGE_SIZE = 500;
const MAX_ITEMS = 100000;
const OBSERVATION_TTL_MS = 60 * 60000;
const RETIREMENT_ACCEPT_MS = 120000;
const CREATE_ACTIONS = ["MASS_QUEUE_CREATE", "MASS_NATIVE_QUEUE_CREATE", "MASS_PROVIDER_QUEUE_OBSERVED"];
const CANCEL_ACTIONS = ["MASS_QUEUE_CANCEL", "MASS_NATIVE_QUEUE_CANCEL"];
const ACTIVE = ["QUEUED", "CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED", "RETRY_SCHEDULED", "PAUSED"];
// Kept literal and shared with the physical partial index. This is CURRENT debt,
// including unnormalised pre-cutover successful/unknown rows, never all history.
const CURRENT_PREDICATE = `("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND
  ("status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') OR
   ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED') AND
    ("remoteLifecycleState" IN ('PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED') OR
     ("status"='COMPLETED' AND "remoteLifecycleState" IS NULL) OR
     ("status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry' AND "remoteLifecycleState" IS DISTINCT FROM 'SETTLED'))) OR
   ("actionType" IN ('MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND "status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry'))) `;
function hasMassCurrentDebt(row) {
  if (![...CREATE_ACTIONS, ...CANCEL_ACTIONS].includes(row?.actionType)) return false;
  return ACTIVE.includes(row.status) || (CREATE_ACTIONS.includes(row.actionType) &&
    (["PENDING", "UNKNOWN", "MIGRATION_RECONCILE_REQUIRED"].includes(row.remoteLifecycleState)
      || (row.status === "COMPLETED" && row.remoteLifecycleState == null)
      || (row.status === "FAILED" && row.failureCode === "outcome_unresolved_do_not_retry" && row.remoteLifecycleState !== "SETTLED")))
    || (CANCEL_ACTIONS.includes(row.actionType) && row.status === "FAILED" && row.failureCode === "outcome_unresolved_do_not_retry");
}
function error(code, message, status = 409, details = undefined) {
  return Object.assign(new Error(message), { name: "MassCampaignAuthorityError", code, status, details });
}
module.exports = { PROTOCOL, PAGE_SIZE, MAX_ITEMS, OBSERVATION_TTL_MS, RETIREMENT_ACCEPT_MS, CREATE_ACTIONS, CANCEL_ACTIONS, ACTIVE, CURRENT_PREDICATE, hasMassCurrentDebt, error };
