"use strict";
const { digest } = require("./team-command-contract");
const { SETTINGS_KEY, normalizeTelegramCustomReminders } = require("./custom-order-reminders");
const { decryptTelegramCredentials } = require("./telegram-mtproto-credentials");
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const ACCOUNT_LIMIT = 128;
const iso = (value) => (value ? new Date(value).toISOString() : null);
function credentialRevision(row) {
  // Fingerprint encrypted bytes, never the low-entropy secret or the session itself.
  return digest([row.id, row.apiId, row.encryptedPayload, row.iv, row.tag, row.algorithm, row.payloadVersion]);
}
function accountRevision(row) {
  return digest([
    credentialRevision(row),
    row.lifecycleState,
    iso(row.retirementRequestedAt),
    iso(row.retirementDrainCompletedAt),
    row.runtimeClaimGeneration || 0,
    row.runtimeDrainedGeneration || 0,
    row.runtimeClaimedByDeviceId || null,
    row.runtimeClaimToken || null,
  ]);
}
function publicAccount(row, now) {
  if (!row) return null;
  let sessionReady = false;
  try {
    sessionReady = !!decryptTelegramCredentials(row).session.trim();
  } catch {
    /* Settings can still show and retire an unreadable connection. */
  }
  const retiring = row.lifecycleState === "RETIRING",
    drained = retiring && !!row.retirementDrainCompletedAt;
  return {
    id: row.id,
    apiId: row.apiId,
    sessionReady,
    lifecycleState: row.lifecycleState,
    retirementRequestedAt: iso(row.retirementRequestedAt),
    drainRequired: retiring && !drained,
    drainCompleted: drained,
    forceRetireAvailable: retiring && !drained && !(row.runtimeClaimUntil && new Date(row.runtimeClaimUntil) > now),
    revision: accountRevision(row),
  };
}
async function readReminderState(db, agencyId) {
  // One SQL snapshot binds the displayed policy to the dependency generation.
  const [row] = await db.$queryRawUnsafe(
    `SELECT w.value, COALESCE(d.revision,0)::text AS revision
    FROM (SELECT $1::text AS agency) a
    LEFT JOIN "WorkspaceSetting" w ON w."agencyId"=a.agency AND w.key=$2
    LEFT JOIN "Phase2DependencyState" d ON d."agencyId"=a.agency AND d."dependencyKind"='REMINDER_POLICY' AND d."dependencyKey"=a.agency`,
    agencyId,
    SETTINGS_KEY
  );
  const reminders = normalizeTelegramCustomReminders(row?.value);
  return { reminders, remindersRevision: digest([reminders, String(row?.revision || "0")]) };
}
function assertAuthorizationIdle(row, now) {
  if (row.lifecycleState !== "ACTIVE")
    throw fail("SETTINGS_TELEGRAM_ACCOUNT_RETIRING", "Telegram connection is retiring");
  if (
    row.runtimeClaimedByDeviceId ||
    Number(row.runtimeClaimGeneration || 0) !== Number(row.runtimeDrainedGeneration || 0) ||
    (row.runtimeClaimUntil && new Date(row.runtimeClaimUntil) > now)
  )
    throw fail(
      "TELEGRAM_AUTH_RUNTIME_NOT_DRAINED",
      "Finish the current Telegram runtime and drain its queue before authorizing again"
    );
}
module.exports = {
  fail,
  ACCOUNT_LIMIT,
  credentialRevision,
  accountRevision,
  publicAccount,
  readReminderState,
  assertAuthorizationIdle,
};
