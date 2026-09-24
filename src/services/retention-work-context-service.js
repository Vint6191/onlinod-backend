"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { runDbTransaction } = require("./db-transaction-service");
const { lockRetentionCommit } = require("./retention-commit-guard-service");
const context = new AsyncLocalStorage();

function withRetentionWork(ownerToken, work, actorGuard = null) { return context.run({ ownerToken, actorGuard }, work); }
async function guardRetentionTransaction(tx) {
  const current = context.getStore();
  if (current?.actorGuard) await current.actorGuard(tx);
  const ownerToken = current?.ownerToken;
  if (ownerToken) await lockRetentionCommit({ tx, ownerToken });
}
async function runRetentionMutation(work, db = require("../prisma")) {
  return runDbTransaction(db, async tx => {
    await guardRetentionTransaction(tx);
    return work(tx);
  }, { maxWait: 5000, timeout: 30000 });
}
module.exports = { withRetentionWork, guardRetentionTransaction, runRetentionMutation };
