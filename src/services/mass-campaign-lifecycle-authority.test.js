"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return () => { delete require.cache[id]; if (previous) require.cache[id] = previous; };
}
function fresh(request) { const id = require.resolve(request); delete require.cache[id]; return require(request); }
function clone(value) { return value == null ? value : structuredClone(value); }

function matchField(actual, expected) {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected) || expected instanceof Date) return actual === expected;
  if (Object.hasOwn(expected, "in") && !expected.in.includes(actual)) return false;
  if (Object.hasOwn(expected, "notIn") && expected.notIn.includes(actual)) return false;
  if (Object.hasOwn(expected, "not")) {
    if (expected.not === null ? actual == null : actual === expected.not) return false;
  }
  if (Object.hasOwn(expected, "lte")) {
    if (!(actual instanceof Date) || !(actual <= expected.lte)) return false;
  }
  if (Object.hasOwn(expected, "gt")) {
    if (!(actual instanceof Date) || !(actual > expected.gt)) return false;
  }
  return true;
}
function matches(where, row) {
  if (!row) return false;
  if (Array.isArray(where?.AND) && !where.AND.every((part) => matches(part, row))) return false;
  if (Array.isArray(where?.OR) && !where.OR.some((part) => matches(part, row))) return false;
  for (const [key, expected] of Object.entries(where || {})) {
    if (key === "AND" || key === "OR") continue;
    if (!matchField(row[key], expected)) return false;
  }
  return true;
}
function sorted(rows, orderBy) {
  const rules = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const rule of rules) {
      const [key, dir] = Object.entries(rule)[0] || [];
      const av = a?.[key]; const bv = b?.[key];
      const ac = av instanceof Date ? av.getTime() : String(av ?? "");
      const bc = bv instanceof Date ? bv.getTime() : String(bv ?? "");
      if (ac < bc) return dir === "desc" ? 1 : -1;
      if (ac > bc) return dir === "desc" ? -1 : 1;
    }
    return 0;
  });
}
function makeDb(seed = []) {
  const rows = seed.map(clone);
  let seq = rows.length;
  const api = {
    creatorAccount: {
      findFirst: async ({ where }) => where?.id === "creator-a" && where?.agencyId === "agency-a" ? { id: "creator-a", agencyId: "agency-a", remoteId: "of-creator-a", deletedAt: null } : null,
      findMany: async ({ where }) => where?.agencyId === "agency-a" ? [{ id: "creator-a", agencyId: "agency-a", remoteId: "of-creator-a", deletedAt: null }] : [],
    },
    workerDevice: { findFirst: async ({ where }) => ({ id: where.id, agencyId: where.agencyId, userId: where.userId }) },
    auditLog: { create: async ({ data }) => data },
    automationDelivery: {
      findUnique: async ({ where }) => rows.find((row) => Object.entries(where || {}).every(([k, v]) => row[k] === v)) || null,
      findFirst: async ({ where, orderBy }) => sorted(rows.filter((row) => matches(where, row)), orderBy)[0] || null,
      findMany: async ({ where, orderBy, take }) => sorted(rows.filter((row) => matches(where, row)), orderBy).slice(0, take || rows.length),
      count: async ({ where }) => rows.filter((row) => matches(where, row)).length,
      create: async ({ data }) => {
        if (rows.some((row) => row.idempotencyKey === data.idempotencyKey)) { const e = new Error("unique"); e.code = "P2002"; throw e; }
        if (data.actionType === "MASS_QUEUE_CREATE" && data.intentAcknowledgedAt == null && rows.some((row) => row.actionType === "MASS_QUEUE_CREATE" && row.creatorId === data.creatorId && row.intentAcknowledgedAt == null)) { const e = new Error("unique intent"); e.code = "P2002"; throw e; }
        const now = new Date();
        const row = { id: `row-${++seq}`, createdAt: now, updatedAt: now, writeCommitRevision: 0, writeCommitAt: null, leaseRevision: 0, result: {}, ...clone(data) };
        rows.push(row); return row;
      },
      createMany: async ({ data, skipDuplicates }) => {
        let count = 0;
        for (const item of data || []) {
          if (item.idempotencyKey && rows.some((row) => row.idempotencyKey === item.idempotencyKey)) {
            if (skipDuplicates) continue;
            const e = new Error("unique"); e.code = "P2002"; throw e;
          }
          const now = new Date();
          rows.push({ id: `row-${++seq}`, createdAt: now, updatedAt: now, writeCommitRevision: 0, writeCommitAt: null, leaseRevision: 0, result: {}, ...clone(item) });
          count += 1;
        }
        return { count };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of rows) {
          if (!matches(where, row)) continue;
          for (const [key, value] of Object.entries(clone(data || {}))) {
            if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "increment")) row[key] = Number(row[key] || 0) + Number(value.increment || 0);
            else row[key] = value;
          }
          row.updatedAt = new Date(); count += 1;
        }
        return { count };
      },
    },
    $transaction: async (fn) => fn(api),
    $executeRawUnsafe: async () => 1,
  };
  return { db: api, rows };
}

