"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { runRootCommit, joinCommit } = require("./db-commit-kernel");
const { lockRetentionCommit } = require("./retention-commit-guard-service");
const context = new AsyncLocalStorage();

function withRetentionWork(ownerToken, work, actorGuard = null) { return context.run({ ownerToken, actorGuard }, work); }
async function guardRetentionTransaction(tx) {
  const current = context.getStore();
  if (current?.actorGuard) await current.actorGuard(tx);
  if (current?.ownerToken) await lockRetentionCommit({ tx, ownerToken: current.ownerToken });
}
async function runRetentionMutation(work, db = require("../prisma")) {
  return runRootCommit(db, async ({ tx }) => {
    await guardRetentionTransaction(tx);
    const result = await work(tx);
    // Locks preserve identity, not time. Check the session and lease again
    // after bounded cleanup and every wait, before making deletions durable.
    await guardRetentionTransaction(tx);
    return result;
  }, { profile: "RETENTION_MUTATION", authority: { kind: "RETENTION_BATCH" } });
}

// Lease settlement has its own owner-token CAS and may finish a pass whose
// initiating Admin session expired. Only Admin claim may explicitly join.
async function runRetentionControl(db, work, commitContext = null) {
  if (commitContext) {
    return joinCommit(commitContext, { authorityKind: "ADMIN_RETENTION_CLAIM", isolationLevel: "ReadCommitted" }, async context => {
      if (context.tx !== db) throw Object.assign(new Error("Retention join requires the root transaction client"), { code: "DB_COMMIT_JOIN_SCOPE_MISMATCH" });
      return work(context.tx);
    });
  }
  return runRootCommit(db, ({ tx }) => work(tx), { profile: "ADMIN_BACKGROUND", authority: { kind: "RETENTION_LEASE" } });
}
module.exports = { withRetentionWork, guardRetentionTransaction, runRetentionMutation, runRetentionControl };
