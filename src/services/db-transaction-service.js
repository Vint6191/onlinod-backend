"use strict";

function rootPrisma() { return require("../prisma"); }

async function runDbTransaction(db, work, options = undefined) {
  const client = db || rootPrisma();
  if (typeof work !== "function") throw new TypeError("runDbTransaction requires a work callback");
  if (typeof client.$transaction !== "function") return work(client);
  return options === undefined ? client.$transaction(work) : client.$transaction(work, options);
}

async function lockDbAdvisoryXact({ db, key, mode = "exclusive" }) {
  const client = db || rootPrisma();
  const normalized = String(key || "").trim();
  if (!normalized) throw Object.assign(new Error("Advisory transaction lock key is required"), { code: "DB_ADVISORY_LOCK_KEY_REQUIRED" });
  if (typeof client.$executeRawUnsafe !== "function") {
    throw Object.assign(new Error("Advisory transaction lock requires Prisma $executeRawUnsafe support"), { code: "DB_ADVISORY_LOCK_CLIENT_REQUIRED" });
  }
  const lockMode = String(mode || "exclusive").toLowerCase() === "shared" ? "shared" : "exclusive";
  const sql = lockMode === "shared"
    ? "SELECT pg_advisory_xact_lock_shared(hashtext($1))"
    : "SELECT pg_advisory_xact_lock(hashtext($1))";
  await client.$executeRawUnsafe(sql, normalized);
  return { key: normalized };
}

async function withDbAdvisoryXactLock({ db, key, mode = "exclusive", work, options = undefined }) {
  return runDbTransaction(db, async (tx) => {
    await lockDbAdvisoryXact({ db: tx, key, mode });
    return work(tx);
  }, options);
}

module.exports = { runDbTransaction, lockDbAdvisoryXact, withDbAdvisoryXactLock };