async function withAuthority(seed, run) {
  const fx = makeDb(seed);
  const restores = [];
  try {
    restores.push(cacheModule("../prisma", fx.db));
    restores.push(cacheModule("./team-access-control", { canUsePermission: async () => true }));
    restores.push(cacheModule("./execution-access-fence-service", {
      ExecutionAccessFenceError: class ExecutionAccessFenceError extends Error {},
      assertExecutionAccessFence: async ({ agencyId, userId, memberId, accessEpoch, creatorId }) => ({ member: { id: memberId, agencyId, userId, accessEpoch, assignedCreators: [creatorId] }, accessEpoch }),
    }));
    restores.push(cacheModule("./automation-write-commit-fence-service", { lockAutomationWriteCommitFence: async () => ({ ok: true }) }));
    restores.push(cacheModule("./automation-action-delivery-service", { sweepExpiredAutomationLeases: async () => ({ swept: 0 }) }));
    restores.push(cacheModule("./custom-manual-delivery-authority-service", { assertCustomManualDeliveryCommitCurrent: async () => ({ ok: true }) }));
    restores.push(cacheModule("./custom-content-pipeline-authority-service", {
      lockAgencyPipelineLifecycle: async () => ({ id: "agency-a", deletedAt: null }),
      lockCreatorPipelineLifecycle: async () => ({ id: "creator-a", agencyId: "agency-a", deletedAt: null }),
    }));
    restores.push(cacheModule("./automation-failure-taxonomy", {
      FAILURE_CATEGORIES: { OUTCOME_UNKNOWN_RECONCILE: "OUTCOME_UNKNOWN_RECONCILE", TERMINAL: "TERMINAL", IDEMPOTENT_RETRYABLE: "IDEMPOTENT_RETRYABLE", DEFINITE_NO_WRITE_RETRYABLE: "DEFINITE_NO_WRITE_RETRYABLE" },
      classifyAutomationFailure: ({ provenNoEffect, idempotent, reachedWire }) => provenNoEffect ? "DEFINITE_NO_WRITE_RETRYABLE" : idempotent ? "IDEMPOTENT_RETRYABLE" : reachedWire ? "OUTCOME_UNKNOWN_RECONCILE" : "DEFINITE_NO_WRITE_RETRYABLE",
    }));
    const authority = fresh("./programmatic-of-write-authority-service");
    await run({ ...fx, authority });
  } finally {
    delete require.cache[require.resolve("./programmatic-of-write-authority-service")];
    for (const restore of restores.reverse()) restore();
  }
}

const actor = { agencyId: "agency-a", userId: "user-a", memberId: "member-a", accessEpoch: 9, creatorId: "creator-a" };
const fp = "sha256:mass-payload-a";

test("MASS logical intent is server-canonical across devices and one creator has one unacknowledged D1", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const first = await authority.reserveMassLogicalIntent({ ...actor, deviceId: "device-a", dispatchId: "dispatch-a", payloadFingerprint: fp, payload: { audienceHash: "a", contentHash: "b" } });
    const second = await authority.reserveMassLogicalIntent({ ...actor, deviceId: "device-b", dispatchId: "dispatch-b", payloadFingerprint: fp, payload: { audienceHash: "a", contentHash: "b" } });
    assert.equal(rows.length, 1);
    assert.equal(first.delivery.targetId, "dispatch-a");
    assert.equal(second.delivery.targetId, "dispatch-a");
    assert.equal(second.replay, true);
    assert.equal(second.ownedByThisDevice, false);
    await assert.rejects(
      () => authority.reserveMassLogicalIntent({ ...actor, deviceId: "device-b", dispatchId: "dispatch-c", payloadFingerprint: "sha256:different" }),
      (error) => error?.code === "MASS_INTENT_ACK_REQUIRED",
    );
  });
});

test("MASS queue cancel is transferable across authorized devices but still requires BUSINESS_COMMIT", async () => {
  await withAuthority([], async ({ authority }) => {
    assert.equal(authority.PRODUCT_WRITE_KINDS.MASS_QUEUE_CANCEL.executionKind, "AUTHORIZED_DEVICE");
    assert.equal(authority.PRODUCT_WRITE_KINDS.MASS_QUEUE_CANCEL.writeSemantics, "IDEMPOTENT_WRITE");
    assert.equal(authority.PRODUCT_WRITE_KINDS.MASS_QUEUE_CANCEL.commitClass, "BUSINESS_COMMIT");
  });
});


test("MASS queue cancel wire failure stays idempotent-retryable and another authorized device may take over", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const common = {
      ...actor,
      kind: "MASS_QUEUE_CANCEL",
      idempotencyKey: "mass-cancel:creator-a:queue-77",
      payloadFingerprint: "sha256:cancel-queue-77",
      payload: { queueId: "queue-77" },
      targetId: "queue-77",
    };
    let reserved = await authority.reserveProgrammaticWrite({ ...common, deviceId: "device-a" });
    let started = await authority.startProgrammaticWrite({ ...common, deviceId: "device-a", writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    assert.equal(started.delivery.status, "RUNNING");
    const prepared = await authority.prepareProgrammaticWrite({ ...common, deviceId: "device-a", writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision });
    assert.ok(prepared.writeCommitRevision > 0);
    const failed = await authority.failProgrammaticWrite({ ...common, deviceId: "device-a", writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision, failureCode: "network_lost", error: "lost response", retryAfterMs: 5000, facts: { transportCode: "ECONNRESET" } });
    assert.equal(failed.delivery.status, "RETRY_SCHEDULED");
    assert.equal(failed.reconciliationRequired, false);
    assert.equal(failed.delivery.writeCommitAt, null);

    reserved = await authority.reserveProgrammaticWrite({ ...common, deviceId: "device-b" });
    assert.equal(reserved.delivery.status, "CLAIMED");
    assert.equal(rows[0].claimedByDeviceId, "device-b");
    assert.ok(reserved.lease?.token);
  });
});

test("MASS snapshot fence prevents an older complete provider snapshot from settling a newer queue", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    const afterFence = new Date(Date.parse(fence.fenceAt) + 1000);
    rows.push({
      id: "new-queue", agencyId: actor.agencyId, creatorId: actor.creatorId, actionType: "MASS_QUEUE_CREATE", status: "COMPLETED",
      remoteLifecycleState: "PENDING", remoteTargetId: "queue-new", remoteLifecycleObservedAt: afterFence, remoteSettledAt: null,
      failureCode: null, result: { programmaticWriteKind: "MASS_QUEUE_CREATE", queueId: "queue-new" }, createdAt: afterFence, updatedAt: afterFence,
    });
    const settled = await authority.reconcileMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: fence.snapshotFenceToken });
    assert.equal(settled.settled, 0);
    assert.equal(rows[0].remoteLifecycleState, "PENDING");
    await assert.rejects(
      () => authority.reconcileMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: fence.snapshotFenceToken }),
      (error) => error?.code === "MASS_QUEUE_SNAPSHOT_FENCE_EXPIRED",
    );
  });
});

