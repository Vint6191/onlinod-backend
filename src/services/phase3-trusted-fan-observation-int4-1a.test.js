"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { projectFanObservationBatch, applyFanDataPointRefreshChunk } = require("./fan-data-authority-service");

function p2002() { const error = new Error("unique"); error.code = "P2002"; return error; }
function makeDb() {
  let fan = null;
  let relationship = null;
  let value = null;
  const matches = (row, where = {}) => {
    if (!row) return false;
    for (const [key, condition] of Object.entries(where)) {
      if (key === "OR") continue;
      if (condition && typeof condition === "object" && !Array.isArray(condition)) {
        if (Object.prototype.hasOwnProperty.call(condition, "lt")) {
          if (row[key] != null && !(row[key] < condition.lt)) return false;
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(condition, "in")) {
          if (!condition.in.includes(row[key])) return false;
          continue;
        }
        for (const [innerKey, innerValue] of Object.entries(condition)) if (row[innerKey] !== innerValue) return false;
        continue;
      }
      if (row[key] !== condition) return false;
    }
    if (Array.isArray(where.OR) && !where.OR.some((branch) => matches(row, branch))) return false;
    return true;
  };
  return {
    get fan() { return fan; },
    get relationship() { return relationship; },
    get value() { return value; },
    creatorFan: {
      findUnique: async () => fan,
      findMany: async () => fan ? [fan] : [],
      create: async ({ data }) => { if (fan) throw p2002(); fan = { ...data }; return fan; },
      updateMany: async ({ where, data }) => {
        if (!matches(fan, where)) return { count: 0 };
        fan = { ...fan, ...data }; return { count: 1 };
      },
    },
    creatorFanRelationshipCurrent: {
      findUnique: async () => relationship,
      create: async ({ data }) => { if (relationship) throw p2002(); relationship = { id: "rel-1", ...data }; return relationship; },
      updateMany: async ({ where, data }) => {
        if (!matches(relationship, where)) return { count: 0 };
        relationship = { ...relationship, ...data }; return { count: 1 };
      },
    },
    creatorFanValueCurrent: {
      findUnique: async () => value,
      create: async ({ data }) => { if (value) throw p2002(); value = { id: "value-1", ...data }; return value; },
      updateMany: async ({ where, data }) => {
        if (!matches(value, where)) return { count: 0 };
        value = { ...value, ...data }; return { count: 1 };
      },
    },
  };
}

test("INT4.1A canonical batch owns tenant creator fan and provenance envelope", async () => {
  const db = makeDb();
  const receipt = new Date("2026-09-16T15:30:00.000Z");
  const result = await projectFanObservationBatch(db, {
    agencyId: "agency-a",
    creatorId: "creator-a",
    sourceDeviceId: "device-a",
    sourceJobId: "job-a",
    allowedSources: ["USER_PROFILE"],
    observedAtPolicy: "SERVER_RECEIPT",
    receivedAt: receipt,
    items: [{
      onlyFansUserId: "fan-a",
      identity: {
        agencyId: "agency-b", creatorId: "creator-b", onlyFansUserId: "fan-b",
        sourceDeviceId: "device-b", sourceJobId: "job-b", source: "USER_PROFILE",
        observedAt: "2099-01-01T00:00:00.000Z", username: "safe-user",
      },
      relationship: {
        agencyId: "agency-b", creatorId: "creator-b", onlyFansUserId: "fan-b",
        sourceDeviceId: "device-b", sourceJobId: "job-b", source: "USER_PROFILE",
        observedAt: "2099-01-01T00:00:00.000Z", creatorFollowsFan: true,
      },
      value: {
        agencyId: "agency-b", creatorId: "creator-b", onlyFansUserId: "fan-b",
        sourceDeviceId: "device-b", sourceJobId: "job-b", source: "USER_PROFILE",
        observedAt: "2099-01-01T00:00:00.000Z", availability: "AVAILABLE", totalSpentCents: 123,
      },
    }],
  });
  assert.equal(result.projected, 1);
  assert.equal(db.fan.agencyId, "agency-a");
  assert.equal(db.fan.creatorId, "creator-a");
  assert.equal(db.fan.onlyFansUserId, "fan-a");
  assert.equal(db.fan.identityObservedAt.toISOString(), receipt.toISOString());
  assert.equal(db.relationship.agencyId, "agency-a");
  assert.equal(db.relationship.creatorId, "creator-a");
  assert.equal(db.relationship.onlyFansUserId, "fan-a");
  assert.equal(db.relationship.sourceDeviceId, "device-a");
  assert.equal(db.relationship.sourceJobId, "job-a");
  assert.equal(db.relationship.source, "USER_PROFILE");
  assert.equal(db.relationship.observedAt.toISOString(), receipt.toISOString());
  assert.equal(db.value.agencyId, "agency-a");
  assert.equal(db.value.creatorId, "creator-a");
  assert.equal(db.value.sourceDeviceId, "device-a");
  assert.equal(db.value.sourceJobId, "job-a");
  assert.equal(db.value.source, "USER_PROFILE");
  assert.equal(db.value.valueObservedAt.toISOString(), receipt.toISOString());
});

