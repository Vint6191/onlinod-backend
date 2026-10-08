"use strict";

const { runDbTransaction } = require("./db-transaction-service");

const LOCK_NAMESPACE = "onlinod:automation-write-commit:v1";

async function lockAutomationWriteCommitFence({ db, agencyId, creatorId = null }) {
  const client = db || require("../prisma");
  const key = String(agencyId || "").trim();
  if (!key) throw Object.assign(new Error("agencyId is required for automation write commit fence"), { code: "AUTOMATION_COMMIT_FENCE_AGENCY_REQUIRED" });
  if (typeof client.$executeRawUnsafe !== "function") {
    throw Object.assign(new Error("Automation write commit fence requires Prisma $executeRawUnsafe support"), { code: "AUTOMATION_COMMIT_FENCE_DB_REQUIRED" });
  }
  await client.$executeRawUnsafe(
    creatorId ? "SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))" : "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    LOCK_NAMESPACE,
    key,
  );
  if (creatorId) await client.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    "onlinod:automation-creator-commit:v1", JSON.stringify([key, String(creatorId)]),
  );
  return { agencyId: key };
}

async function runWithAutomationWriteCommitFence({ db, agencyId, creatorId = null, work, options = undefined }) {
  return runDbTransaction(db, async (tx) => {
    await lockAutomationWriteCommitFence({ db: tx, agencyId, creatorId });
    return work(tx);
  }, options);
}

// Retention can cover 500 creators. Acquire the same keys in two round trips,
// retaining shared workspace admission and deterministic creator order.
async function lockAutomationWriteCommitFences({ db, scopes }) {
  if (!Array.isArray(scopes) || scopes.length > 500) throw Object.assign(new Error("Invalid bounded automation scope batch"), { code: "AUTOMATION_COMMIT_FENCE_BATCH_INVALID" });
  if (!scopes.length) return;
  if (!db?.$executeRawUnsafe || typeof db.$transaction === "function") throw Object.assign(new Error("Automation fence batch requires a transaction"), { code: "AUTOMATION_COMMIT_FENCE_TRANSACTION_REQUIRED" });
  const creators = new Map();
  for (const scope of scopes) {
    const agencyId = String(scope?.agencyId || "").trim(), creatorId = String(scope?.creatorId || "").trim();
    if (!agencyId || !creatorId || (creators.has(creatorId) && creators.get(creatorId) !== agencyId)) {
      throw Object.assign(new Error("Invalid automation creator scope"), { code: "AUTOMATION_COMMIT_FENCE_SCOPE_INVALID" });
    }
    creators.set(creatorId, agencyId);
  }
  const agencies = [...new Set(creators.values())].sort().map((key, ordinal) => ({ key, ordinal }));
  const keys = [...creators.keys()].sort().map((creatorId, ordinal) => ({ key: JSON.stringify([creators.get(creatorId), creatorId]), ordinal }));
  // PostgreSQL evaluates volatile SELECT output after ORDER BY when that
  // output is not a sort/group/distinct expression (sql-select#SQL-SELECT-LIST).
  // Sort the explicit input ordinal, never the void lock function's output.
  await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext(s.key))
    FROM jsonb_to_recordset($2::jsonb) AS s(key text, ordinal integer) ORDER BY s.ordinal`, LOCK_NAMESPACE, JSON.stringify(agencies));
  await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext(s.key))
    FROM jsonb_to_recordset($2::jsonb) AS s(key text, ordinal integer) ORDER BY s.ordinal`, "onlinod:automation-creator-commit:v1", JSON.stringify(keys));
}

module.exports = { lockAutomationWriteCommitFence, lockAutomationWriteCommitFences, runWithAutomationWriteCommitFence };
