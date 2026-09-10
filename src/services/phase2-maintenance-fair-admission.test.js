"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectPhase2MaintenanceLanes } = require("./phase2-maintenance-admission-service");

const lanes = ["provider","fanout","reminder","dirty","confirmed","inbound","external","money","pending","legacy"];

test("R6 cross-lane admission has a fixed per-tick budget and rotates without a permanent head lane", () => {
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  const first = selectPhase2MaintenanceLanes({ laneNames: lanes, now: t0, intervalMs: 5000, lanesPerTick: 5 });
  const second = selectPhase2MaintenanceLanes({ laneNames: lanes, now: new Date(t0.getTime()+5000), intervalMs: 5000, lanesPerTick: 5 });
  assert.equal(first.selected.length, 5);
  assert.equal(second.selected.length, 5);
  const union = new Set([...first.selected, ...second.selected]);
  assert.equal(union.size, 10, "with ten lanes and quantum five, two consecutive rounds admit every lane once");
  assert.equal(first.totalLanes, 10);
  assert.equal(first.generation, "phase2_fair_admission_v1");
});

test("R6 admission wraps deterministically and never duplicates a lane within one tick", () => {
  const seven = lanes.slice(0, 7);
  const r = selectPhase2MaintenanceLanes({ laneNames: seven, now: new Date(5_000), intervalMs: 5000, lanesPerTick: 5 });
  assert.equal(r.startIndex, 5);
  assert.deepEqual(r.selected, ["inbound","external","provider","fanout","reminder"]);
  assert.equal(new Set(r.selected).size, r.selected.length);
});