test("INT4.1A producer cannot self-assign AUTOMATION_WRITE_RESULT priority", async () => {
  const db = makeDb();
  await assert.rejects(
    () => projectFanObservationBatch(db, {
      agencyId: "agency-a", creatorId: "creator-a",
      allowedSources: ["USER_PROFILE"], observedAtPolicy: "SERVER_RECEIPT",
      receivedAt: new Date("2026-09-16T15:30:00.000Z"),
      items: [{ onlyFansUserId: "fan-a", relationship: { creatorFollowsFan: true, source: "AUTOMATION_WRITE_RESULT", observedAt: "2099-01-01T00:00:00Z" } }],
    }),
    (error) => error?.code === "FAN_DATA_OBSERVATION_SOURCE_FORBIDDEN" && error?.status === 403,
  );
  assert.equal(db.fan, null, "entire producer batch must validate before the first canonical write");
});

test("INT4.1A source/time producer policy is mandatory for generic canonical batch", async () => {
  const db = makeDb();
  await assert.rejects(
    () => projectFanObservationBatch(db, {
      agencyId: "agency-a", creatorId: "creator-a",
      items: [{ onlyFansUserId: "fan-a", relationship: { creatorFollowsFan: true, source: "USER_PROFILE", observedAt: new Date() } }],
    }),
    (error) => error?.code === "FAN_DATA_OBSERVATION_PRODUCER_POLICY_REQUIRED",
  );
  assert.equal(db.fan, null);
});

