"use strict";
const { isCommitTransaction } = require("./db-commit-kernel");

async function authorizeTrafficExecutor(tx) {
  if (!isCommitTransaction(tx)) throw Object.assign(new Error("DB_COMMIT_CONTEXT_REQUIRED"), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
  await tx.$queryRawUnsafe("SELECT set_config('onlinod.traffic_executor_version','3',true)");
}

// Call before any Traffic row lock or canonical fact read used for projection.
// Canonical producers publish durable work without taking this lock; workers
// can therefore never wait for a producer which is waiting for Traffic.
async function enterTrafficProjection(tx, creatorId) {
  await authorizeTrafficExecutor(tx);
  await tx.$executeRawUnsafe('SELECT "onlinod_traffic_enter_v3"($1)', creatorId);
}

module.exports = { authorizeTrafficExecutor, enterTrafficProjection };