test("complete provider snapshot reopens a previously SETTLED exact queue and settles exact UNKNOWN absence beside unrelated live queues", async () => {
  const old = new Date(Date.now() - 60_000);
  await withAuthority([
    {
      id: "settled-reappeared", agencyId: actor.agencyId, creatorId: actor.creatorId, actionType: "MASS_PROVIDER_QUEUE_OBSERVED", status: "COMPLETED",
      failureCode: null, remoteLifecycleState: "SETTLED", remoteTargetId: "queue-reappeared", remoteLifecycleObservedAt: old, remoteSettledAt: old,
      result: { outcomeState: "PROVIDER_OBSERVED", queueId: "queue-reappeared" }, createdAt: old, updatedAt: old,
    },
    {
      id: "unknown-exact-absent", agencyId: actor.agencyId, creatorId: actor.creatorId, actionType: "MASS_QUEUE_CREATE", status: "FAILED",
      failureCode: "outcome_unresolved_do_not_retry", remoteLifecycleState: "UNKNOWN", remoteTargetId: "queue-known-absent", remoteLifecycleObservedAt: old, remoteSettledAt: null,
      result: { programmaticWriteKind: "MASS_QUEUE_CREATE", outcomeState: "UNRESOLVED_DO_NOT_RETRY" }, createdAt: old, updatedAt: old,
    },
  ], async ({ authority, rows }) => {
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    const result = await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", queueIds: ["queue-reappeared", "queue-unrelated-live"], snapshotItemCount: 2, snapshotFenceToken: fence.snapshotFenceToken,
    });
    assert.equal(rows.find((row) => row.id === "settled-reappeared").remoteLifecycleState, "PENDING");
    assert.equal(rows.find((row) => row.id === "settled-reappeared").remoteSettledAt, null);
    assert.equal(rows.find((row) => row.id === "unknown-exact-absent").remoteLifecycleState, "SETTLED");
    assert.ok(rows.find((row) => row.id === "unknown-exact-absent").remoteSettledAt instanceof Date);
    assert.ok(result.pending >= 1);
    assert.ok(result.settled >= 1);
  });
});

test("empty fenced snapshot settles only remote UNKNOWN debt and never rewrites unresolved write history as success", async () => {
  const old = new Date(Date.now() - 60_000);
  await withAuthority([{
    id: "unknown-a", agencyId: actor.agencyId, creatorId: actor.creatorId, actionType: "MASS_QUEUE_CREATE", status: "FAILED",
    failureCode: "outcome_unresolved_do_not_retry", remoteLifecycleState: "UNKNOWN", remoteTargetId: null,
    remoteLifecycleObservedAt: old, remoteSettledAt: null, payloadFingerprint: fp, intentAcknowledgedAt: old,
    result: { programmaticWriteKind: "MASS_QUEUE_CREATE", outcomeState: "UNRESOLVED_DO_NOT_RETRY" }, createdAt: old, updatedAt: old,
  }], async ({ authority, rows }) => {
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    const result = await authority.reconcileMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: fence.snapshotFenceToken });
    assert.equal(result.unknown, 0);
    assert.equal(rows[0].status, "FAILED");
    assert.equal(rows[0].failureCode, "outcome_unresolved_do_not_retry");
    assert.equal(rows[0].remoteLifecycleState, "SETTLED");
    assert.ok(rows[0].remoteSettledAt instanceof Date);
  });
});

test("same MASS payload cannot be reminted after unresolved acknowledgement until remote debt is settled", async () => {
  const old = new Date(Date.now() - 60_000);
  const row = {
    id: "unknown-a", agencyId: actor.agencyId, creatorId: actor.creatorId, actionType: "MASS_QUEUE_CREATE", status: "FAILED",
    failureCode: "outcome_unresolved_do_not_retry", remoteLifecycleState: "UNKNOWN", remoteTargetId: null,
    remoteLifecycleObservedAt: old, remoteSettledAt: null, payloadFingerprint: fp, intentAcknowledgedAt: old,
    idempotencyKey: "mass:creator-a:old-dispatch", targetId: "old-dispatch", sourceDeviceId: "device-a",
    result: { programmaticWriteKind: "MASS_QUEUE_CREATE", outcomeState: "UNRESOLVED_DO_NOT_RETRY" }, createdAt: old, updatedAt: old,
  };
  await withAuthority([row], async ({ authority, rows }) => {
    await assert.rejects(
      () => authority.reserveMassLogicalIntent({ ...actor, deviceId: "device-a", dispatchId: "new-dispatch", payloadFingerprint: fp }),
      (error) => error?.code === "MASS_UNRESOLVED_SAME_PAYLOAD",
    );
    rows[0].remoteLifecycleState = "SETTLED";
    rows[0].remoteSettledAt = new Date();
    const allowed = await authority.reserveMassLogicalIntent({ ...actor, deviceId: "device-a", dispatchId: "new-dispatch", payloadFingerprint: fp });
    assert.equal(allowed.delivery.targetId, "new-dispatch");
  });
});

