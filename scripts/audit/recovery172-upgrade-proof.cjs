"use strict";
// Upgrade the actual shipped v18 schema through the actual installer. This
// fixture never uses DATABASE_URL and cannot target an application database.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const { runRootCommit } = require("../../src/services/db-commit-kernel");
const root = path.resolve(__dirname, "../..");
const logs = fs.mkdtempSync(path.join(os.tmpdir(), "nod-172-upgrade-"));
function install(url, label) {
  return new Promise((resolve, reject) => {
    const file = path.join(logs, label + ".log"), fd = fs.openSync(file, "w");
    const env = { ...process.env, DATABASE_URL: url };
    delete env.DIRECT_URL; delete env.SHADOW_DATABASE_URL;
    const child = spawn(process.execPath, ["scripts/database/install-current.js"], { cwd: root, env, stdio: ["ignore", fd, fd] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.once("error", error => { clearTimeout(timer); fs.closeSync(fd); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer); fs.closeSync(fd);
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${label} failed: ${fs.readFileSync(file, "utf8")}`));
    });
  });
}
const keep = setInterval(() => {}, 1000);
(async () => {
  const runtime = await createScaleSqlRuntime({ beforeMigration: "20261023000100_financial_display_authority" });
  try {
    const { db } = runtime, own = await scope(db), at = new Date("2026-10-20T12:00:00.000Z");
    const commit = work => runRootCommit(db, async ({ tx }) => {
      await require("../../src/services/earnings-generation-service").lock(tx, own.creatorId);
      return work(tx);
    });
    await commit(async tx => {
      await tx.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGeneration"
        (id,"agencyId","creatorId","runId",state,phase,"fromAt","throughAt","snapshotAt","fullScan")
        VALUES('verified-v18',$1,$2,'verified-run-v18','ACTIVE','READY',$3,$3,$3,true)`, own.agencyId, own.creatorId, at);
      for (const [id, category, net, status] of [["paid", "messages", 800, "done"], ["pending", "tips", 200, "loading"], ["refunded", "posts", 300, "undo"]]) {
        await tx.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGenerationEntry"
          (generation,"transactionId","occurredAt",category,"netCents",status,"observedAt")
          VALUES('verified-v18',$1,$2,$3,$4,$5,$2)`, id, at, category, net, status);
      }
      await tx.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"
        ("creatorId","agencyId","fromAt","throughAt",generation,"activeGeneration")
        VALUES($1,$2,$3,$3,'verified-run-v18','verified-v18')`, own.creatorId, own.agencyId, at);
      await tx.$executeRawUnsafe(`UPDATE "MaintenanceAdmissionClassState" SET "turnCount"=1000000,"admissionSequence"=1000000
        WHERE generation='onlinod_maintenance_v1'`);
    });
    const oldReceipts = await db.$queryRawUnsafe('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name');
    await db.$disconnect();
    await install(runtime.url, "upgrade");
    const { readDatabaseContract } = require("../../src/services/database-contract-service");
    assert.equal((await readDatabaseContract(db)).ready, true);
    const days = await db.$queryRawUnsafe('SELECT category,"netCents","financialMetrics" FROM "CreatorEarningsGenerationDay" WHERE generation=\'verified-v18\' ORDER BY category');
    assert.equal(days.reduce((sum, row) => sum + row.netCents, 0n), 1000n);
    assert.equal(days.find(row => row.category === "messages").financialMetrics.done_count, 1);
    assert.equal(days.find(row => row.category === "messages").financialMetrics.done_net, 800);
    assert.equal(days.find(row => row.category === "messages").financialMetrics.done_grossKnown, 0);
    assert.equal(days.find(row => row.category === "posts").financialMetrics.undo_net, 300);
    assert.equal((await db.$queryRawUnsafe('SELECT "activeGeneration" FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1', own.creatorId))[0].activeGeneration, "verified-v18");
    console.log("PASS actual v18 installer upgrade preserves published money and pointer; existing status metrics backfill without invented gross");

    const expectedCount = require("../../src/services/database-migration-chain").migrations.length;
    await db.$disconnect(); await install(runtime.url, "repeat");
    const receipts = await db.$queryRawUnsafe('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name');
    assert.equal(receipts.length, expectedCount);
    assert.equal(new Set(receipts.map(row => row.migration_name)).size, expectedCount);
    assert.deepEqual(receipts.slice(0, oldReceipts.length), oldReceipts);
    assert.equal(await db.creatorAccount.count({ where: { agencyId: own.agencyId } }), 1);
    console.log("PASS repeated installer preserves data and every previous migration checksum without duplicate receipts");

    const maintenance = require("../../src/services/phase2-maintenance-admission-service");
    const names = maintenance.MAINTENANCE_LANE_NAMES, seen = new Set();
    for (let tick = 0; tick < Math.ceil(names.length / 5) + 1; tick++) {
      const turn = await maintenance.selectPhase2MaintenanceLanes({ db, laneNames: names });
      assert.ok(turn.selected.length <= 5);
      turn.selected.forEach(name => seen.add(name));
    }
    assert.equal(seen.size, names.length);
    assert.ok(seen.has("mediaFinancialProjection"));
    const ready = await require("../../src/services/maintenance-runtime-contract").verifyMaintenanceRuntime({ db });
    assert.equal(ready.ready, true); assert.equal(ready.handlers, ready.catalog);
    console.log("PASS added media lane and all old lanes get bounded admission despite a million historical turns; runtime handlers and catalog agree");

    const change = tx => tx.$executeRawUnsafe(`UPDATE "CreatorEarningsGenerationEntry" SET status='undo',category='tips',"netCents"=400,"grossCents"=500
      WHERE generation='verified-v18' AND "transactionId"='paid'`);
    await assert.rejects(commit(async tx => { await change(tx); throw Error("ROLLBACK_METRICS"); }), /ROLLBACK_METRICS/);
    assert.deepEqual(await db.$queryRawUnsafe('SELECT category,"netCents","financialMetrics" FROM "CreatorEarningsGenerationDay" WHERE generation=\'verified-v18\' ORDER BY category'), days);
    await commit(change);
    const updated = await db.$queryRawUnsafe('SELECT category,"netCents","financialMetrics" FROM "CreatorEarningsGenerationDay" WHERE generation=\'verified-v18\' ORDER BY category');
    assert.equal(updated.reduce((sum, row) => sum + row.netCents, 0n), 200n);
    assert.equal(updated.find(row => row.category === "messages").financialMetrics.done_count, 0);
    assert.equal(updated.find(row => row.category === "tips").financialMetrics.undo_count, 1);
    assert.equal(updated.find(row => row.category === "tips").financialMetrics.undo_gross, 500);
    await commit(change);
    assert.deepEqual(await db.$queryRawUnsafe('SELECT category,"netCents","financialMetrics" FROM "CreatorEarningsGenerationDay" WHERE generation=\'verified-v18\' ORDER BY category'), updated);
    await db.$disconnect(); assert.equal((await readDatabaseContract(db)).ready, true);
    console.log("PASS financial status/category corrections are atomic, exactly once, and survive a new connection");
    console.log(JSON.stringify({ ok: true, nativePostgres: runtime.native === true, providerAccessed: false, upgradedFrom: "v18", migrations: expectedCount }));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));
