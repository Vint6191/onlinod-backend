"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schedulerPath = require.resolve("./job-scheduler");
const originalScheduler = require.cache[schedulerPath];
let scheduled = [];
require.cache[schedulerPath] = {
  id: schedulerPath,
  filename: schedulerPath,
  loaded: true,
  exports: {
    ensureSingleJob: async (input) => {
      scheduled.push(input);
      return { created: true, job: { id: `job-${scheduled.length}` } };
    },
  },
};

const authority = require("./fan-data-authority-service");
const tokens = require("./fan-observation-token-service");

function ids(count, prefix = "fan") {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, "0")}`);
}

test.after(() => {
  if (originalScheduler) require.cache[schedulerPath] = originalScheduler;
  else delete require.cache[schedulerPath];
});

test("INT5.5C-3 point-refresh scheduler accepts exactly 500 and never truncates 501", async () => {
  scheduled = [];
  const exact = await authority.scheduleFanDataPointRefresh({
    agencyId: "agency-1",
    creatorId: "creator-1",
    onlyFansUserIds: ids(500),
  });
  assert.equal(exact.created, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].params.fanIds.length, 500);
  assert.equal(new Set(scheduled[0].params.fanIds).size, 500);

  await assert.rejects(
    () => authority.scheduleFanDataPointRefresh({
      agencyId: "agency-1",
      creatorId: "creator-1",
      onlyFansUserIds: ids(501, "overflow"),
    }),
    (error) => error?.code === "FAN_DATA_POINT_REFRESH_TOO_LARGE" && error?.status === 413,
  );
  assert.equal(scheduled.length, 1, "oversized request must fail before scheduler mutation");
});

test("INT5.5C-3 observation token scope fails closed above 500 instead of hashing a prefix", () => {
  assert.equal(tokens.normalizeSubjects(ids(500)).length, 500);
  assert.throws(
    () => tokens.normalizeSubjects(ids(501)),
    /FAN_OBSERVATION_TOKEN_SCOPE_TOO_LARGE/,
  );
  assert.throws(
    () => tokens.observationScopeHash({ purpose: "test", subjects: ids(501) }),
    /FAN_OBSERVATION_TOKEN_SCOPE_TOO_LARGE/,
  );
});

test("INT5.5C-3 HTTP current/refresh boundaries reject oversized single batches instead of slice-and-success", () => {
  const route = fs.readFileSync(path.join(__dirname, "..", "routes", "fan-data.js"), "utf8");
  const currentStart = route.indexOf('router.post("/current"');
  const observationStart = route.indexOf('router.post("/observations"');
  const refreshStart = route.indexOf('router.post("/refresh"');
  assert.ok(currentStart >= 0 && observationStart > currentStart && refreshStart > observationStart);
  const current = route.slice(currentStart, observationStart);
  const refresh = route.slice(refreshStart);
  assert.match(current, /FAN_DATA_CURRENT_REQUEST_TOO_LARGE/);
  assert.match(refresh, /FAN_DATA_REFRESH_REQUEST_TOO_LARGE/);
  assert.doesNotMatch(current, /slice\(0,\s*500\)/);
  assert.doesNotMatch(refresh, /slice\(0,\s*500\)/);
});
