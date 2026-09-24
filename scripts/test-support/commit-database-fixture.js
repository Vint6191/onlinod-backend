"use strict";
const assert = require("node:assert/strict");
const prepared = new WeakMap();
function commitDatabaseFixture(db) {
  if (!db || typeof db !== "object") return db;
  const { currentCommitContext } = require("../../src/services/db-commit-kernel");
  if (currentCommitContext()?.tx === db || (prepared.has(db) && prepared.get(db) === db.$transaction)) return db;
  const driver = typeof db.$transaction === "function" ? db.$transaction.bind(db) : async work => work(db);
  db.$transaction = (work, options) => driver(raw => {
    // Model the real Prisma interface, never present a root as TransactionClient.
    const tx = { ...raw }; delete tx.$transaction;
    if (typeof raw.$executeRawUnsafe === "function") tx.$executeRawUnsafe = (sql, ...args) => {
      if (sql === "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)") {
        assert.equal(args.length, 2); for (const value of args) assert.match(value, /^[1-9][0-9]*ms$/);
        return Promise.resolve(1);
      }
      return raw.$executeRawUnsafe(sql, ...args);
    };
    return work(tx);
  }, options);
  prepared.set(db, db.$transaction);
  return db;
}
module.exports = { commitDatabaseFixture };
