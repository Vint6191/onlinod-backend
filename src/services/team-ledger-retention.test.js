"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withTransactionClient } = require("../../scripts/test-support/transaction-client-fixture");
const { runTeamLedgerRetentionPage } = require("./team-ledger-retention-service");
const { settleRetentionLanes, collectRetentionResults } = require("./retention-service");

test("an entirely locked page remains pending instead of becoming a false completed sweep", async () => {
  const db = withTransactionClient({ $queryRawUnsafe: async () => [{ matched: 7, picked: 0, affected: 0 }] });
  const page = await runTeamLedgerRetentionPage({ db, kind: "tips", now: new Date(), cutoff: new Date(0) });
  assert.equal(page.compacted, 0); assert.equal(page.skippedBusy, 7); assert.equal(page.hasMore, true);
});

test("failed and partially committed lanes preserve remaining work and actual counts", () => {
  const lanes = [["teamLedgers"], ["traffic"], ["other"]];
  const report = collectRetentionResults(lanes, [
    { status: "fulfilled", value: { ok: false, error: "purchase page timeout", totalDeleted: 0, totalCompacted: 500, hasMore: false } },
    { status: "rejected", reason: new Error("connection unavailable") },
    { status: "fulfilled", value: { ok: true, totalDeleted: 3, totalCompacted: 0, hasMore: false } },
  ]);
  assert.equal(report.ok, false); assert.equal(report.partial, true); assert.equal(report.remainingWork, true);
  assert.equal(report.reason, "RETENTION_LANE_FAILED"); assert.equal(report.totalCompacted, 500); assert.equal(report.totalDeleted, 3);
  assert.equal(report.teamLedgers.hasMore, true); assert.equal(report.traffic.hasMore, true); assert.equal(report.laneErrors.length, 2);
});

test("a full but healthy page is partial work without inventing an error", () => {
  const report = collectRetentionResults([["teamLedgers"]], [{ status: "fulfilled", value: { ok: true, totalCompacted: 500, hasMore: true } }]);
  assert.equal(report.ok, true); assert.equal(report.remainingWork, true); assert.deepEqual(report.laneErrors, []);
});

test("maintenance admits at most two lanes and continues after an independent failure", async () => {
  let active = 0, peak = 0;
  const completed = [];
  const lanes = Array.from({ length: 9 }, (_, index) => [String(index), async () => {
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      completed.push(index);
      if (index === 1) throw new Error("isolated lane failure");
      return { ok: true, totalDeleted: index };
    } finally { active--; }
  }]);
  const results = await settleRetentionLanes(lanes, {});
  assert.equal(peak, 2); assert.equal(active, 0); assert.equal(completed.length, 9);
  assert.equal(results[1].status, "rejected"); assert.equal(results[8].value.totalDeleted, 8);
});

test("retention rejects invalid time and table identity before touching storage", async () => {
  let queries = 0;
  const db = withTransactionClient({ $queryRawUnsafe: async () => { queries++; return []; } });
  await assert.rejects(runTeamLedgerRetentionPage({ db, kind: "arbitrary_table", now: new Date(), cutoff: new Date() }), /PAGE_INVALID/);
  await assert.rejects(runTeamLedgerRetentionPage({ db, kind: "tips", now: new Date("bad"), cutoff: new Date() }), /TIME_INVALID/);
  assert.equal(queries, 0);
});
