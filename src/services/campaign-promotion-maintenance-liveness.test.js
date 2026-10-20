"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function load(t) {
  const saved = new Map();
  const dependencies = {
    "./db-transaction-service": { runDbTransaction: async (db, work) => work(db), lockDbAdvisoryXact: async () => {} },
    "./db-time-authority-service": { dbAuthorityNow: async () => new Date("2026-10-20T00:00:00Z") },
    "./campaign-transaction-lock-service": { acquireCampaignTransactionLock: async () => {}, withCampaignTransactionLock: async ({ db, work }) => work(db) },
  };
  for (const [request, exports] of Object.entries(dependencies)) {
    const id = require.resolve(request); saved.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  const id = require.resolve("./campaign-fan-refresh-queue-service");
  saved.set(id, require.cache[id]); delete require.cache[id];
  const service = require(id);
  t.after(() => { for (const [key, prior] of saved) { if (prior) require.cache[key] = prior; else delete require.cache[key]; } });
  return service;
}

// Execute the real signal-processing branch against an empty debt page. Only
// transport and persistence are adapters; the production worker owns, fences
// and deletes the signal through its normal maintenance path.
function fixture({ afterClaim = () => {}, nextClaim = async () => [], beforeProcess = async () => {} } = {}) {
  const signal = { id: "signal", agencyId: "agency", creatorId: "creator", revision: 1, attempts: 0 };
  let claims = 0, deleted = false;
  const db = {
    $transaction() {},
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.includes('WITH candidate AS') && sql.includes('UPDATE "CampaignFanRefreshPromotionSignal" s')) {
        claims++;
        if (claims > 1) return nextClaim();
        Object.assign(signal, { claimToken: args[1], claimUntil: args[2] });
        afterClaim(); return [{ ...signal }];
      }
      if (sql.includes('SELECT * FROM "CampaignFanRefreshPromotionSignal"')) { await beforeProcess(); return [{ ...signal }]; }
      if (sql.includes('WITH page AS MATERIALIZED')) return [];
      if (sql.includes('AS "coverageTransitionLost"')) return [{ recovered: 0, requeuedWork: 0, coverageRunsUpdated: 0 }];
      if (sql.includes('SELECT * FROM "CreatorFanRefreshDemand"')) return [];
      if (sql.includes('AS "failedDue"')) return [{ queued: false, failedDue: false, nextRetryAt: null }];
      throw Error("UNEXPECTED_PROMOTION_QUERY: " + sql);
    },
    $executeRawUnsafe: async sql => { assert.match(sql, /SET "healAfterId"/); return 1; },
    creatorFanRefreshDemand: { findMany: async () => [] },
    jobInstance: {},
    campaignFanRefreshPromotionSignal: {
      deleteMany: async ({ where }) => {
        assert.equal(where.id, signal.id); assert.equal(where.claimToken, signal.claimToken); assert.equal(where.revision, signal.revision);
        deleted = true; return { count: 1 };
      },
    },
  };
  return { db, get claims() { return claims; }, get deleted() { return deleted; } };
}

test("a slow Campaign promotion claim still processes its owned signal after the soft budget", async t => {
  let clock = 0; t.mock.method(Date, "now", () => clock);
  const service = load(t), f = fixture({ afterClaim: () => { clock = 9000; } });
  const result = await service.runCampaignFanRefreshPromotionMaintenance({ db: f.db, maxRuntimeMs: 8000, concurrency: 4 });
  assert.equal(result.ok, true); assert.equal(result.processedCreators, 1);
  assert.equal(f.deleted, true, "the claimed signal must converge instead of waiting for its lease to expire");
  assert.equal(f.claims, 1, "expired soft budget stops new admission after the owned unit");
});

test("a failed sibling Campaign claim is reported only after the existing owner has drained", async t => {
  const entered = defer(), proceed = defer(), failed = defer();
  const service = load(t), f = fixture({
    beforeProcess: async () => { entered.resolve(); await proceed.promise; },
    nextClaim: async () => { failed.resolve(); throw Object.assign(Error("pool unavailable"), { code: "P2024" }); },
  });
  let settled = false;
  const run = service.runCampaignFanRefreshPromotionMaintenance({ db: f.db, concurrency: 2, maxCreators: 4 });
  run.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.all([entered.promise, failed.promise]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "maintenance cannot return while its sibling still owns a signal");
  } finally { proceed.resolve(); }
  const result = await run;
  assert.equal(result.ok, false); assert.equal(result.errors, 1); assert.equal(result.errorDetails[0].code, "P2024");
  assert.equal(result.processedCreators, 1); assert.equal(f.deleted, true); assert.equal(f.claims, 2);
});
