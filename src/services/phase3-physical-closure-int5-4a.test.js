"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { applyFanDataPointRefreshChunk, projectFanObservationBatch } = require("./fan-data-authority-service");

function bulkDb() {
  const calls = [];
  const tx = {
    async $executeRawUnsafe(sql, ...args) {
      calls.push({ sql: String(sql), args });
      return 1;
    },
  };
  return {
    calls,
    async $transaction(work) { return work(tx); },
  };
}

function profile(fanId) {
  return {
    onlyFansUserId: fanId,
    relationship: {
      source: "USER_PROFILE",
      observedAt: "2026-09-16T20:00:00.000Z",
      creatorFollowsFan: true,
      canReceiveChatMessage: true,
    },
    value: {
      source: "USER_PROFILE",
      observedAt: "2026-09-16T20:00:00.000Z",
      availability: "AVAILABLE",
      totalSpentCents: 2500,
    },
  };
}

function splitSqlList(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

test("INT5.4A relationship bulk INSERT target and SELECT arity are identical and include sourceDeliveryId", async () => {
  const db = bulkDb();
  await projectFanObservationBatch(db, {
    agencyId: "agency-1",
    creatorId: "creator-1",
    sourceJobId: "job-1",
    sourceDeliveryId: "delivery-1",
    items: [profile("fan-1")],
    allowedSources: ["USER_PROFILE"],
    observedAtPolicy: "SERVER_GENERATION",
    causalObservedAt: new Date("2026-09-16T20:00:00.000Z"),
    receivedAt: new Date("2026-09-16T20:00:05.000Z"),
  });

  const relationshipCall = db.calls.find((call) => call.sql.includes('INSERT INTO "CreatorFanRelationshipCurrent"'));
  assert.ok(relationshipCall, "relationship bulk SQL must execute");
  const match = relationshipCall.sql.match(/INSERT INTO "CreatorFanRelationshipCurrent"\s*\(([\s\S]*?)\)\s*SELECT\s*([\s\S]*?)\s*FROM joined/);
  assert.ok(match, "relationship INSERT/SELECT shape must be statically readable");
  const targets = splitSqlList(match[1]);
  const expressions = splitSqlList(match[2]);
  assert.equal(targets.length, expressions.length, `target/SELECT arity mismatch: ${targets.length}/${expressions.length}`);
  assert.equal(targets.length, 38);
  assert.equal(targets.indexOf('"sourceDeliveryId"'), expressions.indexOf('"sourceDeliveryId"'));
  assert.ok(targets.includes('"sourceDeliveryId"'));
});

test("INT5.4A post-effect point refresh carries sourceDeliveryId into canonical relationship/value rows", async () => {
  const db = bulkDb();
  const result = await applyFanDataPointRefreshChunk({
    db,
    deviceId: "device-1",
    job: {
      id: "refresh-job-1",
      agencyId: "agency-1",
      creatorId: "creator-1",
      createdAt: new Date("2026-09-16T20:00:00.000Z"),
      params: { fanIds: ["fan-1"], sourceDeliveryId: "delivery-effect-1" },
    },
    chunkResult: { kind: "fan_data_point_refresh", items: [profile("fan-1")] },
  });
  assert.equal(result.projected, 1);

  const relationshipCall = db.calls.find((call) => call.sql.includes('INSERT INTO "CreatorFanRelationshipCurrent"'));
  const valueCall = db.calls.find((call) => call.sql.includes('INSERT INTO "CreatorFanValueCurrent"'));
  assert.ok(relationshipCall);
  assert.ok(valueCall);
  const relationshipRows = JSON.parse(relationshipCall.args[0]);
  const valueRows = JSON.parse(valueCall.args[0]);
  assert.equal(relationshipRows[0].sourceJobId, "refresh-job-1");
  assert.equal(relationshipRows[0].sourceDeliveryId, "delivery-effect-1");
  assert.equal(valueRows[0].sourceJobId, "refresh-job-1");
  assert.equal(valueRows[0].sourceDeliveryId, "delivery-effect-1");
});

test("INT5.4A Backend observation ingress still requires the same Desktop lease tuple", () => {
  const route = fs.readFileSync(path.resolve(__dirname, "../routes/fan-data.js"), "utf8");
  assert.match(route, /const deliveryId = clean\(req\.body\?\.deliveryId\)/);
  assert.match(route, /const leaseToken = clean\(req\.body\?\.leaseToken, 2000\)/);
  assert.match(route, /const leaseRevision = Number\(req\.body\?\.leaseRevision\)/);
  assert.match(route, /if \(!deliveryId \|\| !leaseToken \|\| !Number\.isInteger\(leaseRevision\)\)/);
  assert.match(route, /authorizeActionProfileObservation\(\{/);
  assert.match(route, /sourceDeliveryId:\s*scope\.delivery\.id/);
});
