"use strict";
// Real Prisma interactive transactions over an isolated current-schema SQL
// fixture. Inject transport latency, not server query/lock time, to distinguish
// the root deadline from the retained short SQL execution limits.
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { fixture } = require("./analytics-traffic/fixture.cjs");
const admission = require("../../src/services/phase2-maintenance-admission-service");

async function main() {
  const f = await fixture(), { db } = f;
  let delayed = false, delayedQueries = 0;
  db.$use(async (params, next) => {
    if (delayed) { delayedQueries++; await delay(1600); }
    return next(params);
  });
  const select = () => admission.selectPhase2MaintenanceLanes({ db, laneNames: admission.MAINTENANCE_LANE_NAMES });
  const counts = () => db.$queryRawUnsafe('SELECT "laneName","ordinal","turnCount","lastAdmittedAt" FROM "MaintenanceAdmissionClassState" WHERE "generation"=$1 ORDER BY "ordinal"', admission.MAINTENANCE_ADMISSION_GENERATION);
  try {
    const before = await counts();
    assert(before.every(row => row.turnCount === 0n));
    delayed = true;
    const started = Date.now();
    let result;
    try { result = await select(); } finally { delayed = false; }
    const wallMs = Date.now() - started;
    assert.equal(result.ok, true);
    assert.deepEqual(result.selected, admission.MAINTENANCE_LANE_NAMES.slice(0, 5));
    assert.equal(delayedQueries, 3, "configuration, bounded catalog and claim are the whole admission unit");
    const after = await counts();
    assert.equal(after.reduce((sum, row) => sum + row.turnCount, 0n), 5n);
    console.log("PASS admission commits through 1.6s per SQL round trip", JSON.stringify({ wallMs, delayedQueries, admitted: result.selected.length }));

    const visited = new Set(result.selected);
    for (let turn = 1; turn < Math.ceil(admission.MAINTENANCE_LANE_NAMES.length / 5); turn++) {
      const next = await select();
      assert.equal(next.selected.length, 5);
      next.selected.forEach(name => visited.add(name));
    }
    assert.equal(visited.size, admission.MAINTENANCE_LANE_NAMES.length);
    const progress = await admission.readMaintenanceAdmissionProgress({ db });
    assert.equal(progress.minimumTurns, "1"); assert.equal(progress.spread, "1");
    console.log("PASS persisted least-turn fairness visits all maintenance lanes", JSON.stringify({ lanes: visited.size, spread: progress.spread }));

    await db.$executeRawUnsafe('DELETE FROM "MaintenanceAdmissionClassState" WHERE "generation"=$1 AND "laneName"=$2', admission.MAINTENANCE_ADMISSION_GENERATION, admission.MAINTENANCE_LANE_NAMES[0]);
    const invalidBefore = await counts();
    await assert.rejects(select(), { code: "MAINTENANCE_ADMISSION_SCHEMA_CATALOG_MISMATCH" });
    assert.deepEqual(await counts(), invalidBefore, "catalog failure cannot advance any remaining lane");
    console.log("PASS an invalid catalog fails closed without advancing a counter");
    console.log(JSON.stringify({ ok: true, cases: 3, productionAccessed: false, nativePostgres: false,
      limitations: ["PGlite single SQL session; native multi-replica contention not exercised", "Injected transport latency is not a measurement of the incident database"] }));
  } finally { await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
