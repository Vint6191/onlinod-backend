"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  projectFanObservationBatch,
  FAN_DATA_OBSERVATION_BATCH_MAX,
} = require("./fan-data-authority-service");

const SRC = path.join(__dirname, "..");
function read(relative) { return fs.readFileSync(path.join(SRC, relative), "utf8"); }

test("INT5.5C-2 generic FanData boundary rejects oversized batches instead of silently truncating", async () => {
  let touched = false;
  const db = new Proxy({}, {
    get() {
      touched = true;
      throw new Error("DB must not be touched for an oversized batch");
    },
  });
  const items = Array.from({ length: FAN_DATA_OBSERVATION_BATCH_MAX + 1 }, (_, index) => ({
    onlyFansUserId: `fan-${index}`,
    identity: { source: "PRESENCE_HINT", activityObservedAt: "2026-09-17T10:00:00.000Z" },
  }));
  await assert.rejects(
    projectFanObservationBatch(db, {
      agencyId: "agency-1",
      creatorId: "creator-1",
      items,
      allowedSources: ["PRESENCE_HINT"],
      observedAtPolicy: "SERVER_RECEIPT",
      receivedAt: new Date("2026-09-17T10:00:01.000Z"),
    }),
    (error) => error?.code === "FAN_DATA_OBSERVATION_BATCH_TOO_LARGE" && error?.status === 413,
  );
  assert.equal(touched, false);
});

test("INT5.5C-2 presence ingest chunks all canonical activity observations at the authority boundary", () => {
  const bump = read("services/bump-service.js");
  const start = bump.indexOf("async function recordDetailedObservations");
  const end = bump.indexOf("\nasync function recordOnlineObservations", start);
  const fn = bump.slice(start, end);
  assert.match(fn, /for \(let offset = 0; offset < authorityItems\.length; offset \+= FAN_DATA_OBSERVATION_BATCH_MAX\)/);
  assert.match(fn, /authorityItems\.slice\(offset, offset \+ FAN_DATA_OBSERVATION_BATCH_MAX\)/);
  assert.match(fn, /authorityProjected \+= Number\(projected\?\.projected \|\| 0\)/);
  assert.doesNotMatch(fn, /items:\s*authorityItems,/);
  assert.match(fn, /return \{ ok: true, count: rows\.length, fanIds: ids, authorityProjected \}/);
});

test("INT5.5C-2 generic projector has an explicit max contract rather than slice-based loss", () => {
  const authority = read("services/fan-data-authority-service.js");
  const start = authority.indexOf("async function commitFanFacts");
  const end = authority.indexOf("\nasync function projectFanObservationBatch", start);
  const fn = authority.slice(start, end);
  assert.match(fn, /inputItems\.length > FAN_DATA_OBSERVATION_BATCH_MAX/);
  assert.match(fn, /FAN_DATA_OBSERVATION_BATCH_TOO_LARGE/);
  assert.doesNotMatch(fn, /items\.slice\(0, 500\)/);
});


test("INT5.5C-2 action observation HTTP ingress rejects oversized writes instead of truncating them", () => {
  const route = read("routes/fan-data.js");
  const start = route.indexOf('router.post("/observations"');
  const end = route.indexOf('\nrouter.post("/refresh"', start);
  const fn = route.slice(start, end);
  assert.match(fn, /items\.length > 100/);
  assert.match(fn, /FAN_DATA_OBSERVATION_REQUEST_TOO_LARGE/);
  assert.doesNotMatch(fn, /req\.body\?\.items\.slice\(0, 100\)/);
});
