"use strict";

// Runtime and deployment validate the same persisted catalog. Catalog changes
// are explicit forward migrations, never a self-upgrade by a running replica.
const { CLAIMABLE_DESKTOP_JOB_KEYS } = require("./job-catalog");
const ID = "of-global-capacity-v1";
const GENERATION = "phase6_capacity_observation_v2";
const EXPECTED_KEYS = Object.freeze([...CLAIMABLE_DESKTOP_JOB_KEYS].sort());
const fail = code => Object.assign(new Error(code), { code });

function assertCapacityProjectionCatalog(state) {
  if (!state) throw fail("CAPACITY_PROJECTION_STATE_MISSING");
  if (state.generation !== GENERATION) throw fail("CAPACITY_PROJECTION_GENERATION_MISMATCH");
  const stored = Array.isArray(state.jobKeys) ? [...state.jobKeys].sort() : [];
  if (JSON.stringify(stored) !== JSON.stringify(EXPECTED_KEYS)) {
    const error = fail("CAPACITY_PROJECTION_CATALOG_CHANGED");
    error.capacityCatalog = {
      event: "CAPACITY_PROJECTION_CATALOG_MISMATCH", generation: state.generation,
      expectedCount: EXPECTED_KEYS.length, storedCount: stored.length,
      missing: EXPECTED_KEYS.filter(key => !stored.includes(key)),
      unexpected: stored.filter(key => !EXPECTED_KEYS.includes(key)),
      duplicates: stored.filter((key, index) => index > 0 && key === stored[index - 1]),
    };
    throw error;
  }
  return { ready: true, generation: GENERATION, jobKeys: EXPECTED_KEYS.length };
}

module.exports = { ID, GENERATION, EXPECTED_KEYS, assertCapacityProjectionCatalog };
