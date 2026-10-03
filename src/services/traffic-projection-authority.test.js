"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runRootCommit } = require("./db-commit-kernel");
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");
const { enterTrafficProjection, authorizeTrafficExecutor } = require("./traffic-projection-authority");

test("Traffic authority rejects an autocommit client before issuing SQL", async () => {
  const tx = { $queryRawUnsafe: () => assert.fail("must not touch the database") };
  await assert.rejects(authorizeTrafficExecutor(tx), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
  await assert.rejects(enterTrafficProjection(tx, "creator"), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
});

test("Traffic creator lock is entered only after transaction-local executor admission", async () => {
  const calls = [];
  const db = commitDatabaseFixture({
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.includes("clock_timestamp")) return [{ authorityNow: new Date() }];
      calls.push({ sql, args });return [];
    },
    $executeRawUnsafe: async (sql, ...args) => { calls.push({ sql, args });return 1; },
  });
  await runRootCommit(db, ({ tx }) => enterTrafficProjection(tx, "creator-a"));
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /traffic_executor_version/);
  assert.match(calls[1].sql, /onlinod_traffic_enter_v3/);
  assert.deepEqual(calls[1].args, ["creator-a"]);
});

test("Traffic lock failure aborts the owning root instead of continuing without serialization", async () => {
  let reached = false;
  const db = commitDatabaseFixture({
    $queryRawUnsafe: async sql => sql.includes("clock_timestamp") ? [{ authorityNow: new Date() }] : [],
    $executeRawUnsafe: async () => { throw Object.assign(new Error("lock timeout"), { code: "55P03" }); },
  });
  await assert.rejects(runRootCommit(db, async ({ tx }) => {
    await enterTrafficProjection(tx, "creator-a");reached = true;
  }), { code: "55P03" });
  assert.equal(reached, false);
});
