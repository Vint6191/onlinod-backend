"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("PUBLICATION_PROOF_TIMEOUT"); process.exit(2); }, 90000);
async function main() {
  const f = await fixture(), { db, root } = f;
  const result = { ok: false, nativePostgres: false, cases: [] };
  try {
    const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT || path.join(root, "../desktop"));
    const { earningsHandler } = await import(pathToFileURL(path.join(desktop, "apps/desktop/dist/electron/main/services/backend-jobs/handlers/earnings-handler.js")));
    const s = await scope(db);
    require.cache[require.resolve(path.join(root, "src/prisma"))] = { exports: db };
    const kernel = require(path.join(root, "src/services/db-commit-kernel"));
    const lease = require(path.join(root, "src/services/job-lease-service"));
    const publisher = require(path.join(root, "src/services/analytics-publication-service"));
    await db.workerDevice.create({ data: { id: "qa-device", agencyId: s.agencyId, userId: s.userId, lastSeenAt: new Date() } });
    async function accept(id, from, days) {
      const at = new Date(), run = "run-" + id, token = "lease-" + id;
      const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);
      const job = await kernel.runRootCommit(db, ({ tx }) => tx.jobInstance.create({ data: {
        id, agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "fetch_earnings", scope: "creator", status: "CLAIMED",
        claimedByDeviceId: "qa-device", leaseTokenHash: crypto.createHash("sha256").update(token).digest("hex"), leaseRevision: 1,
        leaseMemberId: "member-" + s.agencyId, leaseAccessEpoch: 1, leaseUntil: new Date(+at + 600000),
        params: { analyticsContractVersion: 1, scanFrom: from, scanTo: to, sourceTimezone: "UTC", requestedAt: at.toISOString(),
          analyticsObservationStartedAt: at.toISOString(), scanGeneration: run, collectionReason: "LOCAL_ACCEPTANCE" },
      } }));
      const identity = { jobId: id, userId: s.userId, deviceId: "qa-device", leaseToken: token, leaseRevision: 1 };
      const reports = [];
      // Only the provider is synthetic. Current Desktop code produces the
      // actual amount proof, page identity and completion protocol.
      const collected = await earningsHandler.runChunk({ creatorId: s.creatorId, job, signal: new AbortController().signal,
        ofApi: { request: async () => ({ ok: true, status: 200, data: { total: { total: days,
          chartAmount: Array.from({ length: days }, (_, i) => ({ date: new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10), count: 1 })),
        } } }) }, reportAsync: report => reports.push(report), flushAsyncReports: async () => {},
      });
      assert.equal(collected.result.dailyComplete, true);
      assert.equal(collected.result.dailyCount, days);
      for (const report of reports) await lease.progressJob({ ...identity, ...report });
      return lease.completeJob({ ...identity, result: collected.result });
    }
    const first = await accept("quantum-history", "2025-01-01", 201);
    let slowPreparation = true;
    db.$use(async (params, next) => {
      const value = await next(params);
      if (slowPreparation && params.model === "AnalyticsPublication" && params.action === "findUnique") {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return value;
    });
    const one = await publisher.runAnalyticsPublicationSweep({ db, maxUnitsPerClaim: 1, maxRuntimeMs: 1 });
    slowPreparation = false;
    assert.equal(one.results[0].units, 1);
    assert.equal((await db.analyticsPublication.findUnique({ where: { id: first.publicationId } })).state, "PENDING");
    result.cases.push({ name: "An admitted publication advances one real fenced SQL unit even when preparation exceeds its soft slice", units: 1 });
    let units = 1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await db.analyticsPublication.findUnique({ where: { id: first.publicationId } });
      if (state.state !== "PENDING") break;
      await new Promise(resolve => setTimeout(resolve, 30));
      const sweep = await publisher.runAnalyticsPublicationSweep({ db });
      assert.equal(sweep.ok, true, JSON.stringify(sweep));
      for (const row of sweep.results) { assert(row.units <= 8); units += row.units; }
    }
    const firstPublication = await db.analyticsPublication.findUnique({ where: { id: first.publicationId } });
    assert.equal(firstPublication.state, "COMMITTED", JSON.stringify({ lastError: firstPublication.lastError, stage: firstPublication.stage, proof: firstPublication.proof }));
    assert(units >= 8);
    result.cases.push({ name: "201 days publish in bounded, fenced units and resume after a one-unit quantum", units });
    const today = new Date().toISOString().slice(0, 10), current = await accept("quantum-today", today, 1);
    const sweep = await publisher.runAnalyticsPublicationSweep({ db });
    assert.equal(sweep.ok, true, JSON.stringify(sweep));
    assert.equal((await db.analyticsPublication.findUnique({ where: { id: current.publicationId } })).state, "COMMITTED");
    const [row] = await require(path.join(root, "src/services/published-earnings-read-repository")).readPublishedEarningsDays({ db, creatorId: s.creatorId, from: new Date(today), to: new Date(today), now: new Date() });
    assert.equal(row.daily.totalCents, 100);
    assert(row.coverage.lastVerifiedAt);
    result.currentDay = row;
    const day = new Date(today), previousDay = new Date(+day - 86400000);
    result.home = await require(path.join(root, "src/services/home-read-repository")).readHomeTotals({ db, agencyId: s.agencyId,
      member: { id: "member-" + s.agencyId, userId: s.userId, agencyId: s.agencyId, accessEpoch: 1 },
      money: true, range: { startDay: day, endDay: day }, previous: { startDay: previousDay, endDay: previousDay }, now: new Date() });
    result.timezones = [];
    for (const zone of ['UTC', 'Etc/GMT-3', 'America/New_York']) {
      await db.$executeRawUnsafe("SELECT set_config('TimeZone',$1,false)", zone);
      const input = { db, agencyId: s.agencyId,
        member: { id: "member-" + s.agencyId, userId: s.userId, agencyId: s.agencyId, accessEpoch: 1 }, money: true,
        range: { startDay: day, endDay: day }, previous: { startDay: previousDay, endDay: previousDay }, now: new Date() };
      const totals = await require(path.join(root, "src/services/home-read-repository")).readHomeTotals(input);
      const page = await require(path.join(root, "src/services/home-read-repository")).readHomeCreatorPage(input);
      const restricted = await require(path.join(root, "src/services/home-read-repository")).readHomeCreatorPage({ ...input, money: false });
      const [published] = await require(path.join(root, "src/services/published-earnings-read-repository")).readPublishedEarningsDays({ db, creatorId: s.creatorId, from: day, to: day, now: new Date() });
      assert.equal(totals.totalCents, 100); assert.equal(totals.staleCreators, 0);
      assert.equal(page.creators[0].revenueCents, 100); assert.equal(page.creators[0].stale, false);
      assert.equal(restricted.creators[0].revenueCents, null);
      assert.equal(published.daily.totalCents, 100); assert(published.coverage.lastVerifiedAt);
      result.timezones.push({ zone, totalCents: totals.totalCents, staleCreators: totals.staleCreators });
    }
    result.cases.push({ name: "Current-day money is published within one admission with its observation proof", units: sweep.results[0].units });
    result.ok = true;
  } finally {
    await f.close();
    const out = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || ".", "evidence/publication-quantum.json");
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