test("INT4.1A direct observation ingress is device-bound and access-fenced at DB commit", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/fan-data.js"), "utf8");
  const actions = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  const manifest = fs.readFileSync(path.join(__dirname, "../route-manifest.js"), "utf8");
  assert.match(route, /requireProductDevice\(req, req\.auth\?\.deviceId/);
  assert.match(route, /prisma\.\$transaction\(async \(tx\)/);
  assert.match(route, /authorizeActionProfileObservation\(\{/);
  assert.match(route, /deliveryId/);
  assert.match(route, /leaseToken/);
  assert.match(route, /leaseRevision/);
  assert.match(actions, /async function authorizeActionProfileObservation/);
  assert.match(actions, /requireLease\(\{[\s\S]*lockAccess:\s*true/);
  assert.match(actions, /FAN_DATA_OBSERVATION_TARGET_SCOPE_MISMATCH/);
  assert.match(route, /allowedSources:\s*\["USER_PROFILE"\]/);
  assert.match(route, /observedAtPolicy:\s*"SERVER_GENERATION"/);
  assert.match(route, /let causalObservedAt = scope\.causalObservedAt/);
  assert.match(route, /consumeActionFanObservationToken\(\{/);
  assert.match(route, /causalObservedAt = consumed\.observedAt/);
  assert.match(route, /causalObservedAt,\s*\n\s*\}\);/);
  assert.match(manifest, /\/api\/fan-data[\s\S]*ROUTE_CLASS\.CREATOR[\s\S]*observations additionally requires device-bound/);
});

test("INT4.1A point refresh and runtime observation producers use explicit narrow policies", () => {
  const authority = fs.readFileSync(path.join(__dirname, "fan-data-authority-service.js"), "utf8");
  const bump = fs.readFileSync(path.join(__dirname, "bump-service.js"), "utf8");
  const refreshStart = authority.indexOf("async function applyFanDataPointRefreshChunk");
  const refreshEnd = authority.indexOf("async function scheduleFanDataPointRefresh", refreshStart);
  const refresh = authority.slice(refreshStart, refreshEnd);
  assert.match(refresh, /allowedSources:\s*\["USER_PROFILE"\]/);
  assert.match(refresh, /observedAtPolicy:\s*"SERVER_GENERATION"/);
  assert.match(refresh, /causalObservedAt = date\(job\.createdAt\)/);
  assert.match(bump, /allowedSources:\s*\["PRESENCE_HINT"\]/);
  assert.doesNotMatch(bump, /allowedSources:\s*\[[^\]]*"LIVE_NOTIFICATION"/);
  assert.match(bump, /observedAtPolicy:\s*"SERVER_RECEIPT"/);
});


test("INT4.4A point refresh chunk cannot escape the server-requested fan set", async () => {
  const db = makeDb();
  const job = {
    id: "refresh-job-1",
    agencyId: "agency-a",
    creatorId: "creator-a",
    createdAt: new Date("2026-09-16T15:00:00.000Z"),
    params: { fanIds: ["fan-a"] },
  };
  await assert.rejects(
    () => applyFanDataPointRefreshChunk({
      db,
      job,
      deviceId: "device-a",
      chunkResult: {
        kind: "fan_data_point_refresh",
        items: [{
          onlyFansUserId: "fan-b",
          relationship: { creatorFollowsFan: true, source: "USER_PROFILE", observedAt: "2099-01-01T00:00:00.000Z" },
        }],
      },
    }),
    (error) => error?.code === "FAN_DATA_POINT_REFRESH_FAN_SCOPE_MISMATCH" && error?.status === 403,
  );
  assert.equal(db.fan, null, "out-of-scope refresh payload must fail before any canonical write");
});

test("INT4.4A point refresh requires a server-requested fan scope", async () => {
  const db = makeDb();
  await assert.rejects(
    () => applyFanDataPointRefreshChunk({
      db,
      job: { id: "refresh-job-legacy", agencyId: "agency-a", creatorId: "creator-a", createdAt: new Date("2026-09-16T15:00:00.000Z"), params: {} },
      deviceId: "device-a",
      chunkResult: { kind: "fan_data_point_refresh", items: [] },
    }),
    (error) => error?.code === "FAN_DATA_POINT_REFRESH_SCOPE_REQUIRED" && error?.status === 409,
  );
});


test("INT4.4A point refresh value bookkeeping uses PostgreSQL receipt time, not producer/process wall clock", async () => {
  const db = makeDb();
  const authorityNow = new Date("2026-09-16T18:45:00.000Z");
  db.$queryRawUnsafe = async () => [{ authorityNow }];
  let trafficUpdate = null;
  db.trafficSourceMember = {
    updateMany: async (input) => { trafficUpdate = input; return { count: 1 }; },
  };
  await applyFanDataPointRefreshChunk({
    db,
    job: { id: "refresh-job-value", agencyId: "agency-a", creatorId: "creator-a", createdAt: new Date("2026-09-16T15:00:00.000Z"), params: { fanIds: ["fan-a"] } },
    deviceId: "device-a",
    chunkResult: {
      kind: "fan_data_point_refresh",
      observedAt: "2099-01-01T00:00:00.000Z",
      items: [{
        onlyFansUserId: "fan-a",
        value: { availability: "AVAILABLE", totalSpentCents: 123, source: "USER_PROFILE", observedAt: "2099-01-01T00:00:00.000Z" },
      }],
    },
  });
  assert.ok(trafficUpdate?.data?.lastValueFetchedAt instanceof Date);
  assert.equal(trafficUpdate.data.lastValueFetchedAt.toISOString(), authorityNow.toISOString());
  assert.notEqual(trafficUpdate.data.lastValueFetchedAt.toISOString(), "2099-01-01T00:00:00.000Z");
});

test("INT5.1A point refresh canonical time is server job generation, not delayed receipt or client clock", async () => {
  const db = makeDb();
  const generationAt = new Date("2026-09-16T15:00:00.000Z");
  const delayedClaimAt = new Date("2026-09-16T18:00:00.000Z");
  const delayedStartAt = new Date("2026-09-16T18:05:00.000Z");
  db.$queryRawUnsafe = async () => [{ authorityNow: new Date("2026-09-16T18:10:00.000Z") }];
  await applyFanDataPointRefreshChunk({
    db,
    job: { id: "refresh-causal", agencyId: "agency-a", creatorId: "creator-a", createdAt: generationAt, claimedAt: delayedClaimAt, startedAt: delayedStartAt, params: { fanIds: ["fan-a"] } },
    deviceId: "device-a",
    chunkResult: {
      kind: "fan_data_point_refresh",
      items: [{
        onlyFansUserId: "fan-a",
        relationship: { creatorFollowsFan: true, source: "USER_PROFILE", observedAt: "2099-01-01T00:00:00.000Z" },
      }],
    },
  });
  assert.equal(db.relationship.observedAt.toISOString(), generationAt.toISOString());
});


test("INT5.1C FanData server generations use durable DB-owned clocks rather than replica process time", () => {
  const actions = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  const route = fs.readFileSync(path.join(__dirname, "../routes/fan-data.js"), "utf8");
  const authority = fs.readFileSync(path.join(__dirname, "fan-data-authority-service.js"), "utf8");
  const subscriber = fs.readFileSync(path.join(__dirname, "subscriber-directory-service.js"), "utf8");
  const sfs = fs.readFileSync(path.join(__dirname, "sfs-service.js"), "utf8");
  const observationTokens = fs.readFileSync(path.join(__dirname, "fan-observation-token-service.js"), "utf8");

  const claimStart = actions.indexOf("async function claimActionDelivery");
  const claimEnd = actions.indexOf("async function renewActionLease", claimStart);
  const claim = actions.slice(claimStart, claimEnd);
  assert.match(claim, /const now = await dbAuthorityNow\(\{ db: prisma, fallbackNow: new Date\(\) \}\)/);

  const startStart = actions.indexOf("async function startActionDelivery");
  const startEnd = actions.indexOf("async function validateActionDelivery", startStart);
  const start = actions.slice(startStart, startEnd);
  assert.match(start, /const now = await dbAuthorityNow\(\{ db: tx, fallbackNow: new Date\(\) \}\)/);
  assert.match(start, /attemptStartedAt: now\.toISOString\(\)/);
  assert.match(start, /delivery\.notBefore\.getTime\(\) > now\.getTime\(\)/);

  assert.match(route, /const receivedAt = await dbAuthorityNow\(\{ db: tx, fallbackNow: new Date\(\) \}\)/);

  const refreshStart = authority.indexOf("async function applyFanDataPointRefreshChunk");
  const refreshEnd = authority.indexOf("async function scheduleFanDataPointRefresh", refreshStart);
  const refresh = authority.slice(refreshStart, refreshEnd);
  assert.match(refresh, /const receivedAt = await dbAuthorityNow\(\{ db, fallbackNow: new Date\(\) \}\)/);
  assert.match(refresh, /observationTokenRequired = Number\(job\?\.params\?\.observationTokenVersion/);
  assert.match(refresh, /consumeFanObservationToken/);
  assert.match(refresh, /causalObservedAt = date\(consumedToken\.observedAt\)/);
  assert.match(refresh, /causalObservedAt = date\(job\.createdAt\)/);
  assert.doesNotMatch(refresh, /causalObservedAt = date\(job\.startedAt\)/);
  assert.doesNotMatch(refresh, /causalObservedAt = date\(job\.claimedAt\)/);

  assert.match(subscriber, /observationTokenRequired = Number\(job\?\.params\?\.observationTokenVersion/);
  assert.match(subscriber, /consumeObservationToken/);
  assert.match(subscriber, /purpose:\s*"subscriber_directory_page"/);
  assert.match(subscriber, /SERVER_PROVIDER_READ_TOKEN/);
  assert.match(subscriber, /SERVER_SCAN_GENERATION_LEGACY/);
  assert.match(subscriber, /SUBSCRIBER_SCAN_CAUSAL_GENERATION_REQUIRED/);
  assert.match(sfs, /observationTokenVersion = int\(params\.observationTokenVersion, 0\)/);
  assert.match(sfs, /consumeObservationToken/);
  assert.match(sfs, /observedAt = dateOrNull\(consumed\?\.observedAt\)/);
  assert.match(sfs, /observedAt = dateOrNull\(job\.createdAt\)/);
  assert.match(sfs, /SFS_DISCOVERY_CAUSAL_GENERATION_REQUIRED/);
  assert.match(observationTokens, /FanObservationClock/);
  assert.match(observationTokens, /INTERVAL '1 millisecond'/);
});
