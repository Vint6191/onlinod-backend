"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRecoveryRuntimeObserver, inspectRecoveryRuntime } = require("./recovery-runtime-observer");
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test("diagnostic reads are bounded, deduplicated, asynchronous and drained at shutdown", async () => {
  let now = 0, calls = 0; const gate = deferred(), events = [];
  const observer = createRecoveryRuntimeObserver({ now: () => now, inspect: async () => { calls++; return gate.promise; },
    transaction: (_db, read) => read({}), emit: (...args) => events.push(args) });
  const context = { db: {}, agencyId: "a", creatorId: "c" };
  const first = observer.observe(context);
  assert.equal(calls, 0, "no synchronous database work before response");
  assert.equal(observer.observe({ ...context, creatorId: "other" }), null, "no work queue beyond concurrency bound");
  await Promise.resolve(); assert.equal(calls, 1);
  let stopped = false; const shutdown = observer.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  gate.resolve({ scope: "test" }); await first; await shutdown;
  assert.equal(stopped, true); assert.equal(observer.observe(context), null);
  assert.equal(events[0][0], "creator recovery snapshot");
});
test("creator cooldown and global sampling limit run before database queries", async () => {
  let now = 0, calls = 0;
  const observer = createRecoveryRuntimeObserver({ now: () => now, maxPerMinute: 2,
    inspect: async () => { calls++; return {}; }, transaction: (_db, read) => read({}), emit() {} });
  const context = { db: {}, agencyId: "a", creatorId: "c" };
  await observer.observe(context); assert.equal(observer.observe(context), null);
  await observer.observe({ ...context, creatorId: "d" }); assert.equal(observer.observe({ ...context, creatorId: "e" }), null);
  now = 60_000; await observer.observe(context); assert.equal(calls, 3); await observer.stop();
});
test("diagnostic failure cannot reject Stats and logs safe code instead of raw database text", async () => {
  const events = [], observer = createRecoveryRuntimeObserver({ transaction: async () => { throw Object.assign(Error("SELECT private financial value"), { code: "P2028" }); },
    emit: (...args) => events.push(args) });
  await observer.observe({ db: {}, agencyId: "a", creatorId: "c" });
  assert.equal(events[0][0], "creator recovery inspection failed");
  assert.equal(events[0][2].error.code, "P2028"); assert.doesNotMatch(JSON.stringify(events), /private financial/);
});
test("wrong agency or retired creator stops observation before subsidiary queries", async () => {
  let count = 0;
  const result = await inspectRecoveryRuntime({ creatorAccount: { findFirst: async input => {
    count++; assert.deepEqual(input.where, { id: "c", agencyId: "wrong", deletedAt: null }); return null;
  } } }, { agencyId: "wrong", creatorId: "c" });
  assert.equal(result.scopeUnavailable, true); assert.equal(count, 1);
});
