"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ensureSubmissionExecutionProfile,
  withCustomExecutionDefaultsLock,
  vaultSettlementFingerprint,
  lockAgencyPipelineLifecycle,
  lockCreatorPipelineLifecycle,
  withSubmissionPipelineLock,
  creatorCustomPipelineBlockers,
  agencyCustomPipelineBlockers,
  adjudicateCustomOrderCancellation,
  setUnassignedSubmissionDisposition,
  submissionAllowsNewPipelineWork,
  unresolvedPipelineSubmissionWhere,
  derivePipelineStage,
  executionFailureStillApplies,
  reportSubmissionExecutionAttempt,
  customExternalWriteClassification,
  customSubmissionExternalEffectConvergence,
} = require("./custom-content-pipeline-authority-service");

function profileDb({ folder = "vault-a", recipient = "relay_a", relayRows = [] } = {}) {
  const state = {
    creator: { id: "creator-1", agencyId: "agency-1", deletedAt: null, status: "READY", customsVaultFolderId: folder },
    recipient,
    submission: {
      id: "submission-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1",
      telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageIds: [731, 732],
      executionVaultFolderId: null, executionRelayRecipient: null, executionProfileRevision: 0, executionPinnedAt: null,
      pipelineDisposition: "ACTIVE",
    },
    relayRows: relayRows.map((row) => structuredClone(row)),
  };
  const db = {
    $executeRawUnsafe: async (sql) => { assert.match(String(sql), /pg_advisory_xact_lock/); return 0; },
    creatorAccount: { findFirst: async () => ({ ...state.creator }) },
    workspaceSetting: { findUnique: async () => state.recipient == null ? null : { value: state.recipient } },
    automationDelivery: {
      findMany: async () => state.relayRows.map((row) => ({ creatorId: row.creatorId || "creator-1", ...structuredClone(row) })),
    },
    customContentSubmission: {
      updateMany: async ({ where, data }) => {
        const row = state.submission;
        if (row.id !== where.id || row.agencyId !== where.agencyId || row.executionPinnedAt !== null || row.executionVaultFolderId !== null) return { count: 0 };
        if (Object.prototype.hasOwnProperty.call(where, "executionRelayRecipient") && row.executionRelayRecipient !== null) return { count: 0 };
        row.executionVaultFolderId = data.executionVaultFolderId;
        row.executionRelayRecipient = data.executionRelayRecipient;
        row.executionProfileRevision += Number(data.executionProfileRevision?.increment || 0);
        row.executionPinnedAt = data.executionPinnedAt;
        return { count: 1 };
      },
      findFirst: async () => ({ ...state.submission }),
    },
  };
  return { db, state };
}