test("MASS retirement blockers release unresolved historical write only after its remote future-effect debt is SETTLED", async () => {
  const service = require("./mass-campaign-authority-service");
  const old = new Date();
  const fx = makeDb([{
    id: "unknown", agencyId: "agency-a", creatorId: "creator-a", actionType: "MASS_QUEUE_CREATE", status: "FAILED", failureCode: "outcome_unresolved_do_not_retry",
    remoteLifecycleState: "UNKNOWN", createdAt: old, updatedAt: old,
  }]);
  let blockers = await service.creatorMassCampaignBlockers({ db: fx.db, agencyId: "agency-a", creatorId: "creator-a" });
  assert.ok(blockers.total > 0);
  fx.rows[0].remoteLifecycleState = "SETTLED";
  blockers = await service.creatorMassCampaignBlockers({ db: fx.db, agencyId: "agency-a", creatorId: "creator-a" });
  assert.equal(blockers.total, 0);
});


test("soft and hard creator removal preserve MASS future-effect authority through canonical lifecycle", () => {
  const root = path.resolve(__dirname, "..");
  const admin = fs.readFileSync(path.join(root, "routes/admin.js"), "utf8");
  const creators = fs.readFileSync(path.join(root, "routes/creators.js"), "utf8");
  const lifecycle = fs.readFileSync(path.join(__dirname, "creator-lifecycle-authority-service.js"), "utf8");
  const agencyHard = admin.slice(admin.indexOf('if (hard) {', admin.indexOf('router.delete("/agencies/:id"')), admin.indexOf('const deletedAt = new Date();', admin.indexOf('router.delete("/agencies/:id"')));
  assert.match(agencyHard, /lockAgencyPipelineLifecycle/);
  assert.match(agencyHard, /assertAgencyCustomPipelineRetirable/);
  assert.match(agencyHard, /assertAgencyMassCampaignRetirable/);
  assert.match(admin, /router\.delete\("\/creators\/:id"[\s\S]*retireCreatorWithinTransaction\(\{/);
  assert.match(creators, /router\.delete\("\/:id"[\s\S]*retireCreatorWithinTransaction\(\{/);
  assert.match(lifecycle, /assertCreatorCustomPipelineRetirable\(\{/);
  assert.match(lifecycle, /assertCreatorMassCampaignRetirable\(\{[\s\S]*requireFreshProviderSnapshot/);
  assert.match(admin, /if \(err\?\.status && err\?\.code\)[\s\S]*Agency removal is blocked/);
});



test("native MASS create is COMMITTING before browser wire and exact 2xx queueId becomes remote PENDING", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const permit = await authority.authorizeNativeMassWrite({
      ...actor, deviceId: "device-a", operation: "CREATE", requestKey: "wc:77:req:991",
    });
    assert.equal(permit.authorityVersion, "MASS_NATIVE_V3");
    assert.equal(permit.kind, "MASS_NATIVE_QUEUE_CREATE");
    assert.ok(permit.writeCommitRevision > 0);
    const row = rows.find((item) => item.id === permit.writeId);
    assert.equal(row.status, "COMMITTING");
    assert.ok(row.writeCommitAt instanceof Date);

    const blockersBeforeResponse = await require("./mass-campaign-authority-service").creatorMassCampaignBlockers({
      db: makeDb(rows).db, agencyId: actor.agencyId, creatorId: actor.creatorId,
    });
    assert.ok(blockersBeforeResponse.total > 0);

    const settled = await authority.completeNativeMassWrite({
      agencyId: actor.agencyId, userId: actor.userId, creatorId: actor.creatorId, deviceId: "device-a",
      writeId: permit.writeId, requestKey: "wc:77:req:991", queueId: "queue-native-1", writeCommitRevision: permit.writeCommitRevision,
    });
    assert.equal(settled.delivery.status, "COMPLETED");
    assert.equal(row.remoteLifecycleState, "PENDING");
    assert.equal(row.remoteTargetId, "queue-native-1");
  });
});

test("native MASS exact 2xx is durably replayable from request-bound Team telemetry", async () => {
  await withAuthority([], async ({ authority, rows, db }) => {
    const permit = await authority.authorizeNativeMassWrite({
      ...actor, deviceId: "device-a", operation: "CREATE", requestKey: "wc:91:req:12",
    });
    assert.equal(permit.actorAgencyId, actor.agencyId);
    assert.equal(permit.actorMemberId, actor.memberId);
    assert.equal(permit.actorUserId, actor.userId);
    const row = rows.find((item) => item.id === permit.writeId);
    assert.equal(row.status, "COMMITTING");

    const settled = await authority.projectNativeMassWriteFromTeamEvent({
      eventKind: "BROADCAST_DISPATCH_CONFIRMED",
      actionSource: "BROADCAST",
      lifecycle: "CONFIRMED",
      agencyId: actor.agencyId,
      userId: actor.userId,
      memberId: actor.memberId,
      creatorId: actor.creatorId,
      deviceId: "device-a",
      broadcastDispatchId: "queue-native-durable-1",
      extra: { metadata: { massNative: {
        authorityVersion: "MASS_NATIVE_V2",
        kind: "MASS_NATIVE_QUEUE_CREATE",
        writeId: permit.writeId,
        requestKey: "wc:91:req:12",
        writeCommitRevision: permit.writeCommitRevision,
      } } },
    }, { db });
    assert.equal(settled.delivery.status, "COMPLETED");
    assert.equal(row.remoteLifecycleState, "PENDING");
    assert.equal(row.remoteTargetId, "queue-native-durable-1");

    const duplicate = await authority.projectNativeMassWriteFromTeamEvent({
      eventKind: "BROADCAST_DISPATCH_CONFIRMED", actionSource: "BROADCAST", lifecycle: "CONFIRMED",
      agencyId: actor.agencyId, userId: actor.userId, memberId: actor.memberId, creatorId: actor.creatorId, deviceId: "device-a",
      broadcastDispatchId: "queue-native-durable-1",
      extra: { metadata: { massNative: { authorityVersion: "MASS_NATIVE_V3", kind: "MASS_NATIVE_QUEUE_CREATE", writeId: permit.writeId, requestKey: "wc:91:req:12", writeCommitRevision: permit.writeCommitRevision } } },
    }, { db });
    assert.equal(duplicate.duplicate, true);
  });
});

test("stable fenced provider absence proves desired-state completion for an unresolved native MASS cancel", async () => {
  const old = new Date(Date.now() - 120_000);
  await withAuthority([{
    id: "native-cancel-unknown", agencyId: actor.agencyId, creatorId: actor.creatorId, actionType: "MASS_NATIVE_QUEUE_CANCEL",
    status: "FAILED", failureCode: "outcome_unresolved_do_not_retry", failureCategory: "OUTCOME_UNKNOWN_RECONCILE",
    targetId: "queue-native-2", remoteTargetId: "queue-native-2", remoteLifecycleState: null,
    writeCommitAt: old, writeCommitRevision: 1, sourceDeviceId: "device-a", createdByUserId: actor.userId,
    payload: { nativeRequestKey: "wc:8:req:2", nativeOperation: "CANCEL", nativeQueueId: "queue-native-2" },
    result: { programmaticWriteKind: "MASS_NATIVE_QUEUE_CANCEL", outcomeState: "UNRESOLVED_DO_NOT_RETRY" },
    createdAt: old, updatedAt: old,
  }], async ({ authority, rows }) => {
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    const reconciled = await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: fence.snapshotFenceToken,
    });
    assert.equal(reconciled.cancelSettled, 1);
    assert.equal(rows[0].status, "COMPLETED");
    assert.equal(rows[0].remoteLifecycleState, "SETTLED");
    assert.ok(rows[0].remoteSettledAt instanceof Date);
  });
});

test("terminal pre-wire MASS rejection is acknowledgeable and never deadlocks the next logical intent", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const reserved = await authority.reserveMassLogicalIntent({ ...actor, deviceId: "device-a", dispatchId: "dispatch-rejected", payloadFingerprint: fp });
    const row = rows.find((item) => item.id === reserved.delivery.id);
    row.status = "FAILED";
    row.failureCode = "custom_media_programmatic_forbidden";
    row.failureCategory = "TERMINAL";
    row.finishedAt = new Date();
    row.result = { ...row.result, outcomeState: "PROVEN_NO_EFFECT" };
    const current = await authority.getCurrentMassLogicalIntent({ ...actor, deviceId: "device-a" });
    assert.equal(current.terminalOutcome, "PROVEN_NO_EFFECT");
    const acknowledged = await authority.acknowledgeMassLogicalIntent({ ...actor, deviceId: "device-a", dispatchId: "dispatch-rejected" });
    assert.equal(acknowledged.terminalOutcome, "PROVEN_NO_EFFECT");
    const next = await authority.reserveMassLogicalIntent({ ...actor, deviceId: "device-a", dispatchId: "dispatch-next", payloadFingerprint: "sha256:next" });
    assert.equal(next.delivery.targetId, "dispatch-next");
  });
});

test("provider snapshot refuses identity-incomplete rows before absence can settle anything", async () => {
  const old = new Date(Date.now() - 60_000);
  await withAuthority([{
    id: "known", agencyId: actor.agencyId, creatorId: actor.creatorId, actionType: "MASS_QUEUE_CREATE", status: "COMPLETED",
    remoteLifecycleState: "PENDING", remoteTargetId: "queue-known", remoteLifecycleObservedAt: old, remoteSettledAt: null,
    createdAt: old, updatedAt: old,
  }], async ({ authority, rows }) => {
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    await assert.rejects(
      () => authority.reconcileMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", queueIds: [], snapshotItemCount: 1, snapshotFenceToken: fence.snapshotFenceToken }),
      (error) => error?.code === "MASS_QUEUE_SNAPSHOT_IDENTITY_INCOMPLETE",
    );
    assert.equal(rows[0].remoteLifecycleState, "PENDING");
  });
});

test("provider-observed orphan queue becomes a durable retirement blocker until a later complete snapshot proves absence", async () => {
  await withAuthority([], async ({ authority, rows, db }) => {
    const firstFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    await authority.reconcileMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", queueIds: ["manual-queue-1"], snapshotItemCount: 1, snapshotFenceToken: firstFence.snapshotFenceToken });
    const observed = rows.find((row) => row.actionType === "MASS_PROVIDER_QUEUE_OBSERVED" && row.remoteTargetId === "manual-queue-1");
    assert.ok(observed);
    assert.equal(observed.remoteLifecycleState, "PENDING");
    let blockers = await require("./mass-campaign-authority-service").creatorMassCampaignBlockers({ db, agencyId: actor.agencyId, creatorId: actor.creatorId });
    assert.ok(blockers.total > 0);

    observed.remoteLifecycleObservedAt = new Date(Date.now() - 1000);
    const secondFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    await authority.reconcileMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: secondFence.snapshotFenceToken });
    assert.equal(observed.remoteLifecycleState, "SETTLED");
    blockers = await require("./mass-campaign-authority-service").creatorMassCampaignBlockers({ db, agencyId: actor.agencyId, creatorId: actor.creatorId });
    assert.equal(blockers.total, 0);
  });
});


