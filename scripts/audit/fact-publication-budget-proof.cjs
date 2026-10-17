"use strict";
// Real current schema, triggers, fair DomainWork claims and commit kernel. Only
// discovery latency is injected; transaction and ownership deadlines stay real.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const alive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("FACT_PUBLICATION_BUDGET_PROOF_DEADLINE"); process.exit(2); }, 90000);
async function main() {
  const f = await fixture(), { db, root } = f;
  const result = { ok: false, runtime: "isolated PGlite + Prisma", nativePostgres: false, checks: [] };
  const pass = name => { result.checks.push(name); console.log("PASS", name); };
  try {
    const s = await scope(db), now = new Date();
    require.cache[require.resolve(path.join(root, "src/prisma"))] = { exports: db };
    const { runRootCommit } = require(path.join(root, "src/services/db-commit-kernel"));
    const publisher = require(path.join(root, "src/services/analytics-fact-publication-service"));
    const work = require(path.join(root, "src/services/domain-work-authority-service"));
    const commit = callback => runRootCommit(db, ({ tx }) => callback(tx));
    await commit(async tx => {
      // Model a retained creator whose adoption has not completed. Its normal
      // source triggers keep publishing new live facts throughout adoption.
      await tx.creatorAnalyticsPublicationState.update({ where: { creatorId: s.creatorId }, data: { initialized: false } });
      await tx.creatorTip.create({ data: { id: "budget-tip", agencyId: s.agencyId, creatorId: s.creatorId,
        eventFingerprint: "a".repeat(64), amountCents: 100, tippedAt: now } });
      await work.publishDomainWork({ db: tx, agencyId: s.agencyId, creatorId: s.creatorId, partitionKey: s.creatorId,
        workClass: publisher.ADOPTION_CLASS, objectType: "CreatorAccount", objectId: s.creatorId });
    });
    let slowDiscovery = true, delayedDiscoveries = 0;
    db.$use(async (params, next) => {
      const value = await next(params);
      if (slowDiscovery && params.action === "queryRaw" && JSON.stringify(params.args, (_, value) => typeof value === "bigint" ? String(value) : value).includes("MaintenanceLaneState")) {
        delayedDiscoveries++;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return value;
    });
    const read = () => publisher.readPublishedDays({ db, creatorId: s.creatorId,
      from: new Date(now.toISOString().slice(0, 10)), to: new Date(now.toISOString().slice(0, 10)) });
    for (let turn = 0; turn < publisher.TABLES.length; turn++) {
      if (turn) await commit(tx => tx.creatorTip.update({ where: { id: "budget-tip" }, data: { amountCents: 100 + turn } }));
      const report = await publisher.runSweep({ db, maxRuntimeMs: 1 });
      assert.equal(report.ok, true, JSON.stringify({ report,
        work: await db.domainWorkItem.findMany({ where: { creatorId: s.creatorId, workClass: { in: [publisher.WORK_CLASS, publisher.ADOPTION_CLASS] } },
          select: { workClass: true, state: true, lastError: true, progressCursor: true } }),
      }));
      assert.ok(report.processed >= 1, "preparation must not suppress all admitted publication");
      const published = await read();
      assert.equal(published.totals.tipsCents, 100 + turn);
      const adoption = await db.domainWorkItem.findFirst({ where: { creatorId: s.creatorId, workClass: publisher.ADOPTION_CLASS } });
      if (turn + 1 < publisher.TABLES.length) assert.equal(adoption.progressCursor.table, turn + 1);
      else assert.equal(adoption.state, "DONE");
    }
    assert.equal(delayedDiscoveries, publisher.TABLES.length);
    assert.equal((await read()).ready, true);
    pass("slow discovery still publishes each live tip revision and advances adoption to READY without double counting");
    slowDiscovery = false;
    await commit(tx => tx.creatorTip.update({ where: { id: "budget-tip" }, data: { amountCents: 200 } }));
    const claim = await work.claimDomainWorkBatch({ db, workClass: publisher.WORK_CLASS, limit: 1 });
    assert.equal(claim.items.length, 1);
    await assert.rejects(() => publisher.processPage({ db, item: claim.items[0], ownerToken: "wrong-owner" }),
      error => error.code === "ANALYTICS_FACT_CLAIM_LOST");
    assert.equal((await read()).totals.tipsCents, 107);
    assert.equal((await read()).ready, false);
    await publisher.processPage({ db, item: claim.items[0], ownerToken: claim.ownerToken });
    assert.equal((await read()).totals.tipsCents, 200);
    assert.equal((await read()).ready, true);
    pass("the first-unit guarantee never overrides SQL ownership: a lost owner leaves old money and pending freshness intact");
    result.ok = true;
  } finally {
    await f.close();
    const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || ".", "evidence/fact-publication-budget.json");
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(() => { clearInterval(alive); clearTimeout(deadline); });
