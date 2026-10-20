"use strict";
// Current SQL, Prisma and the real publication worker. This proof uses synthetic
// canonical facts; it does not contact a provider or the application's database.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log("PASS", name); }
const keep = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("PUBLICATION_READINESS_PROOF_DEADLINE"); process.exit(2); }, 180000);
async function main() {
  const f = await fixture();
  const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || require("node:os").tmpdir());
  fs.mkdirSync(output, { recursive: true });
  const report = { nativePostgres: false, productionAccessed: false, externalProviders: false, engine: "PGlite + actual Prisma + fact publication worker", checks };
  try {
    const { db } = f, s = await scope(db);
    require.cache[require.resolve(path.join(f.root, "src/prisma"))] = { exports: db };
    const publication = require("../../src/services/analytics-fact-publication-service");
    const work = require("../../src/services/domain-work-authority-service");
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const read = (from = "2026-10-01", to = "2026-10-31") => publication.readPublishedDays({ db, creatorId: s.creatorId, from, to });
    const money = { id: "money-one", ...s, occurredAt: "2026-10-10T15:00:00.000Z", transactionType: "message", transactionStatus: "settled", amountCents: 1000, netCents: 800 };
    async function stage(kind, row, deleted = false) {
      await runRootCommit(db, ({ tx }) => tx.$executeRawUnsafe('SELECT "analytics_stage_fact_v1"($1,$2::jsonb,$3,FALSE)', kind, JSON.stringify(row), deleted));
    }
    async function publish() {
      await db.$executeRawUnsafe('UPDATE "DomainWorkItem" SET "availableAt"=\'2000-01-01\'::timestamp,"nextAttemptAt"=NULL WHERE "creatorId"=$1 AND "workClass"=$2 AND state=\'READY\'', s.creatorId, publication.WORK_CLASS);
      const claim = await work.claimDomainWorkBatch({ db, workClass: publication.WORK_CLASS, limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1 });
      assert.equal(claim.items.length, 1, JSON.stringify({ claim, rows: await db.domainWorkItem.findMany({ where: { creatorId: s.creatorId, workClass: publication.WORK_CLASS } }) }, (_key,value) => typeof value === "bigint" ? String(value) : value));
      const result = await publication.processPage({ db, item: claim.items[0], ownerToken: claim.ownerToken });
      assert.ok(result.processed > 0);
      return result;
    }
    await check("uninitialized publication cannot present empty totals as ready", async () => {
      await db.creatorAnalyticsPublicationState.update({ where: { creatorId: s.creatorId }, data: { initialized: false } });
      const result = await read();
      assert.equal(result.scopes.financial.ready, false);
      assert.equal(result.scopes.activity.state, "REBUILDING");
      await db.creatorAnalyticsPublicationState.update({ where: { creatorId: s.creatorId }, data: { initialized: true } });
    });
    await check("completed money remains available while a notification awaits publication", async () => {
      await stage("CreatorFinancialTransaction", money);
      assert.equal((await read()).scopes.financial.ready, false);
      await publish();
      await stage("CreatorPostLike", { id: "like-one", ...s, likedAt: "2026-10-10T17:00:00Z", fanId: "fan-one" });
      const result = await read();
      assert.equal(result.ready, false, "the previous all-facts gate would hide finance");
      assert.equal(result.scopes.financial.ready, true);
      assert.equal(result.scopes.activity.ready, false);
      assert.equal(result.financialGroups[0]._sum.netCents, 800);
      await publish();
      assert.equal((await read()).scopes.activity.ready, true);
    });
    await check("financial refunds remain unavailable until their previous contribution is removed", async () => {
      await stage("CreatorFinancialTransaction", { ...money, transactionStatus: "undo" });
      assert.equal((await read()).scopes.financial.ready, false);
      await publish();
      const result = await read();
      assert.equal(result.scopes.financial.ready, true);
      assert.equal(result.financialGroups.length, 1);
      assert.equal(result.financialGroups[0].transactionStatus, "undo");
      assert.equal(result.financialGroups[0]._sum.netCents, 800);
    });
    await check("moving a fact outside the selected dates still blocks its old range until subtraction", async () => {
      await stage("CreatorFinancialTransaction", { ...money, occurredAt: "2025-01-01T00:00:00Z" });
      assert.equal((await read()).scopes.financial.ready, false);
      assert.equal((await read("2025-01-01", "2025-01-01")).scopes.financial.ready, false);
      await publish();
      const result = await read();
      assert.equal(result.scopes.financial.ready, true);
      assert.deepEqual(result.financialGroups, []);
      assert.equal((await read("2025-01-01", "2025-01-01")).financialGroups[0]._sum.netCents, 800);
    });
    await check("a deletion blocks its previously published range; other dates remain ready", async () => {
      await stage("CreatorFinancialTransaction", money, true);
      assert.equal((await read()).scopes.financial.ready, true);
      assert.equal((await read("2025-01-01", "2025-01-01")).scopes.financial.ready, false);
      await publish();
      assert.equal((await read("2025-01-01", "2025-01-01")).scopes.financial.ready, true);
      assert.equal(await db.creatorAnalyticsFactPublication.count({ where: { creatorId: s.creatorId, factId: money.id } }), 0);
    });
    await check("20,000 unrelated historical rows do not block current finance and use bounded date indexes", async () => {
      await db.$executeRawUnsafe(`INSERT INTO "CreatorAnalyticsFactPublication"("agencyId","creatorId",kind,"factId","currentValue","publishedValue")
        SELECT $1,$2,'CreatorFinancialTransaction','historical-'||i,
          jsonb_build_object('occurredAt','2025-02-01T00:00:00Z','transactionType','tip','transactionStatus','settled','netCents',80,'amountCents',100),
          jsonb_build_object('occurredAt','2025-01-01T00:00:00Z','transactionType','tip','transactionStatus','settled','netCents',40,'amountCents',50)
        FROM generate_series(1,20000) i`, s.agencyId, s.creatorId);
      await db.$executeRawUnsafe('ANALYZE "CreatorAnalyticsFactPublication"');
      assert.equal((await read()).scopes.financial.ready, true);
      report.plans = {};
      for (const column of ["currentValue", "publishedValue"]) for (const present of [false, true]) {
        const day = present ? column === "currentValue" ? "2025-02-01" : "2025-01-01" : "2026-10-01";
        const query = `SELECT 1 FROM "CreatorAnalyticsFactPublication" f WHERE f."creatorId"=$1 AND f.dirty
          AND f.kind=ANY($2::text[]) AND ${publication.factDayExpression(column)}>=$3::text
          AND ${publication.factDayExpression(column)}<=$3::text LIMIT 1`;
        const plan = await db.$queryRawUnsafe("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + query, s.creatorId, ["CreatorFinancialTransaction"], day);
        const text = JSON.stringify(plan);
        assert.match(text, new RegExp("AnalyticsFactPublication_dirty_" + (column === "currentValue" ? "current" : "published") + "_day_idx"));
        assert.doesNotMatch(text, /Seq Scan/);
        report.plans[column + (present ? "Present" : "Absent")] = plan;
      }
      // Also explain the complete production read: correlated family probes
      // must retain the same bounded plan when composed with day aggregates.
      for (const from of ["2026-10-01", "2025-01-01"]) {
        let statement;
        await publication.readPublishedDays({ creatorId: s.creatorId, from, to: from,
          db: { $queryRawUnsafe: async (...args) => { statement = args; return db.$queryRawUnsafe(...args); } } });
        const plan = await db.$queryRawUnsafe("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + statement[0], ...statement.slice(1));
        const scans = [];
        function inspect(value) {
          if (!value || typeof value !== "object") return;
          if (value["Relation Name"] === "CreatorAnalyticsFactPublication") scans.push(value);
          for (const child of Object.values(value)) inspect(child);
        }
        inspect(plan);
        assert.equal(scans.length, 2);
        for (const scan of scans) {
          assert.match(scan["Node Type"], /^Index(?: Only)? Scan$/);
          assert.match(scan["Index Name"], /^AnalyticsFactPublication_dirty_(?:current|published)_day_idx$/);
          assert.ok(scan["Actual Rows"] <= 1, JSON.stringify(scan));
        }
        report.plans["completeRead:" + from] = plan;
      }
    });
    const contract = require("../../src/services/database-contract.json");
    report.indexes = (await db.$queryRawUnsafe(contract.queries.indexes)).filter(row => row.name.startsWith("AnalyticsFactPublication_dirty_") && row.name.endsWith("_day_idx"));
    assert.equal(report.indexes.length, 2);
    report.ok = true;
  } finally {
    fs.writeFileSync(path.join(output, "publication-readiness.json"), JSON.stringify(report, null, 2));
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keep); clearTimeout(deadline); });