test("creator retirement is fail-closed without a fresh provider snapshot proof, and RETIREMENT observation creates it", async () => {
  const empty = makeDb([]);
  const massAuthority = fresh("./mass-campaign-authority-service");
  await assert.rejects(
    () => massAuthority.assertCreatorMassCampaignRetirable({ db: empty.db, agencyId: actor.agencyId, creatorId: actor.creatorId }),
    (error) => error?.code === "CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED",
  );

  await withAuthority([], async ({ authority, rows, db }) => {
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "RETIREMENT" });
    assert.equal(fence.purpose, "RETIREMENT");
    const result = await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "RETIREMENT", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: fence.snapshotFenceToken,
    });
    assert.equal(result.purpose, "RETIREMENT");
    const proof = rows.find((row) => row.actionType === "MASS_PROVIDER_SNAPSHOT_PROOF");
    assert.ok(proof);
    assert.equal(proof.status, "COMPLETED");
    assert.equal(proof.result.outcomeState, "PROVIDER_SNAPSHOT_PROVEN");
    assert.equal(proof.result.purpose, "RETIREMENT");
    const blockers = await massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId });
    assert.equal(blockers.total, 0);
    assert.ok(blockers.providerSnapshotObservedAt instanceof Date);
  });
});

test("retirement proof is state-versioned: a later BROWSE reconciliation invalidates an older destructive snapshot", async () => {
  await withAuthority([], async ({ authority, rows, db }) => {
    const massAuthority = fresh("./mass-campaign-authority-service");
    const retirementFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "RETIREMENT" });
    await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "RETIREMENT", queueIds: ["queue-before"], snapshotItemCount: 1, snapshotFenceToken: retirementFence.snapshotFenceToken,
    });
    const observed = rows.find((row) => row.actionType === "MASS_PROVIDER_QUEUE_OBSERVED" && row.remoteTargetId === "queue-before");
    assert.ok(observed);
    await assert.rejects(
      () => massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId }),
      (error) => error?.code === "CREATOR_HAS_ACTIVE_MASS",
    );

    observed.remoteLifecycleObservedAt = new Date(Date.now() - 1000);
    const browseFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "BROWSE" });
    await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "BROWSE", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: browseFence.snapshotFenceToken,
    });
    assert.equal(observed.remoteLifecycleState, "SETTLED");
    await assert.rejects(
      () => massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId }),
      (error) => error?.code === "CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED",
      "an older RETIREMENT proof must not be reused after a newer BROWSE changes provider lifecycle state",
    );

    const freshFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "RETIREMENT" });
    await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "RETIREMENT", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: freshFence.snapshotFenceToken,
    });
    assert.equal((await massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId })).total, 0);
    assert.equal((await massAuthority.assertAgencyMassCampaignRetirable({ db, agencyId: actor.agencyId })).total, 0);
  });
});

