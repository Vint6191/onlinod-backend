"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { GENERATION, EXPECTED_KEYS, assertCapacityProjectionCatalog } = require("./provider-capacity-catalog-contract");
const { verifyCapacityCatalog } = require("../../scripts/database/provider-capacity-catalog-postflight");

test("capacity deployment and runtime use the same exact catalog; array order is irrelevant", async () => {
  const state = { generation: GENERATION, jobKeys: [...EXPECTED_KEYS].reverse() };
  assert.equal(assertCapacityProjectionCatalog(state).ready, true);
  let reads = 0;
  const db = { $queryRawUnsafe: async (sql, id) => {
    reads++; assert.match(sql, /^SELECT/); assert.equal(id, "of-global-capacity-v1"); return [state];
  } };
  assert.equal((await verifyCapacityCatalog(db)).jobKeys, 11); assert.equal(reads, 1);
});

test("actual103 persisted retired key fails postflight with an actionable diff", async () => {
  const state = { generation: GENERATION, jobKeys: [...EXPECTED_KEYS, "traffic_sources_scan"] };
  await assert.rejects(verifyCapacityCatalog({ $queryRawUnsafe: async () => [state] }), error => {
    assert.equal(error.code, "CAPACITY_PROJECTION_CATALOG_CHANGED");
    assert.deepEqual(error.capacityCatalog.unexpected, ["traffic_sources_scan"]);
    assert.deepEqual(error.capacityCatalog.missing, []); return true;
  });
});

test("unknown, missing and duplicate keys need an explicit migration; replicas cannot auto-rewrite", () => {
  for (const jobKeys of [[...EXPECTED_KEYS, "future_job"], EXPECTED_KEYS.slice(1), [...EXPECTED_KEYS, EXPECTED_KEYS[0]], null]) {
    const state = { generation: GENERATION, jobKeys }, before = structuredClone(state);
    assert.throws(() => assertCapacityProjectionCatalog(state), { code: "CAPACITY_PROJECTION_CATALOG_CHANGED" });
    assert.deepEqual(state, before);
  }
  assert.throws(() => assertCapacityProjectionCatalog(null), { code: "CAPACITY_PROJECTION_STATE_MISSING" });
  assert.throws(() => assertCapacityProjectionCatalog({ generation: "future" }), { code: "CAPACITY_PROJECTION_GENERATION_MISMATCH" });
});
