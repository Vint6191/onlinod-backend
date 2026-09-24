"use strict";

function rootPrisma() { return require("../prisma"); }
const { runRootCommit, joinCommit, currentCommitContext } = require("./db-commit-kernel");

async function runDbTransaction(db, work, options = undefined) {
  const client = db || rootPrisma();
  if (typeof work !== "function") throw new TypeError("runDbTransaction requires a work callback");
  const context = currentCommitContext();
  const requirements = options || {};
  if (context && context.tx === client) {
    return joinCommit(context, requirements, ({ tx }) => work(tx));
  }
  // No duck-typed join and no unrelated root while another commit is active.
  // A transaction client is valid only within its kernel-issued attempt.
  if (context || typeof client.$transaction !== "function") {
    throw Object.assign(new Error("Use the current kernel transaction for composition"), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
  }
  const timeout = requirements.timeout ?? 5000;
  const maxWait = requirements.maxWait ?? 5000;
  return runRootCommit(client, ({ tx }) => work(tx), {
    timeout, maxWait, deadlineMs: Math.min(120000, timeout + maxWait),
    lockTimeoutMs: Math.min(timeout, 5000), statementTimeoutMs: timeout,
    // Existing domain callbacks are not implicitly made replayable. Reviewed
    // command families opt into retry at their root, never in a joined helper.
    maxAttempts: 1, ...requirements,
  });
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