test("retirement proof is stale after a later physical MASS commit even when blockers have already converged", async () => {
  await withAuthority([], async ({ authority, rows, db }) => {
    const massAuthority = fresh("./mass-campaign-authority-service");
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "RETIREMENT" });
    await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "RETIREMENT", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: fence.snapshotFenceToken,
    });
    const proof = rows.find((row) => row.actionType === "MASS_PROVIDER_SNAPSHOT_PROOF" && row.result?.purpose === "RETIREMENT");
    assert.ok(proof);
    rows.push({
      id: "later-cancel", agencyId: actor.agencyId, creatorId: actor.creatorId, moduleKey: "mass", actionType: "MASS_NATIVE_QUEUE_CANCEL",
      status: "COMPLETED", idempotencyKey: "later-cancel-key", result: { outcomeState: "PROVEN_SUCCESS" },
      writeCommitAt: new Date(proof.remoteLifecycleObservedAt.getTime() + 10), remoteLifecycleObservedAt: new Date(proof.remoteLifecycleObservedAt.getTime() + 10),
      remoteLifecycleState: "SETTLED", remoteSettledAt: new Date(proof.remoteLifecycleObservedAt.getTime() + 10), createdAt: new Date(), updatedAt: new Date(),
    });
    await assert.rejects(
      () => massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId }),
      (error) => error?.code === "CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED",
    );
    await assert.rejects(
      () => massAuthority.assertAgencyMassCampaignRetirable({ db, agencyId: actor.agencyId }),
      (error) => error?.code === "AGENCY_MASS_PROVIDER_SNAPSHOT_REQUIRED",
    );
  });
});

test("retirement proof invalidation is explicit and does not rely on timestamp ordering", async () => {
  await withAuthority([], async ({ authority, rows, db }) => {
    const massAuthority = fresh("./mass-campaign-authority-service");
    const retirementFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "RETIREMENT" });
    await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "RETIREMENT", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: retirementFence.snapshotFenceToken,
    });
    const retirementProof = rows.find((row) => row.actionType === "MASS_PROVIDER_SNAPSHOT_PROOF" && row.result?.purpose === "RETIREMENT");
    assert.ok(retirementProof);
    const proofAt = retirementProof.remoteLifecycleObservedAt;
    assert.equal(retirementProof.status, "COMPLETED");

    // Force the subsequent BROWSE to share the exact same observed timestamp in
    // the in-memory fixture. Correctness must come from explicit proof
    // invalidation, never Date > proofAt ordering.
    const RealDate = Date;
    global.Date = class FrozenDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [proofAt.getTime()])); }
      static now() { return proofAt.getTime(); }
    };
    try {
      const browseFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "BROWSE" });
      await authority.reconcileMassRemoteQueueSnapshot({
        ...actor, deviceId: "device-a", purpose: "BROWSE", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: browseFence.snapshotFenceToken,
      });
    } finally {
      global.Date = RealDate;
    }

    assert.equal(retirementProof.status, "CANCELED");
    assert.equal(retirementProof.failureCode, "mass_provider_snapshot_stale");
    await assert.rejects(
      () => massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId }),
      (error) => error?.code === "CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED",
    );
  });
});

