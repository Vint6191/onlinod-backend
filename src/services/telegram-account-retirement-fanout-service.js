"use strict";

const { runCreatorAccountWriteTransaction } = require("./phase2-release-compatibility-authority-service");

async function processTelegramAccountRetirementFanoutInContext({ db, item, now = new Date(), batchSize = 50 } = {}) {
  const agencyId = String(item?.agencyId || "").trim();
  const accountId = String(item?.objectId || item?.accountId || "").trim();
  if (!agencyId || !accountId) {
    const error = new Error("TELEGRAM_ACCOUNT_RETIREMENT_IDENTITY_REQUIRED");
    error.code = "TELEGRAM_ACCOUNT_RETIREMENT_IDENTITY_REQUIRED";
    throw error;
  }

  const account = await db?.agencyTelegramMtprotoAccount?.findFirst?.({
    where: { id: accountId, agencyId },
    select: { id: true, agencyId: true, lifecycleState: true },
  });
  if (!account) return { complete: true, obsolete: true, detached: 0 };
  if (String(account.lifecycleState || "") !== "RETIRING") {
    const error = new Error("TELEGRAM_ACCOUNT_RETIREMENT_STATE_INVALID");
    error.code = "TELEGRAM_ACCOUNT_RETIREMENT_STATE_INVALID";
    throw error;
  }

  const take = Math.max(1, Math.min(100, Number(batchSize) || 50));
  const creators = await db.creatorAccount.findMany({
    where: { agencyId, telegramAccountId: accountId },
    select: { id: true },
    orderBy: { id: "asc" },
    take,
  });
  const ids = (creators || []).map((row) => String(row.id));
  if (ids.length) {
    const changed = await db.creatorAccount.updateMany({
      where: { agencyId, id: { in: ids }, telegramAccountId: accountId },
      data: { telegramAccountId: null },
    });
    return {
      complete: false,
      detached: Number(changed?.count || 0),
      progressCursor: { detachedThroughCreatorId: ids[ids.length - 1] },
    };
  }

  // RETIRING is the admission fence for new authoritative bindings. Re-prove zero
  // immediately before the conditional delete. Durable CreatorAccount bindings are
  // the restart cursor: a crash simply leaves the remaining bindings for the next lease.
  const remaining = await db.creatorAccount.findFirst({
    where: { agencyId, telegramAccountId: accountId },
    select: { id: true },
  });
  if (remaining) return { complete: false, detached: 0 };

  const deleted = await db.agencyTelegramMtprotoAccount.deleteMany({
    where: { id: accountId, agencyId, lifecycleState: "RETIRING" },
  });
  if (Number(deleted?.count || 0) === 0) {
    // A concurrent lifecycle change must never be reported as successful retirement.
    const current = await db.agencyTelegramMtprotoAccount.findFirst({
      where: { id: accountId, agencyId },
      select: { id: true, lifecycleState: true },
    });
    if (current) {
      const error = new Error("TELEGRAM_ACCOUNT_RETIREMENT_FINALIZE_RACE");
      error.code = "TELEGRAM_ACCOUNT_RETIREMENT_FINALIZE_RACE";
      throw error;
    }
  }
  return { complete: true, detached: 0 };
}

async function processTelegramAccountRetirementFanout({ db, item, now = new Date(), batchSize = 50 } = {}) {
  return runCreatorAccountWriteTransaction(db, (tx) =>
    processTelegramAccountRetirementFanoutInContext({ db: tx, item, now, batchSize }),
  );
}

module.exports = { processTelegramAccountRetirementFanout };
