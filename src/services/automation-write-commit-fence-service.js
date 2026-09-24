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

module.exports = { lockAutomationWriteCommitFence, runWithAutomationWriteCommitFence };
