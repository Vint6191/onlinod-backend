"use strict";

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function activeLifecycleWhere() {
  return { lifecycleState: "ACTIVE" };
}

function telegramLifecycleState(row) {
  const state = String(row?.lifecycleState || "").trim().toUpperCase();
  return state === "ACTIVE" || state === "RETIRING" ? state : null;
}

function isActiveTelegramAccount(row) { return telegramLifecycleState(row) === "ACTIVE"; }
function isRetiringTelegramAccount(row) { return telegramLifecycleState(row) === "RETIRING"; }

async function lockTelegramAccountLifecycleRow({ agencyId, accountId, db } = {}) {
  const id = String(accountId || "").trim();
  if (!id || !agencyId) return null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT "id","agencyId","lifecycleState","runtimeClaimGeneration","runtimeDrainedGeneration",
              "runtimeClaimedByDeviceId","runtimeClaimUntil","retirementRequestedAt","retirementDrainCompletedAt"
         FROM "AgencyTelegramMtprotoAccount"
        WHERE "id"=$1 AND "agencyId"=$2
        FOR UPDATE`,
      id, String(agencyId),
    );
    return rows?.[0] || null;
  }
  // Reduced in-memory test doubles have no PostgreSQL row-lock primitive. Production Prisma
  // transactions always take the SELECT ... FOR UPDATE branch above; do not emulate the lock
  // with UPDATE lifecycleState=lifecycleState because that fires semantic UPDATE OF triggers.
  return db?.agencyTelegramMtprotoAccount?.findFirst
    ? db.agencyTelegramMtprotoAccount.findFirst({ where: { id, agencyId } })
    : null;
}

async function lockActiveTelegramAccountReference({
  agencyId,
  accountId,
  db,
  notFoundCode = "TELEGRAM_ACCOUNT_NOT_FOUND",
  retiringCode = "TELEGRAM_ACCOUNT_RETIRING",
  unavailableCode = "TELEGRAM_ACCOUNT_REFERENCE_FENCE_UNAVAILABLE",
  notFoundMessage = "Telegram connection was not found",
  retiringMessage = "Telegram connection is retiring and cannot accept a new reference",
} = {}) {
  const id = String(accountId || "").trim();
  if (!id || !agencyId) throw fail(notFoundCode, notFoundMessage, 404);
  if (typeof db?.$queryRawUnsafe !== "function" && !db?.agencyTelegramMtprotoAccount?.findFirst) {
    throw fail(unavailableCode, "Telegram account lifecycle fencing is unavailable", 503);
  }
  const row = await lockTelegramAccountLifecycleRow({ agencyId, accountId: id, db });
  if (!row) throw fail(notFoundCode, notFoundMessage, 404);
  if (!isActiveTelegramAccount(row)) throw fail(retiringCode, retiringMessage, 409);
  return { ...row, id, lifecycleState: "ACTIVE" };
}

module.exports = {
  activeLifecycleWhere,
  telegramLifecycleState,
  isActiveTelegramAccount,
  isRetiringTelegramAccount,
  lockTelegramAccountLifecycleRow,
  lockActiveTelegramAccountReference,
};
