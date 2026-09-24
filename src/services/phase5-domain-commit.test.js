"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runDbTransaction } = require("./db-transaction-service");
const { currentCommitContext, deferCommitHint } = require("./db-commit-kernel");
function fixture() {
  const events = [], configs = [];
  const tx = { $executeRawUnsafe: async () => 1 };
  const db = { $transaction: async (work, options) => {
    events.push("begin"); configs.push(options);
    try { const value = await work(tx); events.push("commit"); return value; }
    catch (e) { events.push("rollback"); throw e; }
  } };
  return { tx, db, events, configs };
}
test("common adapter accepts only its live transaction and preserves joined requirements", async () => {
  const f = fixture(); let held;
  await runDbTransaction(f.db, async tx => {
    held = tx;
    await runDbTransaction(tx, joined => assert.equal(joined, tx), { isolationLevel: "Serializable" });
    assert.equal(currentCommitContext().isolationLevel, "Serializable");
  }, { isolationLevel: "Serializable" });
  assert.deepEqual(f.events, ["begin", "commit"]);
  await assert.rejects(runDbTransaction(held, () => true), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
});
test("common adapter rejects a weaker outer transaction and an unrelated nested root", async () => {
  const f = fixture();
  await runDbTransaction(f.db, async tx => {
    await assert.rejects(runDbTransaction(tx, () => true, { isolationLevel: "Serializable" }), { code: "DB_COMMIT_JOIN_ISOLATION_MISMATCH" });
    await assert.rejects(runDbTransaction(f.db, () => true), { code: "DB_COMMIT_CONTEXT_REQUIRED" });
  });
  assert.equal(f.configs[0].isolationLevel, "ReadCommitted");
});
test("unreviewed domain callback is single attempt even for a safe SQL conflict", async () => {
  const f = fixture(); let effects = 0;
  await assert.rejects(runDbTransaction(f.db, () => { effects++; throw Object.assign(new Error("conflict"), { code: "P2010", meta: { code: "40001" } }); }), { code: "P2010" });
  assert.equal(effects, 1); assert.deepEqual(f.events, ["begin", "rollback"]);
});
test("an opted-in root retries the entire joined operation and discards abandoned hints", async () => {
  const f = fixture(); let attempts = 0, hints = 0;
  await runDbTransaction(f.db, async tx => {
    attempts++;
    deferCommitHint(currentCommitContext(), "notice", () => { hints++; });
    await runDbTransaction(tx, () => {
      if (attempts === 1) throw new Error("clock failure", { cause: Object.assign(new Error("conflict"), { code: "P2010", meta: { code: "40001" } }) });
    });
  }, { maxAttempts: 2, retryBaseMs: 1 });
  assert.equal(attempts, 2); assert.equal(hints, 1);
  assert.deepEqual(f.events, ["begin", "rollback", "begin", "commit"]);
});
test("common roots keep existing bounded options without silently enabling Serializable or retries", async () => {
  const f = fixture(); await runDbTransaction(f.db, () => 1, { timeout: 30000, maxWait: 10000 });
  assert.equal(f.configs.length, 1);
  assert.equal(f.configs[0].isolationLevel, "ReadCommitted");
  assert.equal(f.configs[0].maxWait, 10000);
  assert.ok(f.configs[0].timeout >= 29990 && f.configs[0].timeout <= 30000);
  await assert.rejects(runDbTransaction(f.db, () => 1, { timeout: Infinity }), { code: "DB_COMMIT_OPTIONS_INVALID" });
});
test("central desktop hint publication cannot escape a later root rollback", async () => {
  const f = fixture(); const control = require("./desktop-control-events");
  const input = { agencyId: "i7-hints", type: "JOB_AVAILABLE", jobId: "i7-one", jobKind: "fetch_earnings" };
  await assert.rejects(runDbTransaction(f.db, () => { control.publishDesktopControlEvent(input); throw new Error("stop"); }), /stop/);
  await runDbTransaction(f.db, () => { control.publishDesktopControlEvent(input); });
  const result = await control.waitForDesktopControlEvents({ agencyId: input.agencyId, afterSeq: 0, waitMs: 250 });
  assert.equal(result.events.length, 1); assert.equal(result.events[0].jobId, input.jobId);
});