test("new MASS external-work authority explicitly invalidates a fresh retirement proof before it can reach wire", async () => {
  await withAuthority([], async ({ authority, rows, db }) => {
    const massAuthority = fresh("./mass-campaign-authority-service");
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "RETIREMENT" });
    await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "RETIREMENT", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: fence.snapshotFenceToken,
    });
    const proof = rows.find((row) => row.actionType === "MASS_PROVIDER_SNAPSHOT_PROOF" && row.result?.purpose === "RETIREMENT");
    assert.ok(proof);
    assert.equal((await massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId })).total, 0);

    await authority.reserveProgrammaticWrite({
      ...actor, deviceId: "device-a", kind: "MASS_QUEUE_CANCEL",
      idempotencyKey: "mass-cancel:creator-a:after-proof", payloadFingerprint: "sha256:after-proof",
      payload: { queueId: "queue-after-proof" }, targetId: "queue-after-proof",
    });
    assert.equal(proof.status, "CANCELED");
    assert.equal(proof.failureCode, "mass_provider_snapshot_stale");
    await assert.rejects(
      () => massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId }),
      (error) => error?.code === "CREATOR_HAS_ACTIVE_MASS" || error?.code === "CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED",
    );
  });
});

test("never-connected creator without immutable provider identity does not require an impossible queue snapshot", async () => {
  const fx = makeDb([]);
  fx.db.creatorAccount.findFirst = async () => ({ id: actor.creatorId, agencyId: actor.agencyId, remoteId: null, deletedAt: null });
  const massAuthority = fresh("./mass-campaign-authority-service");
  const result = await massAuthority.assertCreatorMassCampaignRetirable({ db: fx.db, agencyId: actor.agencyId, creatorId: actor.creatorId });
  assert.equal(result.total, 0);
  assert.equal(result.providerSnapshotObservedAt, undefined);
});

test("snapshot fence is purpose-bound so BROWSE proof cannot be reconciled as RETIREMENT", async () => {
  await withAuthority([], async ({ authority }) => {
    const fence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "BROWSE" });
    await assert.rejects(
      () => authority.reconcileMassRemoteQueueSnapshot({
        ...actor, deviceId: "device-a", purpose: "RETIREMENT", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: fence.snapshotFenceToken,
      }),
      (error) => error?.code === "MASS_QUEUE_SNAPSHOT_FENCE_MISMATCH",
    );
  });
});

test("fresh BROWSE snapshot proof never satisfies creator or agency retirement authority", async () => {
  await withAuthority([], async ({ authority, rows, db }) => {
    const browseFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "BROWSE" });
    await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "BROWSE", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: browseFence.snapshotFenceToken,
    });
    const browseProof = rows.find((row) => row.actionType === "MASS_PROVIDER_SNAPSHOT_PROOF" && row.result?.purpose === "BROWSE");
    assert.ok(browseProof);
    assert.match(String(browseProof.idempotencyKey || ""), /:BROWSE$/);

    const massAuthority = fresh("./mass-campaign-authority-service");
    await assert.rejects(
      () => massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId }),
      (error) => error?.code === "CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED",
    );
    await assert.rejects(
      () => massAuthority.assertAgencyMassCampaignRetirable({ db, agencyId: actor.agencyId }),
      (error) => error?.code === "AGENCY_MASS_PROVIDER_SNAPSHOT_REQUIRED",
    );

    const retirementFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a", purpose: "RETIREMENT" });
    await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", purpose: "RETIREMENT", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: retirementFence.snapshotFenceToken,
    });
    const retirementProof = rows.find((row) => row.actionType === "MASS_PROVIDER_SNAPSHOT_PROOF" && row.result?.purpose === "RETIREMENT");
    assert.ok(retirementProof);
    assert.match(String(retirementProof.idempotencyKey || ""), /:RETIREMENT$/);
    assert.notEqual(retirementProof.id, browseProof.id);
    assert.equal((await massAuthority.assertCreatorMassCampaignRetirable({ db, agencyId: actor.agencyId, creatorId: actor.creatorId })).total, 0);
    assert.equal((await massAuthority.assertAgencyMassCampaignRetirable({ db, agencyId: actor.agencyId })).total, 0);
  });
});

test("native MASS settlement capability survives current member/auth lifecycle changes", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const permit = await authority.authorizeNativeMassWrite({ ...actor, deviceId: "device-a", operation: "CREATE", requestKey: "wc:cap:req" });
    assert.equal(permit.authorityVersion, "MASS_NATIVE_V3");
    assert.ok(permit.settlementToken);
    const settled = await authority.completeNativeMassWriteWithSettlementToken({
      writeId: permit.writeId, settlementToken: permit.settlementToken, deviceId: "device-a", requestKey: "wc:cap:req",
      queueId: "queue-cap-1", writeCommitRevision: permit.writeCommitRevision, expectedKind: "MASS_NATIVE_QUEUE_CREATE",
    });
    assert.equal(settled.delivery.status, "COMPLETED");
    const row = rows.find((item) => item.id === permit.writeId);
    assert.equal(row.remoteTargetId, "queue-cap-1");
  });
});

test("explicit MASS_NATIVE_V2 preflight remains rolling-compatible and duplicate grant recovery stays V2", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const input = { ...actor, deviceId: "device-a", authorityVersion: "MASS_NATIVE_V2", operation: "CREATE", requestKey: "wc:v2:req" };
    const first = await authority.authorizeNativeMassWrite(input);
    assert.equal(first.authorityVersion, "MASS_NATIVE_V2");
    assert.equal(first.settlementToken, undefined);
    const duplicate = await authority.authorizeNativeMassWrite(input);
    assert.equal(duplicate.authorityVersion, "MASS_NATIVE_V2");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.writeId, first.writeId);
    assert.equal(duplicate.settlementToken, undefined);
    const settled = await authority.completeNativeMassWrite({
      ...actor, deviceId: "device-a", writeId: first.writeId, requestKey: input.requestKey, queueId: "queue-v2-1",
      writeCommitRevision: first.writeCommitRevision, expectedKind: "MASS_NATIVE_QUEUE_CREATE",
    });
    assert.equal(settled.delivery.status, "COMPLETED");
    assert.equal(rows.find((row) => row.id === first.writeId)?.remoteTargetId, "queue-v2-1");
  });
});

