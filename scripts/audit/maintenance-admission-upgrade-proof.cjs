"use strict";
// Real current installer + SQL. The incident starts with an evolved catalog:
// old lanes have thousands of historical offers, newly appended lanes have zero.
// An all-zero clean fixture cannot reproduce this starvation.
process.env.TZ = "UTC";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const root = path.resolve(__dirname, "../..");
const migration = "20261020010000_maintenance_admission_sequence";
const admission = require("../../src/services/phase2-maintenance-admission-service");
const lanes = admission.MAINTENANCE_LANE_NAMES, generation = admission.MAINTENANCE_ADMISSION_GENERATION;
const { runRootCommit } = require("../../src/services/db-commit-kernel");
const checks = [];
function pass(name, details = {}) { checks.push({ name, ...details }); console.log("PASS", name, JSON.stringify(details)); }
function child(script, url) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, ["-e", script], { cwd: root,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    processHandle.stdout.on("data", chunk => { output += chunk; });
    processHandle.stderr.on("data", chunk => { errors += chunk; });
    const timer = setTimeout(() => processHandle.kill("SIGTERM"), 90000);
    processHandle.once("error", error => { clearTimeout(timer); reject(error); });
    processHandle.once("exit", code => { clearTimeout(timer);
      code === 0 ? resolve(output) : reject(new Error(`${output}\n${errors}`.trim() || `proof child exit ${code}`)); });
  });
}
const install = url => child(`const x=require('./scripts/database/install-current');x.main([]).catch(e=>{x.reportFailure(e);process.exitCode=1})`, url);
const workerScript = `const {PrismaClient}=require('@prisma/client'),a=require('./src/services/phase2-maintenance-admission-service');
 const db=new PrismaClient();a.selectPhase2MaintenanceLanes({db,laneNames:a.MAINTENANCE_LANE_NAMES})
 .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());`;

