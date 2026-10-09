"use strict";
const AUTH_HISTORY_PUBLISHER_GENERATION = "actual60_auth_history_publisher_v1";
const AUTH_HISTORY_DB_SETTING = "onlinod.actual60_auth_history_generation";
async function authorizeAuthorizationHistoryPublisher(db) {
  if (typeof db?.$queryRawUnsafe !== "function" || typeof db?.$executeRawUnsafe !== "function") {
    return { admitted: true, adapter: true, generation: AUTH_HISTORY_PUBLISHER_GENERATION };
  }
  // set_config(..., true) must live in the same transaction as RefreshSession DML.
  if (typeof db?.$transaction === "function") {
    const error = new Error("Authorization-history publisher generation requires an active database transaction");
    error.code = "AUTH_HISTORY_PUBLISHER_TRANSACTION_REQUIRED";
    error.status = 500;
    throw error;
  }
  await db.$queryRawUnsafe(
    `SELECT set_config($1,$2,true) AS value`,
    AUTH_HISTORY_DB_SETTING,
    AUTH_HISTORY_PUBLISHER_GENERATION,
  );
  return { admitted: true, adapter: false, generation: AUTH_HISTORY_PUBLISHER_GENERATION };
}

module.exports = { authorizeAuthorizationHistoryPublisher };
