"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { notificationRepairParams, needsNotificationRepairRotation } = require("./notification-repair-service");

function partial() {
  return { jobKey: "catchup_notifications_scan", params: {
    collectionGeneration: "old-run", collectionRequestedAt: "2026-10-13T23:00:00.000Z",
    collectionAuthorityRequestedAt: "2026-10-13T23:00:00.000Z", notificationMode: "full", types: ["tips"],
    from: "2016-01-01T00:00:00.000Z", resumeCursors: { tips: "old-cursor" }, notificationRepairPass: 2,
  }, result: { scanRunId: "old-run", coverage: { purchases: { status: "complete" }, tips: { status: "partial" } },
    completionSideEffect: { ok: false, verified: false } } };
}

test("a repair restores the requested scope under a new generation, even in the same DB millisecond", () => {
  const job = partial();
  const params = notificationRepairParams(job, new Date(job.params.collectionAuthorityRequestedAt));
  assert.notEqual(params.collectionGeneration, job.params.collectionGeneration);
  assert.equal(params.collectionAuthorityRequestedAt, "2026-10-13T23:00:00.001Z");
  assert.deepEqual(params.types, ["purchases", "tips"]);
  assert.equal(params.from, job.params.from);
  assert.equal(params.notificationRepairFromRunId, "old-run");
  assert.equal(params.collectionType, "NOTIFICATIONS");
  assert.equal(params.collectionMode, "full");
  assert.equal("resumeCursors" in params, false);
  assert.equal("notificationRepairPass" in params, false);
  assert.deepEqual(job.params.types, ["tips"], "old immutable command is untouched");
  assert.equal(needsNotificationRepairRotation({ ...job, params }), false, "new run must not rotate on every page");
});

test("only an unfinished repair of the same notification generation is migrated", () => {
  const job = partial();
  assert.equal(needsNotificationRepairRotation(job), true);
  assert.equal(Boolean(needsNotificationRepairRotation({ ...job, result: null })), false);
  assert.equal(needsNotificationRepairRotation({ ...job, jobKey: "financial_transactions_scan" }), false);
  assert.equal(needsNotificationRepairRotation({ ...job, result: { ...job.result, scanRunId: "older-run" } }), false);
  assert.equal(needsNotificationRepairRotation({ ...job, result: { ...job.result, completionSideEffect: { ok: true, verified: true } } }), false);
});

test("bounded catch-up keeps its mode and lower bound while obtaining new page receipt identity", () => {
  const job = partial();
  job.params.notificationMode = "catchup";
  const params = notificationRepairParams(job, new Date("2026-10-14T00:00:00Z"));
  assert.equal(params.notificationMode, "catchup");
  assert.equal(params.collectionMode, "catchup");
  assert.equal(params.from, job.params.from);
  assert.notEqual(params.collectionGeneration, "old-run");
});
