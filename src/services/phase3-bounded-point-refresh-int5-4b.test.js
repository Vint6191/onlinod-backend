"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { applyFanDataPointRefreshChunk } = require("./fan-data-authority-service");

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
    identity: {
      source: "USER_PROFILE",
      observedAt: "2026-09-16T20:00:00.000Z",
      username: `user_${fanId}`,
      platformDisplayName: `Fan ${fanId}`,
      avatarUrl: `https://example.test/${fanId}/avatar`,
      headerUrl: `https://example.test/${fanId}/header`,
    },
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

function job(fanIds) {
  return {
    id: "refresh-job-scale",
    agencyId: "agency-1",
    creatorId: "creator-1",
    createdAt: new Date("2026-09-16T20:00:00.000Z"),
    params: { fanIds },
  };
}

test("INT5.4B point refresh accepts exactly one bounded 20-fan chunk with O(1) bulk SQL topology", async () => {
  const fanIds = Array.from({ length: 20 }, (_, index) => `fan-${index + 1}`);
  const db = bulkDb();
  const result = await applyFanDataPointRefreshChunk({
    db,
    deviceId: "device-1",
    job: job(fanIds),
    chunkResult: { kind: "fan_data_point_refresh", items: fanIds.map(profile) },
  });
  assert.equal(result.projected, 20);
  const locks = db.calls.filter((call) => /pg_advisory_xact_lock/.test(call.sql));
  const writes = db.calls.filter((call) => !/pg_advisory_xact_lock/.test(call.sql));
  assert.equal(locks.length, 1, "20-fan point refresh must acquire one shared authority lock");
  assert.equal(writes.length, 4, "20-fan point refresh must stay on the four-statement production bulk path");
});

test("INT5.4B backend rejects a point-refresh chunk above the 20-observation transport bound", async () => {
  const fanIds = Array.from({ length: 21 }, (_, index) => `fan-${index + 1}`);
  await assert.rejects(
    applyFanDataPointRefreshChunk({
      db: bulkDb(), deviceId: "device-1", job: job(fanIds),
      chunkResult: { kind: "fan_data_point_refresh", items: fanIds.map(profile) },
    }),
    (error) => error?.code === "FAN_DATA_POINT_REFRESH_CHUNK_TOO_LARGE" && error?.status === 413,
  );
});

test("INT5.4B backend rejects duplicate same-causal fan observations in one point-refresh chunk", async () => {
  await assert.rejects(
    applyFanDataPointRefreshChunk({
      db: bulkDb(), deviceId: "device-1", job: job(["fan-1"]),
      chunkResult: { kind: "fan_data_point_refresh", items: [profile("fan-1"), profile("fan-1")] },
    }),
    (error) => error?.code === "FAN_DATA_POINT_REFRESH_DUPLICATE_FAN",
  );
});
