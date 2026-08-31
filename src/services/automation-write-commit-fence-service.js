"use strict";

const { runDbTransaction } = require("./db-transaction-service");

const LOCK_NAMESPACE = "onlinod:automation-write-commit:v1";

async function lockAutomationWriteCommitFence({ db, agencyId }) {
  const client = db || require("../prisma");
  const key = String(agencyId || "").trim();
  if (!key) throw Object.assign(new Error("agencyId is required for automation write commit fence"), { code: "AUTOMATION_COMMIT_FENCE_AGENCY_REQUIRED" });
  if (typeof client.$queryRawUnsafe !== "function") {
    throw Object.assign(new Error("Automation write commit fence requires a transaction-capable database client"), { code: "AUTOMATION_COMMIT_FENCE_DB_REQUIRED" });
  }
  await client.$queryRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    LOCK_NAMESPACE,
    key,
  );
  return { agencyId: key };
}

async function runWithAutomationWriteCommitFence({ db, agencyId, work, options = undefined }) {
  return runDbTransaction(db, async (tx) => {
    await lockAutomationWriteCommitFence({ db: tx, agencyId });
    return work(tx);
  }, options);
}

module.exports = { lockAutomationWriteCommitFence, runWithAutomationWriteCommitFence };
