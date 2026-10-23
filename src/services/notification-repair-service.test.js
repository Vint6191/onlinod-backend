"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { notificationRepairParams, needsNotificationRepairRotation, notificationProgressIsStale } = require("./notification-repair-service");
const { NOTIFICATION_TYPES, hasFullNotificationScope } = require("./notification-collection-scope");

function partial() {
  return { jobKey: "catchup_notifications_scan", params: {
    notificationNormalizerVersion: "notification-source-v2", notificationFrontierVersion: 4, collectionGeneration: "old-run", collectionRequestedAt: "2026-10-13T23:00:00.000Z",
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
  assert.deepEqual(params.types, NOTIFICATION_TYPES);
  assert.equal(params.from, job.params.from);
  assert.equal(params.notificationRepairFromRunId, "old-run");
  assert.equal(params.collectionType, "NOTIFICATIONS");
  assert.equal(params.collectionMode, "full");
  assert.equal("resumeCursors" in params, false);
  assert.equal("notificationRepairPass" in params, false);
  assert.deepEqual(job.params.types, ["tips"], "old immutable command is untouched");
  assert.equal(needsNotificationRepairRotation({ ...job, params }), false, "new run must not rotate on every page");
});

test("a full-scope unfinished repair is migrated only for its own notification generation", () => {
  const job = partial();
  job.params.types = [...NOTIFICATION_TYPES];
  assert.equal(needsNotificationRepairRotation(job), true);
  assert.equal(Boolean(needsNotificationRepairRotation({ ...job, result: null })), false);
  assert.equal(needsNotificationRepairRotation({ ...job, jobKey: "financial_transactions_scan" }), false);
  assert.equal(needsNotificationRepairRotation({ ...job, result: { ...job.result, scanRunId: "older-run" } }), false);
  assert.equal(needsNotificationRepairRotation({ ...job, result: { ...job.result, completionSideEffect: { ok: true, verified: true } } }), false);
});

test("narrow active commands rotate without a completion marker and never narrow the repaired traversal", () => {
  for (const types of [["subscriptions"], ["tips", "purchases"], [], ["unknown"], [...NOTIFICATION_TYPES, "unknown"]]) {
    for (const notificationMode of ["full", "catchup"]) {
      const job = partial();
      job.params = { ...job.params, notificationMode, types };
      job.result = null;
      assert.equal(needsNotificationRepairRotation(job), true);
      const params = notificationRepairParams(job, new Date("2026-10-14T00:00:00Z"), null);
      assert.deepEqual(params.types, NOTIFICATION_TYPES);
      assert.equal(params.notificationMode, notificationMode);
      assert.notEqual(params.collectionGeneration, job.params.collectionGeneration);
      assert.equal(Boolean(needsNotificationRepairRotation({ ...job, params })), false);
    }
  }
});

test("full scope defaults, ordering and duplicate types do not repeatedly rotate healthy commands", () => {
  for (const types of [undefined, [...NOTIFICATION_TYPES].reverse(), [...NOTIFICATION_TYPES, "tips"], NOTIFICATION_TYPES.map(type => ` ${type.toUpperCase()} `)]) {
    const job = { ...partial(), result: null };
    job.params.types = types;
    assert.equal(hasFullNotificationScope(job.params), true);
    assert.equal(Boolean(needsNotificationRepairRotation(job)), false);
  }
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

test("notification cursor comparison accepts initial null and legacy wrapped states", () => {
  const job = { ...partial(), result: null, continuation: null };
  assert.equal(notificationProgressIsStale(job, null, { driverPhase: "execute", jobContinuation: null }), false);
  const state = { scanRunId: "old-run", page: 2, fromId: "100" };
  job.continuation = { driverPhase: "execute", jobContinuation: { driverPhase: "execute", jobContinuation: state } };
  assert.equal(notificationProgressIsStale(job, null, state), false);
  assert.equal(notificationProgressIsStale(job, null, { ...state, fromId: "101" }), true);
  assert.equal(notificationProgressIsStale(job, null, null), true);
});

test("old Desktop pages cannot rewind any typed phase and complete is terminal", () => {
  const job = { ...partial(), result: null, continuation: { scanRunId: "old-run", page: 12 } };
  for (const page of [1, 11, 12]) {
    assert.equal(notificationProgressIsStale(job, { kind: "notification_facts_page_all", scanRunId: "old-run", page }), true);
  }
  assert.equal(notificationProgressIsStale(job, { kind: "notification_facts_page_all", scanRunId: "old-run", page: 13 }), false);
  assert.equal(notificationProgressIsStale({ ...job, continuation: { ...job.continuation, schemaVersion: 7 } },
    { kind: "notification_facts_page_all", scanRunId: "old-run", page: 1 }), false, "legacy traversal restart has a different page sequence");
  assert.equal(notificationProgressIsStale({ ...job, continuation: { driverPhase: "complete", result: {} } }, null), true);
  assert.equal(notificationProgressIsStale({ ...job, jobKey: "financial_transactions_scan" }, null, null), false);
});

test("a parser upgrade fences old cursors and requires a new full source proof",()=>{
 const job=partial(); delete job.params.notificationNormalizerVersion; job.params.notificationMode="catchup";job.params.stopAtNotificationId="old-head";
 assert.equal(needsNotificationRepairRotation(job),true);
 const params=notificationRepairParams(job,new Date("2026-10-14T00:00:00Z"));
 assert.equal(params.notificationMode,"full");assert.equal(params.notificationNormalizerVersion,"notification-source-v2");assert.equal(params.stopAtNotificationId,undefined);
 assert.equal(Boolean(needsNotificationRepairRotation({...job,params,result:null})),false);
});

test("FULL without durable phase frontier rotates once before accepting more source pages", () => {
  const job = partial(); job.result = null; job.params.types = NOTIFICATION_TYPES;
  delete job.params.notificationFrontierVersion;
  assert.equal(needsNotificationRepairRotation(job), true);
  const params = notificationRepairParams(job, new Date("2026-10-14T00:00:00Z"));
  assert.equal(params.notificationFrontierVersion, 4);
  assert.equal(Boolean(needsNotificationRepairRotation({ ...job, params })), false);
});
