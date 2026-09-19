"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS,
  FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR,
  fanDataRefreshClaimAvailable,
} = require("./provider-capacity-authority-service");

function capacityDb({ activeGlobal, activeCreator }) {
  const locks = [];
  return {
    locks,
    $executeRawUnsafe: async (sql, key) => { locks.push({ sql: String(sql), key }); return 1; },
    $queryRawUnsafe: async (sql, creatorId) => {
      assert.match(String(sql), /fan_data_point_refresh/);
      assert.equal(creatorId, "creator-a");
      return [{ activeGlobal: BigInt(activeGlobal), activeCreator: BigInt(activeCreator) }];
    },
  };
}

test("fan-data refresh claim admission is globally bounded under one advisory lock", async () => {
  const db = capacityDb({ activeGlobal: FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS, activeCreator: 0 });
  const admission = await fanDataRefreshClaimAvailable(db, "creator-a");
  assert.equal(admission.available, false);
  assert.equal(admission.globalFull, true);
  assert.equal(admission.creatorFull, false);
  assert.equal(db.locks.length, 1);
  assert.equal(db.locks[0].key, "fan-data-refresh-claim-admission-v1");
});

test("fan-data refresh claim admission prevents one creator from occupying multiple active jobs", async () => {
  const db = capacityDb({ activeGlobal: Math.max(0, FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS - 1), activeCreator: FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR });
  const admission = await fanDataRefreshClaimAvailable(db, "creator-a");
  assert.equal(admission.available, false);
  assert.equal(admission.globalFull, false);
  assert.equal(admission.creatorFull, true);
});

test("fan-data refresh claim admission allows capacity below both bounds", async () => {
  const db = capacityDb({ activeGlobal: 0, activeCreator: 0 });
  const admission = await fanDataRefreshClaimAvailable(db, "creator-a");
  assert.equal(admission.available, true);
});

test("job claim source skips saturated fan refresh work without blocking other job classes", () => {
  const source = fs.readFileSync(path.join(__dirname, "job-lease-service.js"), "utf8");
  assert.match(source, /fanRefreshBlockedCreatorIds/);
  assert.match(source, /fanRefreshGlobalBlocked/);
  assert.match(source, /NOT:\s*\{\s*jobKey:\s*"fan_data_point_refresh"/);
  assert.match(source, /\["fetch_campaigns",\s*"fan_data_point_refresh"\]\.includes/);
  assert.match(source, /fanDataRefreshClaimAvailable\(db, candidate\.creatorId\)/);
});

test("physical OF gate source has one process-wide permit and creator round-robin, not per-creator clocks", () => {
  const source = fs.readFileSync(path.join(__dirname, "of-request-gate-service.js"), "utf8");
  assert.match(source, /const coordinator = \{/);
  assert.match(source, /single_backend_process_global_two_phase_creator_round_robin/);
  assert.match(source, /lastServedKey/);
  assert.doesNotMatch(source, /const lanes = new Map\(\)/);
  assert.doesNotMatch(source, /getLane\(/);
});