test("execution-default advisory fence serializes first pin/default publication for the same Agency", async () => {
  let locked = false;
  const waiters = [];
  const acquire = () => new Promise((resolve) => {
    const grant = () => { locked = true; resolve(); };
    if (!locked) grant(); else waiters.push(grant);
  });
  const release = () => {
    locked = false;
    const next = waiters.shift();
    if (next) next();
  };
  const db = {
    $transaction: async (work) => {
      let ownsLock = false;
      const tx = {
        $executeRawUnsafe: async () => { await acquire(); ownsLock = true; return 0; },
      };
      try { return await work(tx); }
      finally { if (ownsLock) release(); }
    },
  };
  const entered = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = withCustomExecutionDefaultsLock({
    db,
    agencyId: "agency-1",
    work: async () => { entered.push("first-start"); await firstGate; entered.push("first-end"); },
  });
  while (!entered.includes("first-start")) await new Promise((resolve) => setImmediate(resolve));

  const second = withCustomExecutionDefaultsLock({
    db,
    agencyId: "agency-1",
    work: async () => { entered.push("second-start"); entered.push("second-end"); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, ["first-start"], "second transaction must wait at the shared execution-default fence");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(entered, ["first-start", "first-end", "second-start", "second-end"]);
});

test("execution profile pins Vault destination/relay recipient once and current defaults cannot retarget in-flight content", async () => {
  const { db, state } = profileDb({ folder: "vault-a", recipient: "relay_a" });
  const first = await ensureSubmissionExecutionProfile({ db, agencyId: "agency-1", submission: { ...state.submission }, now: new Date("2026-09-06T00:00:00Z") });
  assert.equal(first.vaultFolderId, "vault-a");
  assert.equal(first.relayRecipient, "relay_a");
  assert.equal(first.pinnedNow, true);

  state.creator.customsVaultFolderId = "vault-b";
  state.recipient = "relay_b";
  const second = await ensureSubmissionExecutionProfile({ db, agencyId: "agency-1", submission: { ...state.submission }, now: new Date("2026-09-06T00:01:00Z") });
  assert.equal(second.vaultFolderId, "vault-a");
  assert.equal(second.relayRecipient, "relay_a");
  assert.equal(second.pinnedNow, false);
  assert.equal(state.submission.executionProfileRevision, 1);
});

test("rolling cutover pins historical relay recipient instead of mutable current Workspace default", async () => {
  const { db, state } = profileDb({
    folder: "vault-current",
    recipient: "relay_new",
    relayRows: [{
      id: "legacy-write-1", idempotencyKey: "custom-relay:submission-1:0", status: "COMPLETED",
      payload: { submissionId: "submission-1", expectedIndex: 0, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "731", recipient: "relay_old" },
    }],
  });
  const result = await ensureSubmissionExecutionProfile({ db, agencyId: "agency-1", submission: { ...state.submission }, now: new Date("2026-09-06T00:00:00Z") });
  assert.equal(result.vaultFolderId, "vault-current", "pre-cutover folder was not historically recorded, so migration pins the current destination and reconciles proven media into it");
  assert.equal(result.relayRecipient, "relay_old", "durable historical relay recipient must outrank a later mutable Workspace default");
  assert.equal(state.submission.executionRelayRecipient, "relay_old");
});

test("rolling cutover fails closed when one submission historically used multiple relay recipients", async () => {
  const { db, state } = profileDb({
    folder: "vault-current",
    recipient: "relay_new",
    relayRows: [
      { id: "legacy-write-1", idempotencyKey: "custom-relay:submission-1:0", status: "COMPLETED", payload: { submissionId: "submission-1", expectedIndex: 0, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "731", recipient: "relay_a" } },
      { id: "legacy-write-2", idempotencyKey: "custom-relay:submission-1:1", status: "COMMITTING", payload: { submissionId: "submission-1", expectedIndex: 1, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "732", recipient: "relay_b" } },
    ],
  });
  await assert.rejects(
    () => ensureSubmissionExecutionProfile({ db, agencyId: "agency-1", submission: { ...state.submission }, now: new Date("2026-09-06T00:00:00Z") }),
    (error) => error?.code === "CUSTOM_SUBMISSION_EXECUTION_PROFILE_LEGACY_RECIPIENT_CONFLICT" && error?.status === 409,
  );
  assert.equal(state.submission.executionPinnedAt, null, "ambiguous legacy execution history must not publish a guessed profile");
});

test("Telegram-independent finalization can pin a Vault destination with no relay recipient", async () => {
  const { db, state } = profileDb({ folder: "vault-finalize", recipient: null });
  const result = await ensureSubmissionExecutionProfile({ db, agencyId: "agency-1", submission: { ...state.submission }, requireRelayRecipient: false, now: new Date("2026-09-06T00:00:00Z") });
  assert.equal(result.vaultFolderId, "vault-finalize");
  assert.equal(result.relayRecipient, null);
  assert.ok(result.submission.executionPinnedAt);
});

test("move-only finalization ignores contradictory historical relay recipients because that stage does not use relay transport", async () => {
  const { db, state } = profileDb({
    folder: "vault-finalize", recipient: "relay_current",
    relayRows: [
      { id: "legacy-write-1", idempotencyKey: "custom-relay:submission-1:0", status: "COMPLETED", payload: { submissionId: "submission-1", expectedIndex: 0, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "731", recipient: "relay_a" } },
      { id: "legacy-write-2", idempotencyKey: "custom-relay:submission-1:1", status: "COMPLETED", payload: { submissionId: "submission-1", expectedIndex: 1, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "732", recipient: "relay_b" } },
    ],
  });
  const result = await ensureSubmissionExecutionProfile({ db, agencyId: "agency-1", submission: { ...state.submission }, requireRelayRecipient: false, now: new Date("2026-09-06T00:00:00Z") });
  assert.equal(result.vaultFolderId, "vault-finalize");
  assert.equal(result.relayRecipient, null, "finalization must not acquire an unrelated current relay default");
  assert.ok(result.submission.executionPinnedAt);
});

test("new external relay permission derives from ACTIVE disposition plus live CONTENT lifecycle", () => {
  const active = { pipelineDisposition: "ACTIVE", customOrderId: "custom-1" };
  const live = { type: "CONTENT", status: "PENDING", fanDeliveredAt: null };
  assert.equal(submissionAllowsNewPipelineWork(active, live), true);
  assert.equal(submissionAllowsNewPipelineWork({ ...active, pipelineDisposition: "SALVAGE" }, live), false);
  assert.equal(submissionAllowsNewPipelineWork(active, { ...live, status: "CANCELLED" }), false);
  assert.equal(submissionAllowsNewPipelineWork(active, { ...live, fanDeliveredAt: new Date() }), false);
  assert.equal(submissionAllowsNewPipelineWork({ pipelineDisposition: "ACTIVE", customOrderId: null }, null), true, "unassigned active source may still be salvageable/assignable work");
});

test("one shared unresolved-pipeline predicate is safe for retirement and destructive Media Library guards", () => {
  assert.deepEqual(unresolvedPipelineSubmissionWhere(), {
    OR: [
      { pipelineDisposition: "SALVAGE" },
      { pipelineDisposition: "ACTIVE", customOrderId: null },
      { pipelineDisposition: "ACTIVE", customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } } },
    ],
  });
});


test("pipeline stage authority keeps SALVAGE convergent and separates finalized unassigned content from review", () => {
  const live = { type: "CONTENT", status: "PENDING", fanDeliveredAt: null };
  const active = { customOrderId: "custom-1", pipelineDisposition: "ACTIVE", telegramMessageIds: [1, 2], ofMediaIds: ["a", "b"], reviewStatus: "WAITING_REVIEW" };
  assert.equal(derivePipelineStage({ submission: active, order: live, finalized: true }), "REVIEW_READY");
  assert.equal(derivePipelineStage({ submission: { ...active, customOrderId: null }, order: null, finalized: true }), "ASSIGNMENT_REQUIRED");
  assert.equal(derivePipelineStage({ submission: { ...active, pipelineDisposition: "SALVAGE" }, order: { ...live, status: "CANCELLED" }, finalized: false }), "FINALIZATION_PENDING");
  assert.equal(derivePipelineStage({ submission: { ...active, pipelineDisposition: "SALVAGE" }, order: { ...live, status: "CANCELLED" }, finalized: true }), "SALVAGE_READY");
  assert.equal(derivePipelineStage({ submission: { ...active, pipelineDisposition: "ARCHIVED" }, order: null, finalized: true, blockedCode: "STALE" }), "TERMINAL");
  assert.equal(derivePipelineStage({ submission: active, order: { ...live, status: "COMPLETED" }, finalized: false, blockedCode: "STALE_EXECUTION_ERROR" }), "TERMINAL", "terminal Custom lifecycle outranks stale operational blocked state");
  assert.equal(derivePipelineStage({ submission: active, order: live, finalized: true, blockedCode: "STALE_FINALIZER_LOSER" }), "REVIEW_READY", "stale multi-device execution failure cannot hide canonically finalized review work");
  assert.equal(derivePipelineStage({ submission: { ...active, customOrderId: null }, order: null, finalized: true, blockedCode: "STALE_FINALIZER_LOSER" }), "ASSIGNMENT_REQUIRED", "stale execution retry metadata cannot hide finalized unassigned content");
  assert.equal(derivePipelineStage({ submission: { ...active, pipelineDisposition: "SALVAGE" }, order: { ...live, status: "CANCELLED" }, finalized: true, blockedCode: "STALE_FINALIZER_LOSER" }), "SALVAGE_READY", "stale finalizer loser cannot permanently strand completed salvage");
  assert.equal(derivePipelineStage({ submission: active, order: live, finalized: false, blockedCode: "CURRENT_EXECUTION_FAILURE" }), "BLOCKED", "blockedCode still gates a canonical execution stage that actually remains unfinished");
});


