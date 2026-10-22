"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { assertFanDataBatchProgress, recheckFanDataBatchDemand } = require("./fan-data-batch-authority");
const envelope = value => ({ driverPhase: "execute", jobContinuation: value });
const initial = () => ({ pipelineVersion: 1, index: 0, refreshed: 0, unavailable: 0, reused: 0, reusedUnavailable: 0, errors: 0, failures: [], retry: null });
function fixture() {
  const state = initial();
  return { job: { jobKey: "fan_data_point_refresh", params: { fanDataPipelineVersion: 1, fanIds: ["1","2","3"] }, continuation: envelope(state) },
    continuation: envelope({ ...state, index: 2, refreshed: 1, unavailable: 1 }),
    chunkResult: { kind: "fan_data_point_refresh", pipelineVersion: 1, startIndex: 0, endIndex: 2, fanIds: ["1","2"],
      items: [{ onlyFansUserId: "1", value: { availability: "AVAILABLE", totalSpentCents: 0 } },
        { onlyFansUserId: "2", value: { availability: "UNAVAILABLE" } }], reusedFanIds: [], reusedUnavailableFanIds: [], terminalFailures: [] } };
}
test("point refresh accepts only a fully accounted contiguous immutable prefix", () => {
  const f = fixture(); assert.doesNotThrow(() => assertFanDataBatchProgress(f));
  for (const change of [
    g => { g.chunkResult.items.pop(); },
    g => { g.chunkResult.items[1].onlyFansUserId = "1"; },
    g => { g.chunkResult.fanIds = ["2","3"]; },
    g => { g.continuation.jobContinuation.refreshed = 2; },
    g => { g.continuation.jobContinuation.index = 3; },
  ]) {
    const bad = structuredClone(f); change(bad);
    assert.throws(() => assertFanDataBatchProgress(bad), /FAN_DATA_BATCH_/);
  }
});
test("admission waits preserve checkpoint and no-receipt reports cannot advance or finish work", () => {
  const f = fixture(); f.job.continuation = envelope(null);
  assert.doesNotThrow(() => assertFanDataBatchProgress({ job: f.job, continuation: envelope(null) }));
  assert.throws(() => assertFanDataBatchProgress({ job: f.job, continuation: f.continuation }), /RECEIPT_REQUIRED/);
  assert.throws(() => assertFanDataBatchProgress({ job: f.job, continuation: { driverPhase: "complete", result: { requested: 3 } } }), /COMPLETION_UNCONFIRMED/);
});
test("a restart cannot reset profile retries or prematurely terminalize a fan", () => {
  const f = fixture(), prior = { ...initial(), index: 2, refreshed: 1, unavailable: 1,
    retry: { index: 2, fanId: "3", attempts: 3, code: "HTTP_ERROR", status: 503 } };
  f.job.continuation = envelope(prior);
  f.chunkResult = { kind: "fan_data_point_refresh", pipelineVersion: 1, startIndex: 2, endIndex: 2, fanIds: [], items: [],
    reusedFanIds: [], reusedUnavailableFanIds: [], terminalFailures: [] };
  f.continuation = envelope({ ...prior, retry: { ...prior.retry, attempts: 4 } });
  assert.doesNotThrow(() => assertFanDataBatchProgress(f));
  f.continuation.jobContinuation.retry.attempts = 1;
  assert.throws(() => assertFanDataBatchProgress(f), /RETRY_INVALID/);
  f.chunkResult.endIndex = 3; f.chunkResult.fanIds = ["3"];
  f.chunkResult.terminalFailures = [{ fanId: "3", attempts: 5, code: "HTTP_ERROR", status: 503 }];
  f.continuation = envelope({ ...prior, index: 3, errors: 1, retry: null });
  assert.throws(() => assertFanDataBatchProgress(f), /FAILURE_INVALID/);
  f.job.continuation.jobContinuation.retry.attempts = 4;
  assert.doesNotThrow(() => assertFanDataBatchProgress(f));
});
test("completion keeps reused unavailable fans distinct from complete financial coverage", () => {
  const f = fixture(); f.job.continuation = envelope({ ...initial(), index: 3, refreshed: 1, reused: 2, reusedUnavailable: 1 });
  const result = { requested: 3, refreshed: 1, reused: 2, unavailable: 1, errors: 0, complete: false };
  assert.doesNotThrow(() => assertFanDataBatchProgress({ job: f.job, continuation: { driverPhase: "complete", result } }));
  result.unavailable = 0;
  assert.throws(() => assertFanDataBatchProgress({ job: f.job, continuation: { driverPhase: "complete", result } }), /COMPLETION_UNCONFIRMED/);
});

test("read admission permits every group in one lookahead batch while enforcing the two-batch buffer bound", async () => {
  const fanIds = Array.from({ length: 50 }, (_, i) => String(i + 1));
  const job = { jobKey: "fan_data_point_refresh", creatorId: "creator", params: { fanIds }, continuation: envelope(initial()) };
  const db = { creatorFan: { findMany: async () => [] } };
  const admitted = await recheckFanDataBatchDemand({ db, job, batch: { startIndex: 35, fanIds: fanIds.slice(35,40) } });
  assert.deepEqual(admitted.readFanIds, fanIds.slice(35,40));
  await assert.rejects(recheckFanDataBatchDemand({ db, job, batch: { startIndex: 40, fanIds: fanIds.slice(40,45) } }), /CHECKPOINT_MISMATCH/);
});

test("another consumer's canonical fields satisfy a queued request only after its causal request cutoff", async () => {
  const requested = new Date("2026-10-01T12:00:00Z"), now = new Date("2026-10-01T12:00:10Z");
  const job = { jobKey: "fan_data_point_refresh", creatorId: "creator", createdAt: requested,
    params: { fanIds: ["1"], refreshFields: ["canReceiveChatMessage", "blocked"] }, continuation: envelope(initial()) };
  const fan = { onlyFansUserId: "1", valueCurrent: { availability: "AVAILABLE", valueObservedAt: now, platformReportedTotalSpendCents: 0n },
    relationshipCurrent: { canReceiveChatMessage: true, blocked: false,
      canReceiveChatMessageAuthorityVersion: "2026-10-01T12:00:05.000Z|700|USER_PROFILE",
      blockedAuthorityVersion: "2026-10-01T11:59:59.000Z|700|USER_PROFILE" } };
  const db = { creatorFan: { findMany: async () => [fan] } }, batch = { startIndex: 0, fanIds: ["1"] };
  const stale = await recheckFanDataBatchDemand({ db, job, batch, now });
  assert.deepEqual(stale.readFanIds, ["1"], "fresh money does not hide an older required relationship field");
  fan.relationshipCurrent.blockedAuthorityVersion = "2026-10-01T12:00:05.000Z|700|USER_PROFILE";
  const reused = await recheckFanDataBatchDemand({ db, job, batch, now });
  assert.deepEqual(reused.reusedFanIds, ["1"]); assert.deepEqual(reused.readFanIds, []);
  job.params.refreshFields = ["identity"];
  assert.deepEqual((await recheckFanDataBatchDemand({ db, job, batch, now })).readFanIds, ["1"]);
});
