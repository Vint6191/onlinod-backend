"use strict";

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function activeLifecycleWhere() {
  // lifecycleState became durable in the thread/source lifecycle migration. Keep null as
  // rolling/test compatibility only; RETIRING is always excluded from NEW references.
  return { OR: [{ lifecycleState: "ACTIVE" }, { lifecycleState: null }] };
}

function isActiveTelegramAccount(row) {
  return !!row && String(row.lifecycleState || "ACTIVE") === "ACTIVE";
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
  if (!db?.agencyTelegramMtprotoAccount?.updateMany) {
    throw fail(unavailableCode, "Telegram account lifecycle fencing is unavailable", 503);
  }

  // This no-op write is intentional. PostgreSQL takes the same row lock used by retirement,
  // making ACTIVE -> RETIRING mutually exclusive with creation of any NEW durable/current
  // reference to this account.
  const locked = await db.agencyTelegramMtprotoAccount.updateMany({
    where: { id, agencyId, ...activeLifecycleWhere() },
    data: { lifecycleState: "ACTIVE" },
  });
  if (Number(locked?.count || 0) === 1) {
    return { id, lifecycleState: "ACTIVE" };
  }

  const existing = db?.agencyTelegramMtprotoAccount?.findFirst
    ? await db.agencyTelegramMtprotoAccount.findFirst({ where: { id, agencyId }, select: { id: true, lifecycleState: true } })
    : null;
  if (!existing) throw fail(notFoundCode, notFoundMessage, 404);
  throw fail(retiringCode, retiringMessage, 409);
}

module.exports = {
  activeLifecycleWhere,
  isActiveTelegramAccount,
  lockActiveTelegramAccountReference,
};