test("stale executor failures cannot re-block a submission after another device advanced the canonical upload index", async () => {
  const liveOrder = { id: "custom-1", type: "CONTENT", status: "PENDING", fanDeliveredAt: null };
  const current = {
    id: "submission-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1",
    pipelineDisposition: "ACTIVE", executionProfileRevision: 1, telegramMessageIds: [101, 102], ofMediaIds: ["9001"],
    pipelineBlockedCode: null, pipelineBlockedAt: null, pipelineLastAttemptAt: null, pipelineNextAttemptAt: null,
  };
  assert.equal(executionFailureStillApplies({ submission: current, order: liveOrder, expectedWorkKind: "UPLOAD_MEDIA", expectedIndex: 0, expectedExecutionProfileRevision: 1 }), false);
  assert.equal(executionFailureStillApplies({ submission: current, order: liveOrder, expectedWorkKind: "UPLOAD_MEDIA", expectedIndex: 1, expectedExecutionProfileRevision: 1 }), true);
  assert.equal(executionFailureStillApplies({ submission: current, order: { ...liveOrder, status: "CANCELLED" }, expectedWorkKind: "UPLOAD_MEDIA", expectedIndex: 1, expectedExecutionProfileRevision: 1 }), false);
  assert.equal(executionFailureStillApplies({ submission: current, order: liveOrder, expectedWorkKind: "UPLOAD_MEDIA", expectedIndex: 1, expectedExecutionProfileRevision: 2 }), false);

  let updates = 0;
  const db = {
    customContentSubmission: {
      findFirst: async () => ({ ...current }),
      update: async () => { updates += 1; },
    },
    customOrder: { findFirst: async () => ({ ...liveOrder }) },
  };
  const stale = await reportSubmissionExecutionAttempt({
    db, agencyId: "agency-1", submissionId: "submission-1", success: false, code: "DEVICE_A_FAILED",
    expectedWorkKind: "UPLOAD_MEDIA", expectedIndex: 0, expectedExecutionProfileRevision: 1, now: new Date("2026-09-06T15:00:00Z"),
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.blocked, false);
  assert.equal(updates, 0, "stale failure must not publish retry/backoff state over newer canonical progress");

  const currentFailure = await reportSubmissionExecutionAttempt({
    db, agencyId: "agency-1", submissionId: "submission-1", success: false, code: "DEVICE_B_FAILED",
    expectedWorkKind: "UPLOAD_MEDIA", expectedIndex: 1, expectedExecutionProfileRevision: 1, now: new Date("2026-09-06T15:01:00Z"),
  });
  assert.equal(currentFailure.stale, false);
  assert.equal(currentFailure.blocked, true);
  assert.equal(updates, 1, "failure for the still-current work position must retain durable backoff semantics");
});

test("finalizer failure reports are discarded after disposition/profile terminalization but remain valid for current salvage", () => {
  const base = {
    id: "submission-1", customOrderId: "custom-1", pipelineDisposition: "ACTIVE", executionProfileRevision: 3,
    telegramMessageIds: [101], ofMediaIds: ["9001"],
  };
  const live = { id: "custom-1", type: "CONTENT", status: "PENDING", fanDeliveredAt: null };
  assert.equal(executionFailureStillApplies({ submission: base, order: live, expectedWorkKind: "FINALIZE_LIBRARY", expectedExecutionProfileRevision: 3 }), true);
  assert.equal(executionFailureStillApplies({ submission: { ...base, pipelineDisposition: "SALVAGE" }, order: { ...live, status: "CANCELLED" }, expectedWorkKind: "FINALIZE_LIBRARY", expectedExecutionProfileRevision: 3 }), true);
  assert.equal(executionFailureStillApplies({ submission: { ...base, pipelineDisposition: "ARCHIVED" }, order: live, expectedWorkKind: "FINALIZE_LIBRARY", expectedExecutionProfileRevision: 3 }), false);
  assert.equal(executionFailureStillApplies({ submission: base, order: live, expectedWorkKind: "FINALIZE_LIBRARY", expectedExecutionProfileRevision: 2 }), false);
});

test("creator retirement blocks durable media-bearing provider events before submission materialization", async () => {
  let capturedInboundWhere = null;
  const db = {
    customOrder: { count: async () => 0 },
    customContentSubmission: { count: async () => 0 },
    automationDelivery: { count: async () => 0 },
    telegramInboundEvent: { count: async ({ where }) => { capturedInboundWhere = where; return 1; } },
  };
  const result = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(result.unresolvedInboundEvents, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(capturedInboundWhere, {
    agencyId: "agency-1", creatorId: "creator-1", hasMedia: true, submissionId: null,
    projectionState: { in: ["PENDING", "FAILED_RETRYABLE", "REVIEW_REQUIRED"] },
  });
});

test("creator retirement treats CALL and PHYSICAL PENDING orders as live business blockers too", async () => {
  let capturedOrderWhere = null;
  const db = {
    customOrder: { count: async ({ where }) => { capturedOrderWhere = where; return 2; } },
    customContentSubmission: { count: async () => 0 },
    automationDelivery: { count: async () => 0 },
  };
  const result = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(result.pendingOrders, 2);
  assert.equal(result.total, 2);
  assert.deepEqual(capturedOrderWhere, { agencyId: "agency-1", creatorId: "creator-1", status: "PENDING" });
});

test("creator retirement blocks terminal-order Telegram follow-up work until its provider outcome is resolved", async () => {
  let capturedIntentWhere = null;
  const db = {
    customOrder: { count: async () => 0 },
    customContentSubmission: { count: async () => 0 },
    automationDelivery: { count: async () => 0 },
    telegramDeliveryIntent: { count: async ({ where }) => { capturedIntentWhere = where; return 1; } },
  };
  const result = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(result.activeTelegramDeliveries, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(capturedIntentWhere, {
    agencyId: "agency-1", creatorId: "creator-1",
    OR: [
      { state: { in: ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT"] } },
      { state: "CONFIRMED", projectionBlockedAt: { not: null } },
    ],
  });
});

test("creator retirement blocks terminal no-retry external-write uncertainty until canonical resolution", async () => {
  let capturedWriteWhere = null;
  const db = {
    customOrder: { count: async () => 0 },
    customContentSubmission: { count: async () => 0 },
    automationDelivery: { count: async ({ where }) => { capturedWriteWhere = where; return 1; } },
  };
  const result = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(result.activeWrites, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(capturedWriteWhere, {
    agencyId: "agency-1", creatorId: "creator-1", actionType: { in: ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"] },
    OR: [
      { status: { in: ["QUEUED", "RETRY_SCHEDULED", "CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"] } },
      { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
    ],
  });
});

test("agency retirement aggregates every live Custom/source blocker across creators", async () => {
  const captured = {};
  const db = {
    customOrder: { count: async ({ where }) => { captured.orders = where; return 1; } },
    customContentSubmission: { count: async ({ where }) => { captured.submissions = where; return 2; } },
    automationDelivery: { count: async ({ where }) => { captured.writes = where; return 3; } },
    telegramDeliveryIntent: { count: async ({ where }) => { captured.telegramDeliveries = where; return 5; } },
    telegramInboundEvent: { count: async ({ where }) => { captured.inbound = where; return 4; } },
  };
  const result = await agencyCustomPipelineBlockers({ db, agencyId: "agency-1" });
  assert.deepEqual(result, { pendingOrders: 1, activeSubmissions: 2, activeWrites: 3, activeTelegramDeliveries: 5, unresolvedInboundEvents: 4, cancelledTelegramFollowupDebt: 0, confirmedTelegramProjectionDebt: 0, completedExternalProjectionDebt: 0, total: 15 });
  assert.deepEqual(captured.orders, { agencyId: "agency-1", status: "PENDING" });
  assert.equal(captured.submissions.agencyId, "agency-1");
  assert.deepEqual(captured.writes, {
    agencyId: "agency-1", actionType: { in: ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"] },
    OR: [
      { status: { in: ["QUEUED", "RETRY_SCHEDULED", "CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"] } },
      { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
    ],
  });
  assert.deepEqual(captured.telegramDeliveries, {
    agencyId: "agency-1",
    OR: [
      { state: { in: ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT"] } },
      { state: "CONFIRMED", projectionBlockedAt: { not: null } },
    ],
  });
  assert.deepEqual(captured.inbound, {
    agencyId: "agency-1", hasMedia: true, submissionId: null,
    projectionState: { in: ["PENDING", "FAILED_RETRYABLE", "REVIEW_REQUIRED"] },
  });
});

test("creator retirement blocks legacy unmarked CONFIRMED projection debt until canonical business projection converges", async () => {
  const order = {
    id: "order-confirmed-projection-debt", agencyId: "agency-1", creatorId: "creator-1", status: "COMPLETED",
    telegramTaskMessageId: null, deliveredAt: null, telegramReferenceMessageIds: [], lastReminderAt: null,
  };
  const intent = {
    id: "task-confirmed-projection-debt", agencyId: "agency-1", creatorId: "creator-1", customOrderId: order.id,
    accountId: "tg-1", kind: "TASK", state: "CONFIRMED", remoteMessageId: 701, remoteSentAt: new Date("2026-09-06T00:00:00Z"),
    confirmedAt: new Date("2026-09-06T00:00:01Z"), projectionBlockedAt: null,
  };
  const db = {
    customOrder: {
      count: async () => 0,
      findMany: async ({ where }) => where.id?.in?.includes(order.id) ? [{ ...order }] : [],
    },
    customContentSubmission: { count: async () => 0 },
    automationDelivery: { count: async () => 0 },
    telegramDeliveryIntent: {
      count: async () => 0,
      findMany: async ({ where }) => {
        if (where.state === "CONFIRMED" && where.kind?.in?.includes("TASK")) return [{ ...intent }];
        return [];
      },
    },
  };

  const blocked = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(blocked.confirmedTelegramProjectionDebt, 1);
  assert.equal(blocked.total, 1);

  order.telegramTaskMessageId = 701;
  order.deliveredAt = new Date("2026-09-06T00:00:00Z");
  const converged = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(converged.confirmedTelegramProjectionDebt, 0);
  assert.equal(converged.total, 0);
});

test("creator retirement blocks confirmed TASK history whose cancelled-order follow-up was never materialized", async () => {
  const order = { id: "order-cancelled-debt", agencyId: "agency-1", creatorId: "creator-1", status: "CANCELLED", telegramTaskMessageId: null };
  const intents = [{ id: "task-confirmed-debt", agencyId: "agency-1", creatorId: "creator-1", customOrderId: order.id, accountId: "tg-1", kind: "TASK", state: "CONFIRMED", remoteMessageId: 700, remoteRecipientTelegramUserId: "900001" }];
  const db = {
    customOrder: {
      count: async () => 0,
      findMany: async ({ where }) => where.status === "CANCELLED" ? [order] : [],
    },
    customContentSubmission: { count: async () => 0 },
    automationDelivery: { count: async () => 0 },
    telegramDeliveryIntent: {
      count: async () => 0,
      findMany: async ({ where }) => intents.filter((row) => where.customOrderId?.in?.includes(row.customOrderId) && where.kind?.in?.includes(row.kind)),
    },
  };
  const result = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(result.cancelledTelegramFollowupDebt, 1);
  assert.equal(result.total, 1);
});

test("agency lifecycle fence serializes parent retirement with NEW Custom work", async () => {
  let sql = "";
  const db = { $queryRawUnsafe: async (query, id) => { sql = String(query); return [{ id, deletedAt: null, status: "ACTIVE" }]; } };
  const row = await lockAgencyPipelineLifecycle({ db, agencyId: "agency-1" });
  assert.equal(row.id, "agency-1");
  assert.match(sql, /FROM "Agency"[\s\S]*FOR UPDATE/);

  db.$queryRawUnsafe = async (_query, id) => [{ id, deletedAt: new Date(), status: "LOCKED" }];
  await assert.rejects(() => lockAgencyPipelineLifecycle({ db, agencyId: "agency-1" }), (error) => error?.code === "AGENCY_RETIRED" && error?.status === 409);
});

test("creator retirement blocker query ignores terminal delivered history but includes SALVAGE, unassigned ACTIVE, and ACTIVE+PENDING CONTENT", async () => {
  let capturedSubmissionWhere = null;
  const db = {
    customOrder: { count: async () => 0 },
    customContentSubmission: { count: async ({ where }) => { capturedSubmissionWhere = where; return 0; } },
    automationDelivery: { count: async () => 0 },
  };
  const result = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(result.total, 0);
  assert.deepEqual(capturedSubmissionWhere.OR[0], { pipelineDisposition: "SALVAGE" });
  assert.deepEqual(capturedSubmissionWhere.OR[1], { pipelineDisposition: "ACTIVE", customOrderId: null });
  assert.deepEqual(capturedSubmissionWhere.OR[2], {
    pipelineDisposition: "ACTIVE",
    customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
  });
});

test("creator lifecycle fence uses the CreatorAccount row as a serialization lock and rejects retired creators", async () => {
  let sql = "";
  const db = { $queryRawUnsafe: async (query) => { sql = String(query); return [{ id: "creator-1", agencyId: "agency-1", deletedAt: null, status: "READY" }]; } };
  const row = await lockCreatorPipelineLifecycle({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(row.id, "creator-1");
  assert.match(sql, /CreatorAccount[\s\S]*FOR UPDATE/);

  db.$queryRawUnsafe = async () => [{ id: "creator-1", agencyId: "agency-1", deletedAt: new Date(), status: "DISABLED" }];
  await assert.rejects(() => lockCreatorPipelineLifecycle({ db, agencyId: "agency-1", creatorId: "creator-1" }), (error) => error?.code === "CREATOR_RETIRED" && error?.status === 409);
});

test("submission lifecycle fence is the shared serialization boundary for relay reserve and terminal manager resolution", async () => {
  const events = [];
  const db = {
    $transaction: async (work) => work(db),
    $queryRawUnsafe: async (query, id, agencyId) => {
      events.push("lock");
      assert.match(String(query), /CustomContentSubmission[\s\S]*FOR UPDATE/);
      assert.equal(id, "submission-lock");
      assert.equal(agencyId, "agency-1");
      return [{ id }];
    },
    customContentSubmission: {
      findFirst: async () => { events.push("read"); return { id: "submission-lock" }; },
    },
  };
  const result = await withSubmissionPipelineLock({
    db, agencyId: "agency-1", submissionId: "submission-lock",
    work: async () => { events.push("work"); return "ok"; },
  });
  assert.equal(result, "ok");
  assert.deepEqual(events, ["lock", "work"]);
});



test("SALVAGE resolution is fail-closed until confirmed media is safely projected, then retirement blockers converge to zero", async () => {
  const state = {
    submission: {
      id: "submission-salvage", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-cancelled",
      pipelineDisposition: "SALVAGE", ofMediaIds: ["9001", "9002"], executionPinnedAt: null, executionVaultFolderId: null,
    },
    assets: [],
    writes: [],
  };
  const db = {
    customOrder: {
      count: async () => 0,
      findFirst: async ({ where }) => where?.id === state.submission.customOrderId ? { id: state.submission.customOrderId, priceCents: 6000 } : null,
    },
    customContentSubmission: {
      findFirst: async ({ where }) => where.id === state.submission.id && where.agencyId === state.submission.agencyId ? { ...state.submission } : null,
      update: async ({ where, data }) => {
        assert.equal(where.id, state.submission.id);
        Object.assign(state.submission, data);
        return { ...state.submission };
      },
      count: async () => ["SALVAGE", "ACTIVE"].includes(state.submission.pipelineDisposition) ? 1 : 0,
    },
    automationDelivery: {
      updateMany: async ({ where, data }) => {
        let changed = 0;
        for (const write of state.writes) {
          if (where.agencyId && write.agencyId !== where.agencyId) continue;
          if (where.creatorId && write.creatorId !== where.creatorId) continue;
          if (where.actionType && write.actionType !== where.actionType) continue;
          if (where.status?.in && !where.status.in.includes(write.status)) continue;
          if (where.OR && !where.OR.some((entry) => String(write.targetId || '').startsWith(String(entry.targetId?.startsWith || '')))) continue;
          Object.assign(write, data); changed += 1;
        }
        return { count: changed };
      },
      findFirst: async () => state.writes.find((write) => ["QUEUED", "RETRY_SCHEDULED", "CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"].includes(write.status)) || null,
      count: async () => state.writes.filter((write) => ["QUEUED", "RETRY_SCHEDULED", "CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"].includes(write.status)).length,
    },
    creatorMediaAsset: {
      findMany: async ({ where }) => state.assets.filter((asset) => where.mediaId.in.includes(asset.mediaId)),
    },
  };

  const before = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(before.total, 1, "SALVAGE remains a retirement blocker until explicit resolution");

  await assert.rejects(
    () => setUnassignedSubmissionDisposition({ db, agencyId: "agency-1", submissionId: state.submission.id, nextDisposition: "ARCHIVED", reason: "resolved" }),
    (error) => error?.code === "CUSTOM_SUBMISSION_SALVAGE_FINALIZATION_REQUIRED",
  );

  state.assets.push(
    { mediaId: "9001", source: "CUSTOM", customOrderId: state.submission.customOrderId, customSubmissionId: state.submission.id, customFullPriceCents: 6000, catalogActive: true, sortingStatus: "SORTED", folderIds: ["vault-salvage"] },
    { mediaId: "9002", source: "CUSTOM", customOrderId: state.submission.customOrderId, customSubmissionId: state.submission.id, customFullPriceCents: 6000, catalogActive: true, sortingStatus: "SORTED", folderIds: ["vault-salvage"] },
  );
  await assert.rejects(
    () => setUnassignedSubmissionDisposition({ db, agencyId: "agency-1", submissionId: state.submission.id, nextDisposition: "ARCHIVED", reason: "assets alone are not settlement proof" }),
    (error) => error?.code === "CUSTOM_SUBMISSION_SALVAGE_FINALIZATION_REQUIRED",
  );
  await assert.rejects(
    () => setUnassignedSubmissionDisposition({ db, agencyId: "agency-1", submissionId: state.submission.id, nextDisposition: "ABANDONED", reason: "discard confirmed media" }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ABANDON_CONFIRMED_MEDIA_FORBIDDEN",
  );
  state.submission.executionPinnedAt = new Date("2026-09-06T00:00:00Z");
  state.submission.executionVaultFolderId = "vault-salvage";
  state.submission.executionProfileRevision = 1;
  state.submission.vaultSettlementFolderId = "vault-salvage";
  state.submission.vaultSettlementProfileRevision = 1;
  state.submission.vaultSettlementMediaFingerprint = vaultSettlementFingerprint({ folderId: "vault-salvage", profileRevision: 1, mediaIds: state.submission.ofMediaIds });
  state.submission.vaultSettlementConfirmedAt = new Date("2026-09-06T00:01:00Z");
  state.submission.vaultSettlementConfirmedByDeviceId = "device-1";
  const resolved = await setUnassignedSubmissionDisposition({ db, agencyId: "agency-1", submissionId: state.submission.id, nextDisposition: "ARCHIVED", reason: "safe salvage complete" });
  assert.equal(resolved.pipelineDisposition, "ARCHIVED");

  const after = await creatorCustomPipelineBlockers({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(after.total, 0, "terminal resolved content no longer blocks normal creator retirement");
});

test("retired-confirmed ABANDON escape rechecks actual creator retirement and cannot be enabled by caller flag", async () => {
  const row = {
    id: "submission-active-creator", agencyId: "agency-1", creatorId: "creator-1", customOrderId: null,
    pipelineDisposition: "ACTIVE", ofMediaIds: ["99001"],
  };
  const db = {
    customContentSubmission: {
      findFirst: async () => ({ ...row }),
      update: async ({ data }) => { Object.assign(row, data); return { ...row }; },
    },
    automationDelivery: { updateMany: async () => ({ count: 0 }), findFirst: async () => null },
    creatorAccount: { findFirst: async () => ({ id: "creator-1", agencyId: "agency-1", deletedAt: null }) },
    creatorMediaAsset: { findMany: async () => [] },
  };
  await assert.rejects(
    () => setUnassignedSubmissionDisposition({
      db, agencyId: "agency-1", submissionId: row.id, nextDisposition: "ABANDONED",
      reason: "malicious caller attempts retired exception", allowRetiredConfirmedAbandon: true,
    }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ABANDON_CONFIRMED_MEDIA_FORBIDDEN",
  );
  assert.equal(row.pipelineDisposition, "ACTIVE");
});

test("pipeline resolution cannot race past an in-flight CUSTOM_RELAY_SEND", async () => {
  const state = {
    submission: { id: "submission-writing", agencyId: "agency-1", creatorId: "creator-1", customOrderId: null, pipelineDisposition: "ACTIVE", ofMediaIds: [] },
  };
  const db = {
    customContentSubmission: { findFirst: async () => ({ ...state.submission }) },
    automationDelivery: {
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [{ id: "write-1", actionType: "CUSTOM_RELAY_SEND", targetId: "submission-writing:0", status: "COMMITTING", result: null }],
    },
    creatorMediaAsset: { findMany: async () => [] },
  };
  await assert.rejects(
    () => setUnassignedSubmissionDisposition({ db, agencyId: "agency-1", submissionId: state.submission.id, nextDisposition: "ABANDONED", reason: "operator discard" }),
    (error) => error?.code === "CUSTOM_SUBMISSION_EXTERNAL_EFFECT_NOT_CONVERGED",
  );
});



test("Custom cancellation cancels only proven-precommit relay writes and preserves COMMITTING/RECONCILE_REQUIRED for settlement", async () => {
  const submissions = [
    { id: "sub-a", creatorId: "creator-1", pipelineDisposition: "ACTIVE" },
    { id: "sub-b", creatorId: "creator-1", pipelineDisposition: "ACTIVE" },
  ];
  const writes = [
    { id: "w-queued", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", targetId: "sub-a:0", status: "QUEUED", leaseRevision: 1 },
    { id: "w-retry", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", targetId: "sub-a:1", status: "RETRY_SCHEDULED", leaseRevision: 1 },
    { id: "w-claimed", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", targetId: "sub-b:0", status: "CLAIMED", leaseRevision: 2 },
    { id: "w-running", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", targetId: "sub-b:1", status: "RUNNING", leaseRevision: 3 },
    { id: "w-committing", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", targetId: "sub-b:2", status: "COMMITTING", leaseRevision: 4 },
    { id: "w-reconcile", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", targetId: "sub-b:3", status: "RECONCILE_REQUIRED", leaseRevision: 5 },
    { id: "manual-running", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_MANUAL_SEND", targetId: "custom-1", status: "RUNNING", leaseRevision: 1 },
    { id: "manual-committing", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_MANUAL_SEND", targetId: "custom-1", status: "COMMITTING", leaseRevision: 1 },
  ];
  const db = {
    customContentSubmission: {
      findMany: async () => submissions.map((row) => ({ id: row.id, creatorId: row.creatorId })),
      updateMany: async ({ data }) => { for (const row of submissions) Object.assign(row, data); return { count: submissions.length }; },
    },
    automationDelivery: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const write of writes) {
          if (where.agencyId && write.agencyId !== where.agencyId) continue;
          if (where.creatorId && write.creatorId !== where.creatorId) continue;
          if (where.actionType && write.actionType !== where.actionType) continue;
          if (where.status?.in && !where.status.in.includes(write.status)) continue;
          if (typeof where.targetId === "string" && String(write.targetId || "") !== where.targetId) continue;
          if (where.OR && !where.OR.some((entry) => String(write.targetId).startsWith(entry.targetId.startsWith))) continue;
          Object.assign(write, data); count += 1;
        }
        return { count };
      },
    },
  };
  const result = await adjudicateCustomOrderCancellation({ db, agencyId: "agency-1", customOrderId: "custom-1", now: new Date("2026-09-06T01:00:00Z") });
  assert.equal(result.cancelledPrecommitWrites, 5);
  assert.deepEqual(writes.slice(0, 4).map((row) => row.status), ["CANCELED", "CANCELED", "CANCELED", "CANCELED"]);
  assert.equal(writes[4].status, "COMMITTING");
  assert.equal(writes[5].status, "RECONCILE_REQUIRED");
  assert.equal(writes[6].status, "CANCELED", "manual physical send that has not crossed COMMITTING is proven precommit and must be terminalized by cancellation");
  assert.equal(writes[7].status, "COMMITTING", "manual physical send after commit permit must remain for outcome settlement");
  assert.deepEqual(submissions.map((row) => row.pipelineDisposition), ["SALVAGE", "SALVAGE"]);
});

test("unknown pipeline disposition is fail-closed and database-constrained", () => {
  const live = { type: "CONTENT", status: "PENDING", fanDeliveredAt: null };
  const corrupt = { id: "sub-corrupt", pipelineDisposition: "FUTURE_UNKNOWN", telegramMessageIds: [1], ofMediaIds: [] };
  assert.equal(submissionAllowsNewPipelineWork(corrupt, live), false);
  assert.equal(derivePipelineStage({ submission: corrupt, order: live, finalized: false }), "BLOCKED");

  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260906190000_custom_content_pipeline_integrity_closure/migration.sql"), "utf8");
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CustomContentSubmission_pipelineDisposition_check/);
  assert.match(migration, /CHECK \("pipelineDisposition" IN \('ACTIVE', 'SALVAGE', 'ARCHIVED', 'ABANDONED'\)\)/);
  assert.match(migration, /CustomOrder_telegramCancellationWaiver_pair_check/);
  assert.match(migration, /telegramCancellationWaivedAt/);
  assert.match(migration, /telegramCancellationWaiverReason/);
  assert.match(migration, /TelegramDeliveryIntent_kind_check/);
  assert.match(migration, /TelegramDeliveryIntent_state_check/);
  assert.match(migration, /TelegramInboundEvent_projectionState_check/);
  assert.match(migration, /FAILED_PRECOMMIT/);
  assert.match(migration, /FAILED_RETRYABLE/);
  assert.match(migration, /TelegramDeliveryIntent_one_task_per_order_key/);
  assert.match(migration, /WHERE "kind" = 'TASK'/);
  assert.match(migration, /TelegramDeliveryIntent_one_cancellation_per_order_key/);
  assert.match(migration, /WHERE "kind" = 'CANCELLATION'/);
  assert.match(migration, /COMMIT;\s*$/);
});

test("migration archives only fan-delivered history and fail-closes other terminal Customs into SALVAGE", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260906003000_custom_content_pipeline_authority/migration.sql"), "utf8");
  const archiveAt = migration.indexOf("MIGRATION_FAN_DELIVERED");
  const salvageAt = migration.indexOf("MIGRATION_TERMINAL_CUSTOM");
  assert.ok(archiveAt >= 0 && salvageAt > archiveAt, "provider-proven delivery is classified before generic terminal fallback");
  assert.match(migration, /pipelineDisposition"\s*=\s*'ARCHIVED'[\s\S]*fanDeliveredAt" IS NOT NULL/);
  assert.match(migration, /pipelineDisposition"\s*=\s*'SALVAGE'[\s\S]*fanDeliveredAt" IS NULL[\s\S]*status" <> 'PENDING'/);
});

test("pipeline fairness cursor order has matching production indexes", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  assert.match(schema, /CCS_pipeline_fairness_idx/);
  assert.match(schema, /CCS_source_pipeline_fairness_idx/);
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260907003000_custom_content_pipeline_work_discovery_indexes/migration.sql"), "utf8");
  assert.match(migration, /"pipelineLastAttemptAt" ASC NULLS FIRST/);
  assert.match(migration, /"agencyId"[\s\S]*"pipelineDisposition"[\s\S]*"receivedAt"[\s\S]*"createdAt"[\s\S]*"id"/);
  assert.match(migration, /"telegramSourceAccountId"[\s\S]*CCS_source_pipeline_fairness_idx|CCS_source_pipeline_fairness_idx[\s\S]*"telegramSourceAccountId"/);
});

test("Telegram CONFIRMED receipt atomically carries projection-pending retirement debt before derived projection runs", () => {
  const telegramAuthority = fs.readFileSync(path.join(__dirname, "telegram-delivery-authority-service.js"), "utf8");
  const pipelineAuthority = fs.readFileSync(path.join(__dirname, "custom-content-pipeline-authority-service.js"), "utf8");
  assert.match(telegramAuthority, /state:\s*"CONFIRMED"[\s\S]*projectionBlockedCode:\s*"TELEGRAM_CONFIRMED_PROJECTION_PENDING"[\s\S]*projectionBlockedAt:\s*now/);
  assert.match(pipelineAuthority, /state:\s*"CONFIRMED",\s*projectionBlockedAt:\s*\{\s*not:\s*null\s*\}/);
});

test("Vault settlement receipt is durable execution proof in schema/migration, not a second business stage table", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const block = schema.match(/model CustomContentSubmission \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(block, /vaultSettlementFolderId\s+String\?/);
  assert.match(block, /vaultSettlementProfileRevision\s+Int\?/);
  assert.match(block, /vaultSettlementMediaFingerprint\s+String\?/);
  assert.match(block, /vaultSettlementConfirmedAt\s+DateTime\?/);
  assert.match(block, /vaultSettlementConfirmedByDeviceId\s+String\?/);
  assert.doesNotMatch(schema, /model\s+CustomContentPipelineStage/);
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260906003000_custom_content_pipeline_authority/migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN "vaultSettlementMediaFingerprint" TEXT/);
  assert.match(migration, /ADD COLUMN "vaultSettlementConfirmedByDeviceId" TEXT/);
});

test("legacy creator-retirement migration preserves unknown external outcomes and makes historical provider/submission debt explicit", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260906111500_custom_content_legacy_retirement_closure/migration.sql"), "utf8");
  assert.match(migration, /status" IN \('QUEUED', 'RETRY_SCHEDULED', 'CLAIMED', 'RUNNING'\)/);
  assert.doesNotMatch(migration, /status" IN \([^\n]*COMMITTING/);
  assert.doesNotMatch(migration, /status" IN \([^\n]*RECONCILE_REQUIRED/);
  assert.match(migration, /TelegramInboundEvent[\s\S]*projectionState" = 'REVIEW_REQUIRED'[\s\S]*CREATOR_RETIRED_LEGACY/);
  assert.match(migration, /CustomContentSubmission[\s\S]*CUSTOM_SUBMISSION_CREATOR_RETIRED_LEGACY/);
  assert.doesNotMatch(migration, /pipelineDisposition"\s*=\s*'ARCHIVED'/);
  assert.doesNotMatch(migration, /pipelineDisposition"\s*=\s*'ABANDONED'/);
});


test("F45 shared external-effect classifier distinguishes no-retry unknown from proven terminal and completed projection debt", () => {
  const submission = { id: "sub-f45", ofMediaIds: ["9001"] };
  const order = { deliveryMessageIds: ["message-ok"], deliverySentMediaIds: ["9001"] };
  assert.equal(customExternalWriteClassification({
    delivery: { actionType: "CUSTOM_RELAY_SEND", status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" }, submission, order,
  }).state, "OUTCOME_UNRESOLVED");
  assert.equal(customExternalWriteClassification({
    delivery: { actionType: "CUSTOM_RELAY_SEND", status: "FAILED", failureCode: "provider_rejected_no_effect" }, submission, order,
  }).converged, true);
  assert.equal(customExternalWriteClassification({
    delivery: { actionType: "CUSTOM_RELAY_SEND", status: "COMPLETED", result: { mediaId: "9002" } }, submission, order,
  }).state, "COMPLETED_UNPROJECTED");
  assert.equal(customExternalWriteClassification({
    delivery: { actionType: "CUSTOM_RELAY_SEND", status: "COMPLETED", result: { mediaId: "9001" } }, submission, order,
  }).state, "FULLY_CONVERGED");
  assert.equal(customExternalWriteClassification({
    delivery: { actionType: "CUSTOM_MANUAL_SEND", status: "COMPLETED", messageId: "message-ok", result: { mediaIds: ["9001"] } }, submission, order,
  }).state, "FULLY_CONVERGED");
  assert.equal(customExternalWriteClassification({
    delivery: { actionType: "CUSTOM_MANUAL_SEND", status: "COMPLETED", messageId: "message-late", result: { mediaIds: ["9001"] } }, submission, order,
  }).state, "COMPLETED_UNPROJECTED");
});

test("F45 terminal disposition rejects no-retry unknown and completed-but-unprojected external effects", async () => {
  for (const write of [
    { id: "unknown", actionType: "CUSTOM_RELAY_SEND", targetId: "sub-terminal:0", status: "FAILED", failureCode: "outcome_unresolved_do_not_retry", result: null },
    { id: "late-proof", actionType: "CUSTOM_RELAY_SEND", targetId: "sub-terminal:0", status: "COMPLETED", failureCode: null, result: { mediaId: "9991" } },
  ]) {
    const submission = { id: "sub-terminal", agencyId: "agency-1", creatorId: "creator-1", customOrderId: null, pipelineDisposition: "ACTIVE", ofMediaIds: [], telegramMessageIds: [1] };
    const db = {
      customContentSubmission: { findFirst: async () => ({ ...submission }) },
      automationDelivery: { updateMany: async () => ({ count: 0 }), findMany: async () => [{ ...write }] },
    };
    await assert.rejects(
      () => setUnassignedSubmissionDisposition({ db, agencyId: "agency-1", submissionId: submission.id, nextDisposition: "ABANDONED", reason: "resolve" }),
      (error) => error?.code === "CUSTOM_SUBMISSION_EXTERNAL_EFFECT_NOT_CONVERGED",
      write.id,
    );
  }
});

test("F45 ordinary ARCHIVE requires proven media and terminal cross-rewrite is forbidden while same-state retry is idempotent", async () => {
  const sourceOnly = { id: "source-only", agencyId: "agency-1", creatorId: "creator-1", customOrderId: null, pipelineDisposition: "ACTIVE", ofMediaIds: [], telegramMessageIds: [1] };
  const dbSource = {
    customContentSubmission: { findFirst: async () => ({ ...sourceOnly }) },
    automationDelivery: { updateMany: async () => ({ count: 0 }), findMany: async () => [] },
  };
  await assert.rejects(
    () => setUnassignedSubmissionDisposition({ db: dbSource, agencyId: "agency-1", submissionId: sourceOnly.id, nextDisposition: "ARCHIVED", reason: "bad archive" }),
    (error) => error?.code === "CUSTOM_SUBMISSION_ARCHIVE_MEDIA_REQUIRED",
  );

  const terminal = { id: "terminal-sub", agencyId: "agency-1", creatorId: "creator-1", customOrderId: null, pipelineDisposition: "ARCHIVED", ofMediaIds: ["9001"] };
  const dbTerminal = { customContentSubmission: { findFirst: async () => ({ ...terminal }) } };
  const same = await setUnassignedSubmissionDisposition({ db: dbTerminal, agencyId: "agency-1", submissionId: terminal.id, nextDisposition: "ARCHIVED" });
  assert.equal(same.unchanged, true);
  await assert.rejects(
    () => setUnassignedSubmissionDisposition({ db: dbTerminal, agencyId: "agency-1", submissionId: terminal.id, nextDisposition: "ABANDONED", reason: "rewrite" }),
    (error) => error?.code === "CUSTOM_SUBMISSION_DISPOSITION_TERMINAL_REWRITE_FORBIDDEN",
  );
});
