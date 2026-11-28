"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "../prisma" && parent?.filename?.endsWith("automation-pacing-service.js")) return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { nextAutomationWriteSlot, claimPacingRetryAt } = require("./automation-pacing-service");
Module._load = originalLoad;

function sequenceDb(values) {
  const calls = [];
  let index = 0;
  return {
    calls,
    automationDelivery: {
      findFirst: async (input) => {
        calls.push(input);
        return values[index++] ?? null;
      },
    },
  };
}

test("write slot ignores future delete reservations and spaces queued sends", async () => {
  const db = sequenceDb([
    { status: "QUEUED", notBefore: new Date("2026-07-15T10:00:30.000Z"), claimedAt: null },
    { finishedAt: new Date("2026-07-15T09:59:00.000Z") },
    null,
    { status: "QUEUED", notBefore: new Date("2026-07-15T10:00:30.000Z"), claimedAt: null },
    null,
    null,
  ]);
  const result = await nextAutomationWriteSlot({
    agencyId: "a", creatorId: "c", actionType: "SEND_MESSAGE",
    workspaceSettings: { globalWriteMinIntervalMs: 15000, globalWriteMaxIntervalMs: 30000, randomJitter: false },
    actionSettings: { minimumIntervalMs: 15000, maximumIntervalMs: 30000, randomJitter: false },
    now: new Date("2026-07-15T10:00:00.000Z"), db,
  });
  assert.equal(result.toISOString(), "2026-07-15T10:00:45.000Z");
  assert.deepEqual(db.calls[0].where.OR, [
    { actionType: { not: "DELETE_MESSAGE" } },
    { notBefore: { lte: new Date("2026-07-15T10:00:00.000Z") } },
  ]);
});

test("216 physical attempts consume global and action pacing after every provider outcome", async () => {
  const now = new Date("2026-11-28T10:00:10Z");
  for (const status of ["FAILED", "RETRY_SCHEDULED", "CANCELED", "RECONCILE_REQUIRED", "COMMITTING"]) {
    const db = sequenceDb([null, null, { status, writeCommitAt: new Date("2026-11-28T10:00:05Z") }, { status, writeCommitAt: new Date("2026-11-28T10:00:00Z") }]);
    const retryAt = await claimPacingRetryAt({ delivery: { id: "same-retry", agencyId: "a", creatorId: "c", actionType: "LIKE_POST" },
      workspaceSettings: { globalWriteMinIntervalMs: 15000 }, actionSettings: { minimumIntervalMs: 30000 }, now, db });
    assert.equal(retryAt.toISOString(), "2026-11-28T10:00:30.000Z", status);
    assert.equal(db.calls[2].where.id, undefined, "do not discard the current delivery's previous physical permit");
    assert.deepEqual(db.calls[2].where.writeCommitAt, { not: null });
    assert.equal(db.calls[3].where.actionType, "LIKE_POST");
  }
});

test("216 no physical permit and no completed work leave the pacing lane immediately available", async () => {
  const db = sequenceDb([null, null, null, null]);
  assert.equal(await claimPacingRetryAt({ delivery: { id: "prewire", agencyId: "a", creatorId: "c", actionType: "LIKE_POST" },
    workspaceSettings: { globalWriteMinIntervalMs: 15000 }, actionSettings: { minimumIntervalMs: 30000 }, now: new Date("2026-11-28T10:00:00Z"), db }), null);
});

test("claim-time pacing rechecks actual completion time", async () => {
  const db = sequenceDb([
    { finishedAt: new Date("2026-07-15T10:00:00.000Z") },
    { finishedAt: new Date("2026-07-15T10:00:05.000Z") },
  ]);
  const retryAt = await claimPacingRetryAt({
    delivery: { id: "d", agencyId: "a", creatorId: "c", actionType: "SEND_MESSAGE" },
    workspaceSettings: { globalWriteMinIntervalMs: 15000 },
    actionSettings: { minimumIntervalMs: 30000 },
    now: new Date("2026-07-15T10:00:10.000Z"), db,
  });
  assert.equal(retryAt.toISOString(), "2026-07-15T10:00:35.000Z");
});
