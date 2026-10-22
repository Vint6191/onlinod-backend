"use strict";
// Current-schema persisted-state proof: old retry timestamps are not a new
// budget, and a surviving same-job retry remains the only active episode.
const assert = require("node:assert/strict"), path = require("node:path");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const root = path.resolve(__dirname, "../..");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("COLLECTOR_UPGRADE_PROOF_TIMEOUT"); process.exit(2); }, 180000);
const cases = [];

async function main() {
  const f = await fixture(), { db } = f;
  try {
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
    const control = require(root + "/src/services/analytics-collector-control-service");
    const policy = require(root + "/src/services/collector-retry-policy");
    const planner = require(root + "/src/services/creator-analytics-sync-orchestrator");
    const s = await scope(db, { agencyId: "upgrade-agency", creatorId: "upgrade-creator", userId: "upgrade-user" });
    const now = new Date(), past = new Date(+now - 86400000), future = new Date(+now + 86400000);
    const streams = [
      ["FINANCIAL", "financial_transactions_scan", "creatorFinancialCollectionState"],
      ["CAMPAIGNS", "fetch_campaigns", "creatorCampaignCollectionState"],
      ["NOTIFICATIONS", "catchup_notifications_scan", "creatorNotificationSyncState"],
    ];
    for (const [type, jobKey, model] of streams) {
      const id = "old-" + type.toLowerCase();
      const params = control.stampCollectionAuthorityParams(control.buildCollectionCommand({ collectorType: type, collectionMode: "full", now: past }), past);
      await runRootCommit(db, async ({ tx }) => {
        await tx.jobInstance.create({ data: { id, ...s, userId: undefined, jobKey, scope: "creator", status: "FAILED",
          attempts: 5, params, lastError: "lease expired", completedAt: past, nextRunAt: past } });
        await control.withCollectorStateLock({ db: tx, creatorId: s.creatorId, type, work: locked => locked[model].create({ data: {
          agencyId: s.agencyId, creatorId: s.creatorId, status: "FAILED", activeGeneration: params.collectionGeneration,
          activeRequestedAt: past, sourceJobId: id, retryAfterAt: past, lastErrorMessage: "lease expired",
        } }) });
      });
    }
    for (const retryAfterAt of [past, future]) {
      for (const [, , model] of streams) await db[model].update({ where: { creatorId: s.creatorId }, data: { retryAfterAt } });
      const before = await db.jobInstance.findMany({ where: { creatorId: s.creatorId }, orderBy: { id: "asc" } });
      for (let restart = 0; restart < 3; restart++) {
        const result = await planner.ensureInitialCreatorAnalyticsSync({ db, ...s });
        assert.equal(result.stage, "partial"); assert.equal(result.created, false);
        assert.equal(result.blocked.length, 3); assert(result.blocked.every(row => row.reason === "failed_terminal"));
        assert.deepEqual(await db.jobInstance.findMany({ where: { creatorId: s.creatorId }, orderBy: { id: "asc" } }), before);
      }
    }
    cases.push("past and future 170 retry deadlines do not create generations or reset attempts across repeated initial planning");
    for (const [type, , model] of streams) {
      const state = await db[model].findUnique({ where: { creatorId: s.creatorId } });
      const original = await db.jobInstance.findUnique({ where: { id: state.sourceJobId } });
      await db.jobInstance.update({ where: { id: original.id }, data: { status: "SCHEDULED", attempts: 4 } });
      const result = await policy.recoverTerminalCollector({ db, type, state, ...s });
      assert.equal(result.active, true); assert.equal(result.recovered, false);
      const planning = await planner.ensureInitialCreatorAnalyticsSync({ db, ...s });
      assert.equal(planning.created, false);
      assert.equal(planning.blocked.find(row => row.stage === type.toLowerCase()).reason, "already_in_flight");
      const after = await db.jobInstance.findUnique({ where: { id: original.id } });
      assert.equal(after.attempts, 4); assert.deepEqual(after.params, original.params);
      assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId } }), 3);
      await db.jobInstance.update({ where: { id: original.id }, data: { status: "FAILED", attempts: 5 } });
    }
    cases.push("same source job active retry is retained for all three streams without new provider work or a replenished budget");
    const financial = await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: s.creatorId } });
    await db.jobInstance.delete({ where: { id: financial.sourceJobId } });
    const missing = await policy.recoverTerminalCollector({ db, type: "FINANCIAL", state: financial, ...s });
    assert.equal(missing.terminal, true);
    const result = await planner.ensureInitialCreatorAnalyticsSync({ db, ...s });
    assert.equal(result.created, false); assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId } }), 2);
    cases.push("retention of the old job does not erase durable source exhaustion or authorize a replacement");
    const { scheduleJobNow } = require(root + "/src/services/job-scheduler");
    let observedFutureBoundary = false;
    for (let turn = 0; turn < 4 && !observedFutureBoundary; turn++) {
      const planned = await runRootCommit(db, ({ tx }) => control.withCollectorStateLock({ db: tx, type: "FINANCIAL", creatorId: s.creatorId, work: async locked => {
        const [{ at }] = await locked.$queryRawUnsafe('SELECT clock_timestamp() AS at');
        return scheduleJobNow({ db: locked, agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "financial_transactions_scan",
          params: { ...control.buildCollectionCommand({ collectorType: "FINANCIAL", collectionMode: "full", reason: "MANUAL_BOUND_PROOF", now: at }),
            financialTraversalVersion: 2, endDate: new Date(Math.ceil(+at/1000)*1000).toISOString() },
          now: at, dedupeParams: { planningEpoch: "provider-bound-proof-" + turn } });
      } }));
      const stored = await db.jobInstance.findUnique({ where: { id: planned.job.id } });
      const bound = require(root + "/src/services/financial-receipt-authority").date(stored.params.endDate);
      assert.equal(+stored.nextRunAt, Math.max(+stored.scheduledAt, +bound));
      assert(+bound <= +stored.scheduledAt + 1000);
      if (+bound > +stored.scheduledAt) {
        observedFutureBoundary = true;
        assert.equal(await db.jobInstance.findFirst({ where: { id: stored.id, nextRunAt: { lte: stored.scheduledAt } } }), null);
      }
    }
    assert(observedFutureBoundary, "fixture must exercise the subsecond scheduling hold");
    cases.push("actual scheduler persists nextRunAt at the fixed provider second, never admitting its fractional future before the bound");
    console.log(JSON.stringify({ ok: true, nativePostgres: false, externalProviders: false, cases }, null, 2));
  } finally { await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
