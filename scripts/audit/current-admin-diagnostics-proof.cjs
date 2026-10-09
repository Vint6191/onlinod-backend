"use strict";
// Current business SQL through real Prisma, in a disposable database only.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createAdminSqlRuntime } = require("../test-support/admin-sql-runtime.cjs");

async function main() {
  const f = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME || process.env.PHASE4_PROOF_RUNTIME });
  const { db } = f, diag = require("../../src/services/admin-diagnostics-service");
  const writers = require("../../src/services/database-write-contract-service");
  const report = { ok: false, nativePostgres: false, productionAccessed: false, engine: "PGlite + real Prisma5.22", cases: [] };
  const check = async (name, work) => { await work(); report.cases.push({ name, ok: true }); console.log("PASS", name); };
  const due = () => db.$executeRawUnsafe(`UPDATE "SystemSetting" SET "value"=jsonb_set("value",'{nextAt}','"2000-01-01T00:00:00Z"') WHERE "key"=$1`, diag.KEY);
  const state = async () => (await db.systemSetting.findUnique({ where: { key: diag.KEY } }))?.value;
  try {
    await check("empty current database completes a full diagnostic pass without retired CRM tables", async () => {
      assert.equal((await diag.readDiagnostics({ db })).coverage.status, "BUILDING");
      assert.equal((await diag.diagnosticsStep({ db })).complete, false);
      await due(); assert.equal((await diag.diagnosticsStep({ db })).complete, true);
      const result = await diag.readDiagnostics({ db });
      assert.equal(result.coverage.status, "AVAILABLE"); assert.ok(result.anomalies.every(row => row.count === 0));
      assert.deepEqual(result.coverage.sources, ["AutomationDelivery", "AutomationBumpFanState"]);
      assert.equal(result.coverage.excluded[0].source, "CRM");
    });
    await db.$transaction(async tx => {
      await writers.assertTeamControlPlaneWriteAdmission(tx);
      await tx.user.create({ data: { id: "diag-owner", email: "diag-owner@example.test", passwordHash: "proof" } });
      await tx.agency.create({ data: { id: "diag-agency", name: "Diagnostics proof" } });
      await tx.agencyMember.create({ data: { agencyId: "diag-agency", userId: "diag-owner", role: "OWNER", roleKey: "owner" } });
      await writers.authorizeCreatorAccountWrite(tx);
      for (const id of ["diag-creator", "diag-other", "running-creator", "committing-creator", "reconcile-send-creator", "reconcile-delete-creator"]) await tx.creatorAccount.create({ data: { id, agencyId: "diag-agency", displayName: id } });
    });
    await db.$executeRawUnsafe(`INSERT INTO "AutomationDelivery" ("id","agencyId","creatorId","actionType","status","messageId","updatedAt")
      SELECT 'history-'||lpad(n::text,6,'0'),'diag-agency','diag-creator','SEND_MESSAGE','COMPLETED',CASE WHEN n<=4 THEN 'duplicate' ELSE 'provider-'||n END,now() FROM generate_series(1,20000) n`);
    const edge = [
      ["pair-send", "SEND_MESSAGE", "COMPLETED", "paired", "diag-creator"],
      ["pair-delete", "DELETE_MESSAGE", "COMPLETED", "paired", "diag-creator"],
      ["other-creator", "SEND_MESSAGE", "COMPLETED", "duplicate", "diag-other"],
      ["missing-completed", "SEND_MESSAGE", "COMPLETED", null, "diag-creator"],
      ["missing-queued", "SEND_MESSAGE", "QUEUED", null, "diag-creator"],
      ["missing-running", "SEND_MESSAGE", "RUNNING", null, "running-creator"],
      ["missing-committing", "SEND_MESSAGE", "COMMITTING", null, "committing-creator"],
      ["missing-delete", "DELETE_MESSAGE", "COMPLETED", null, "diag-creator"],
      ["missing-mass", "MASS_QUEUE_CREATE", "COMPLETED", null, "diag-creator"],
      ["unknown-send", "SEND_MESSAGE", "RECONCILE_REQUIRED", null, "reconcile-send-creator"],
      ["unknown-delete", "DELETE_MESSAGE", "RECONCILE_REQUIRED", "unknown", "reconcile-delete-creator"],
    ];
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase3_fan_consumer_generation','phase3_fan_consumer_v1_current_bounded',true)");
      for (const [id, actionType, status, messageId, creatorId] of edge) await tx.automationDelivery.create({ data: { id, agencyId: "diag-agency", creatorId, actionType, status, messageId } });
    });
    const now = (await db.$queryRawUnsafe("SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now"))[0].now;
    for (const [id, pendingMessageId, days] of [["overdue", "old", -4], ["recent", "recent", -1], ["future", "future", 10], ["resolved", null, -4]]) {
      await db.automationBumpFanState.create({ data: { id, agencyId: "diag-agency", creatorId: "diag-creator", fanId: id,
        pendingMessageId, pendingCancelAt: new Date(now.getTime() + days * 86400000) } });
    }
    const legacy = { run: { lane: 1, cursor: "old-crm", upper: "z", scanned: 123, counts: { delivery_clones: 999 } },
      nextAt: "2099-01-01T00:00:00Z", completed: { completedAt: now.toISOString(), counts: { delivery_clones: 999, untagged_profiles: 777 } } };
    await db.systemSetting.update({ where: { key: diag.KEY }, data: { value: legacy } });
    await check("old stuck cursor and cached CRM counts are rebuilt instead of resumed or published", async () => {
      const before = await diag.readDiagnostics({ db });
      assert.equal(before.coverage.status, "BUILDING"); assert.ok(before.anomalies.every(row => row.count === null));
      const step = await diag.diagnosticsStep({ db }); assert.equal(step.processed, 500);
      const stored = await state(); assert.equal(stored.generation, diag.GENERATION); assert.equal(stored.run.lane, 0);
      assert.equal(stored.completed, undefined); assert.equal(stored.run.scanned, 500);
    });
    await check("a repeated not-due step neither advances the cursor nor doubles counters", async () => {
      const before = await state(); assert.equal((await diag.diagnosticsStep({ db })).skipped, "not_due"); assert.deepEqual(await state(), before);
    });
    await check("checkpoint failure rolls back counts and the next attempt resumes the same page", async () => {
      await due(); const before = await state();
      const failed = { $transaction: (work, options) => db.$transaction(tx => work(new Proxy(tx, { get(target, key) {
        if (key === "$executeRawUnsafe") return async (sql, ...args) => { if (sql.startsWith('UPDATE "SystemSetting"')) throw Error("diagnostic checkpoint fault"); return target.$executeRawUnsafe(sql, ...args); };
        const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
      } })), options) };
      await assert.rejects(diag.diagnosticsStep({ db: failed }), /diagnostic checkpoint fault/);
      assert.deepEqual(await state(), before); assert.equal((await diag.diagnosticsStep({ db })).processed, 500);
    });
    await check("all pages classify current sends, delete companions, unknown writes and pending bumps correctly", async () => {
      let step; for (let n = 0; n < 50; n++) { await due(); step = await diag.diagnosticsStep({ db }); assert.ok(step.processed <= 500); if (step.complete) break; }
      assert.ok(step.complete); const result = await diag.readDiagnostics({ db });
      assert.equal(result.coverage.status, "AVAILABLE"); assert.equal(result.coverage.scannedRows, 20000 + edge.length + 4);
      assert.deepEqual(Object.fromEntries(result.anomalies.map(row => [row.key, row.count])), {
        delivery_clones: 4, stuck_bumps: 1, deliveries_no_messageid: 1, reconcile_required: 2,
      });
      assert.deepEqual(result.anomalies[0].sample.map(row => row.id), ["history-000001", "history-000002", "history-000003", "history-000004"]);
    });
    await check("diagnostic read uses one cache query and never rescans the history", async () => {
      let reads = 0;
      await diag.readDiagnostics({ db: { $queryRawUnsafe: (sql, ...args) => { reads++; assert.match(sql, /FROM "SystemSetting"/); return db.$queryRawUnsafe(sql, ...args); } } });
      assert.equal(reads, 1);
    });
    await check("last completed results remain visible while the next bounded pass is building", async () => {
      await due(); await diag.diagnosticsStep({ db }); const result = await diag.readDiagnostics({ db });
      assert.equal(result.coverage.rebuilding, true); assert.equal(result.coverage.progressRows, 500); assert.equal(result.anomalies[0].count, 4);
    });
    await check("a damaged current cursor restarts its derived scan and keeps the last valid completed result", async () => {
      const broken = await state(); broken.run.lane = 99; broken.nextAt = "2099-01-01T00:00:00Z";
      await db.systemSetting.update({ where: { key: diag.KEY }, data: { value: broken } });
      assert.equal((await diag.diagnosticsStep({ db })).processed, 500);
      assert.equal((await state()).run.lane, 0); assert.equal((await diag.readDiagnostics({ db })).anomalies[0].count, 4);
    });
    await check("large delivery pages use the existing identity index and bounded duplicate probes", async () => {
      await db.$executeRawUnsafe('ANALYZE "AutomationDelivery"');
      const plan = await db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan=off");
        return tx.$queryRawUnsafe("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + diag.DELIVERY_PAGE_SQL, "", "history-020000", 500);
      });
      const nodes = []; const walk = item => { if (!item || typeof item !== "object") return; if (item["Node Type"]) nodes.push(item); for (const value of Object.values(item)) Array.isArray(value) ? value.forEach(walk) : walk(value); }; walk(plan);
      assert.ok(nodes.some(node => node["Index Name"] === "AutomationDelivery_creatorId_messageId_idx"));
      assert.ok(!nodes.some(node => node["Relation Name"] === "AutomationDelivery" && node["Node Type"] === "Seq Scan"));
      const rows = await db.$queryRawUnsafe(diag.DELIVERY_PAGE_SQL, "", "history-020000", 500); assert.equal(rows.length, 500);
      report.deliveryPlan = plan;
    });
    await check("reconnection preserves the derived cursor and completed observation", async () => {
      const before = await state(); await db.$disconnect(); assert.deepEqual(await state(), before);
      assert.equal((await diag.readDiagnostics({ db })).coverage.status, "AVAILABLE");
    });
    report.ok = true;
  } catch (error) { report.error = { message: error.message, code: error.code, stack: error.stack }; throw error; }
  finally {
    if (process.env.ONLINOD_SQL_PROOF_OUTPUT) {
      const dir = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT, "evidence"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "current-admin-diagnostics-proof.json"), JSON.stringify(report, null, 2) + "\n");
    }
    await f.close();
  }
  return report;
}
module.exports = { main };
if (require.main === module) {
  const keep = setInterval(() => {}, 1000);
  main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));
}