test("MASS lifecycle migration adds canonical logical/remote facts and unique current-intent authority", () => {
  const root = path.resolve(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260907013000_mass_campaign_lifecycle_authority/migration.sql"), "utf8");
  assert.match(schema, /intentAcknowledgedAt\s+DateTime\?/);
  assert.match(schema, /remoteLifecycleState\s+String\?/);
  assert.match(schema, /remoteTargetId\s+String\?/);
  assert.match(migration, /AutomationDelivery_mass_unack_intent_unique/);
  assert.match(migration, /MIGRATION_RECONCILE_REQUIRED/);
  assert.match(migration, /"status" IN \('COMMITTING','RECONCILE_REQUIRED'\)[\s\S]*THEN 'UNKNOWN'/);
  const remoteCase = migration.slice(migration.indexOf('SET "remoteTargetId"'), migration.indexOf("WHERE \"actionType\" = 'MASS_QUEUE_CREATE';", migration.indexOf('SET "remoteTargetId"')));
  assert.ok(remoteCase.indexOf("'COMMITTING'") < remoteCase.lastIndexOf("ELSE 'PRECOMMIT'"), 'historical COMMITTING must be classified before PRECOMMIT fallback');
});

test("provider-observed reconciliation handles multi-page-scale snapshots without one giant SQL identity predicate", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const queueIds = Array.from({ length: 1201 }, (_, index) => `provider-q-${String(index).padStart(4, "0")}`);
    const firstFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    const first = await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", queueIds, snapshotItemCount: queueIds.length, snapshotFenceToken: firstFence.snapshotFenceToken,
    });
    assert.equal(first.liveQueueIds.length, 1201);
    assert.equal(first.pending, 1201);
    assert.equal(rows.filter((row) => row.actionType === "MASS_PROVIDER_QUEUE_OBSERVED" && row.remoteLifecycleState === "PENDING").length, 1201);

    const secondFence = await authority.beginMassRemoteQueueSnapshot({ ...actor, deviceId: "device-a" });
    const second = await authority.reconcileMassRemoteQueueSnapshot({
      ...actor, deviceId: "device-a", queueIds: [], snapshotItemCount: 0, snapshotFenceToken: secondFence.snapshotFenceToken,
    });
    assert.equal(second.pending, 0);
    assert.equal(rows.filter((row) => row.actionType === "MASS_PROVIDER_QUEUE_OBSERVED" && row.remoteLifecycleState !== "SETTLED").length, 0);
  });
});



test("native MASS exact provider rejection terminalizes the request without future-effect debt", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const permit = await authority.authorizeNativeMassWrite({ ...actor, deviceId: "device-a", operation: "CREATE", requestKey: "wc:reject:req" });
    assert.equal(permit.authorityVersion, "MASS_NATIVE_V3");
    const settled = await authority.settleNativeMassWriteProvenNoEffect({
      writeId: permit.writeId, settlementToken: permit.settlementToken, deviceId: "device-a", requestKey: "wc:reject:req",
      writeCommitRevision: permit.writeCommitRevision, providerStatus: 422,
    });
    assert.equal(settled.provenNoEffect, true);
    const row = rows.find((item) => item.id === permit.writeId);
    assert.equal(row.status, "FAILED");
    assert.equal(row.failureCode, "provider_rejected_no_effect");
    assert.equal(row.result.outcomeState, "PROVEN_NO_EFFECT");
    assert.equal(row.writeCommitAt, null);
  });
});


test("native MASS rejection settlement is replay-idempotent and refuses ambiguous HTTP status", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const permit = await authority.authorizeNativeMassWrite({ ...actor, deviceId: "device-a", operation: "CREATE", requestKey: "wc:reject:replay" });
    const input = { writeId: permit.writeId, settlementToken: permit.settlementToken, deviceId: "device-a", requestKey: "wc:reject:replay", writeCommitRevision: permit.writeCommitRevision };
    await assert.rejects(() => authority.settleNativeMassWriteProvenNoEffect({ ...input, providerStatus: 409 }), (error) => error?.code === "MASS_NATIVE_REJECTION_STATUS_AMBIGUOUS");
    const first = await authority.settleNativeMassWriteProvenNoEffect({ ...input, providerStatus: 422 });
    assert.equal(first.provenNoEffect, true);
    assert.equal(rows.find((row) => row.id === permit.writeId)?.writeCommitAt, null);
    const replay = await authority.settleNativeMassWriteProvenNoEffect({ ...input, providerStatus: 422 });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.provenNoEffect, true);
  });
});

test("overlapping duplicate native preflight grants never invalidate an earlier issued settlement capability", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const input = { ...actor, deviceId: "device-a", operation: "CREATE", requestKey: "wc:overlap:req:1" };
    const grants = [];
    for (let index = 0; index < 8; index += 1) grants.push(await authority.authorizeNativeMassWrite(input));
    const first = grants[0];
    assert.ok(grants.every((grant) => grant.writeId === first.writeId));
    assert.equal(new Set(grants.map((grant) => grant.settlementToken)).size, grants.length);
    assert.equal(rows[0].result.nativeSettlementTokenHashes.length, grants.length);
    const settled = await authority.completeNativeMassWriteWithSettlementToken({
      settlementToken: first.settlementToken, writeId: first.writeId, deviceId: "device-a", requestKey: input.requestKey,
      queueId: "provider-overlap-q", writeCommitRevision: first.writeCommitRevision, expectedKind: "MASS_NATIVE_QUEUE_CREATE",
    });
    assert.equal(settled.ok, true);
    assert.equal(rows[0].remoteTargetId, "provider-overlap-q");
  });
});