async function main() {
  const runtime = await createScaleSqlRuntime({ beforeMigration: migration });
  const { db } = runtime;
  async function releaseConnection() { await db.$disconnect(); if (runtime.waitForIdle) await runtime.waitForIdle(); }
  async function installCurrent() { await releaseConnection(); return install(runtime.url); }
  async function worker() { await releaseConnection(); return JSON.parse(await child(workerScript, runtime.url)); }
  const readCounts = () => db.$queryRawUnsafe(`SELECT "laneName",ordinal,"turnCount","lastAdmittedAt"
    FROM "MaintenanceAdmissionClassState" WHERE generation=$1 ORDER BY ordinal`, generation);
  const readAll = () => db.$queryRawUnsafe(`SELECT * FROM "MaintenanceAdmissionClassState" WHERE generation=$1 ORDER BY ordinal`, generation);
  const select = () => admission.selectPhase2MaintenanceLanes({ db, laneNames: lanes });
  try {
    await db.$executeRawUnsafe(`UPDATE "MaintenanceAdmissionClassState" SET
      "turnCount"=CASE WHEN ordinal<28 THEN 3582 ELSE 0 END,
      "lastAdmittedAt"=CASE WHEN ordinal<28 THEN '2026-10-16 17:49:00.770'::timestamp ELSE NULL END
      WHERE generation=$1`, generation);
    // This is the former admission SQL, retained here solely as the regression
    // witness. It never runs against application databases or the fixed runtime.
    const oldSelect = () => db.$queryRawUnsafe(`WITH candidates AS MATERIALIZED (
      SELECT generation,"laneName",ordinal,"turnCount" FROM "MaintenanceAdmissionClassState"
      WHERE generation=$1 ORDER BY "turnCount",ordinal LIMIT 5 FOR UPDATE SKIP LOCKED
    ), advanced AS (
      UPDATE "MaintenanceAdmissionClassState" s SET "turnCount"=s."turnCount"+1,"lastAdmittedAt"=clock_timestamp()
      FROM candidates c WHERE s.generation=c.generation AND s."laneName"=c."laneName"
      RETURNING s."laneName",c.ordinal
    ) SELECT * FROM advanced ORDER BY ordinal`, generation);
    const oldSeen = new Set();
    for (let i = 0; i < 100; i++) (await oldSelect()).forEach(row => oldSeen.add(row.laneName));
    assert.deepEqual([...oldSeen].sort(), lanes.slice(28).sort());
    assert((await readCounts()).filter(row => row.ordinal < 28).every(row => row.turnCount === 3582n));
    pass("former admission reproduces the incident: 100 ticks offer only the ten new lanes", {
      oldLanesStarved: 28, oldCount: 3582, theoreticalCatchupTicks: 7164,
    });

    const before = await readCounts();
    const receipts = await db.$queryRawUnsafe('SELECT id,checksum,migration_name,finished_at FROM "_prisma_migrations" ORDER BY migration_name');
    await installCurrent(); await installCurrent();
    assert.deepEqual(await readCounts(), before, "upgrade and rerun preserve lifetime counts and timestamps");
    assert((await readAll()).every(row => row.admissionSequence === 0n));
    const afterReceipts = await db.$queryRawUnsafe('SELECT id,checksum,migration_name,finished_at FROM "_prisma_migrations" ORDER BY migration_name');
    assert.deepEqual(afterReceipts.slice(0, receipts.length), receipts);
    assert.equal(afterReceipts.length, receipts.length + 1);
    assert.equal((await require("../../src/services/database-contract-service").readDatabaseContract(db)).ready, true);
    pass("actual additive installer initializes scheduling sequence without rewriting counters or prior receipts");

    const first = await worker();
    const second = await worker();
    assert.deepEqual(first.selected, lanes.slice(0, 5)); assert.deepEqual(second.selected, lanes.slice(5, 10));
    const seen = new Set([...first.selected, ...second.selected]);
    for (let i = 2; i < Math.ceil(lanes.length / 5); i++) (await select()).selected.forEach(name => seen.add(name));
    assert.equal(seen.size, lanes.length);
    for (const [i, row] of (await readCounts()).entries()) assert(row.turnCount > before[i].turnCount);
    pass("fresh worker processes share persisted order and all existing lanes run within eight batches", { lanes: seen.size });

    // Arbitrary skew in both lifetime counts and timestamps is harmless. The
    // timestamps model old/future DB clocks; no wall-clock advance is required.
    await db.$executeRawUnsafe(`UPDATE "MaintenanceAdmissionClassState" SET
      "admissionSequence"=CASE WHEN ordinal<28 THEN 9007199254740993 ELSE 0 END,
      "lastAdmittedAt"=CASE WHEN ordinal%2=0 THEN '2100-01-01'::timestamp ELSE '1970-01-01'::timestamp END
      WHERE generation=$1`, generation);
    const skewBefore = await readCounts(), countsAdded = new Map(lanes.map(name => [name, 0]));
    const skewSeen = new Set();
    for (let i = 0; i < Math.ceil(lanes.length / 5); i++) {
      const result = await select();
      assert.equal(result.policy, "bounded_fair_sequence");
      for (const turn of result.turns) {
        assert(BigInt(turn.admissionSequence) > 9007199254740993n);
        skewSeen.add(turn.name); countsAdded.set(turn.name, countsAdded.get(turn.name) + 1);
      }
    }
    assert.equal(skewSeen.size, lanes.length);
    for (const [i, row] of (await readCounts()).entries()) {
      assert.equal(row.turnCount, skewBefore[i].turnCount + BigInt(countsAdded.get(row.laneName)));
    }
    pass("new zero-sequence lanes, huge prior tickets and past/future clocks cannot starve any class");

    const campaignGeneration = "campaign_projection_execution_v2";
    const campaignRows = () => db.$queryRawUnsafe(`SELECT "laneName","turnCount","admissionSequence" FROM "MaintenanceAdmissionClassState"
      WHERE generation=$1 ORDER BY ordinal`, campaignGeneration);
    const maintenanceBeforeCampaign = await readAll();
    await db.$executeRawUnsafe(`UPDATE "MaintenanceAdmissionClassState" SET
      "turnCount"=CASE WHEN ordinal<4 THEN 1000000 ELSE 0 END,
      "admissionSequence"=CASE WHEN ordinal<4 THEN 9007199254740993 ELSE 0 END,
      "lastAdmittedAt"=CASE WHEN ordinal%2=0 THEN '2100-01-01'::timestamp ELSE '1970-01-01'::timestamp END
      WHERE generation=$1`, campaignGeneration);
    const campaignBefore = await campaignRows(), campaignSeen = new Set();
    for (let i = 0; i < campaignBefore.length; i++) {
      campaignSeen.add(await require("../../src/services/campaign-projection-policy").admitProjectionWorkClass(db));
    }
    assert.deepEqual([...campaignSeen].sort(), campaignBefore.map(row => row.laneName).sort());
    for (const [i, row] of (await campaignRows()).entries()) {
      assert.equal(row.turnCount, campaignBefore[i].turnCount + 1n);
      assert(row.admissionSequence > 9007199254740993n);
    }
    assert.deepEqual(await readAll(), maintenanceBeforeCampaign, "campaign admission is isolated from maintenance dispatch state");
    pass("campaign projection uses the same clock-independent fairness and preserves per-generation isolation");

    const rollbackBefore = await readAll();
    const failing = { $transaction: (work, options) => db.$transaction(async tx => {
      await work(tx); throw Error("CONTROLLED_ADMISSION_ROLLBACK");
    }, options) };
    await assert.rejects(admission.selectPhase2MaintenanceLanes({ db: failing, laneNames: lanes }), /CONTROLLED_ADMISSION_ROLLBACK/);
    assert.deepEqual(await readAll(), rollbackBefore);
    const beforeOffered = new Map(rollbackBefore.map(row => [row.laneName, row.turnCount]));
    const abandoned = await select(); const seenAfterAbandon = new Set();
    for (let i = 0; i < Math.ceil(lanes.length / 5); i++) (await select()).selected.forEach(name => seenAfterAbandon.add(name));
    assert(abandoned.selected.every(name => seenAfterAbandon.has(name)));
    assert((await readCounts()).every(row => row.turnCount > beforeOffered.get(row.laneName)));
    pass("rolled-back admission preserves order; an abandoned committed offer is revisited in one bounded round");

    const snapshot = await admission.readMaintenanceAdmissionProgress({ db });
    assert.equal(snapshot.policy, "bounded_fair_sequence"); assert.equal(snapshot.readOnly, true);
    assert.doesNotThrow(() => JSON.stringify(snapshot));
    await db.$executeRawUnsafe('DROP INDEX "MaintenanceAdmissionClassState_sequence_idx"');
    await db.$executeRawUnsafe('CREATE INDEX "MaintenanceAdmissionClassState_sequence_idx" ON "MaintenanceAdmissionClassState"(generation,"turnCount",ordinal)');
    try {
      assert.equal((await require("../../src/services/database-contract-service").readDatabaseContract(db)).ready, false);
      await assert.rejects(require("../../src/services/maintenance-runtime-contract").verifyMaintenanceRuntime({ db }), /MAINTENANCE_INDEX_INVALID/);
    } finally {
      await db.$executeRawUnsafe('DROP INDEX "MaintenanceAdmissionClassState_sequence_idx"');
      await db.$executeRawUnsafe('CREATE INDEX "MaintenanceAdmissionClassState_sequence_idx" ON "MaintenanceAdmissionClassState"(generation,"admissionSequence",ordinal)');
    }
    await runRootCommit(db, async ({ tx }) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan=off');
      const plan = await tx.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) SELECT "laneName" FROM "MaintenanceAdmissionClassState"
        WHERE generation=$1 ORDER BY "admissionSequence",ordinal LIMIT 5 FOR UPDATE SKIP LOCKED`, generation);
      assert.match(JSON.stringify(plan), /MaintenanceAdmissionClassState_sequence_idx/);
    });
    pass("readiness rejects a same-name wrong index; scheduling has an indexed bounded catalog path");

    if (runtime.native) {
      const { PrismaClient } = require("@prisma/client");
      const other = new PrismaClient({ datasources: { db: { url: runtime.url } } });
      try {
        let release, entered; const hold = new Promise(resolve => { release = resolve; });
        const ready = new Promise(resolve => { entered = resolve; }); let locked;
        const owner = other.$transaction(async tx => {
          locked = await tx.$queryRawUnsafe(`SELECT "laneName" FROM "MaintenanceAdmissionClassState"
            WHERE generation=$1 ORDER BY "admissionSequence",ordinal LIMIT 5 FOR UPDATE`, generation);
          entered(); await hold;
        }, { timeout: 15000 });
        try { await ready; const offered = await select();
          assert.equal(offered.selected.length, 5);
          assert(offered.selected.every(name => !locked.some(row => row.laneName === name)));
        } finally { release(); await owner; }
        pass("native concurrent owner locks are skipped without a singleton admission lock");
      } finally { await other.$disconnect(); }
    } else console.log("SKIP native multi-connection lock contention: local engine is serialized PGlite");
    console.log(JSON.stringify({ ok: true, checks, engine: runtime.native ? "native PostgreSQL" : "PGlite + real Prisma",
      externalProviders: false, nativeContentionExercised: runtime.native }, null, 2));
  } finally { await runtime.close(); }
}
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("MAINTENANCE_UPGRADE_PROOF_DEADLINE"); process.exit(2); }, 240000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); clearTimeout(deadline); });
