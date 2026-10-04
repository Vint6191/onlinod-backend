"use strict";
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");


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
    $transaction: async (fn) => fn({ ...(api), $transaction: undefined }),
    $executeRawUnsafe: async () => 1,
  };
  return { db: commitDatabaseFixture(api), rows };
}

async function withAuthority(seed, run) {
  const fx = makeDb(seed);
  const restores = [];
  try {
    restores.push(cacheModule("../prisma", fx.db));
    restores.push(cacheModule("./billing-write-admission-service", { lockBillingWriteAdmission: async () => {}, assertBillingWriteAdmission: async () => ({ now: new Date() }) }));
    restores.push(cacheModule("./mass-delivery-scope-service", { isMass: kind => /MASS_/.test(kind), lockMassDeliveryScope: async () => {}, assertMassCreateAdmission: async () => {} }));
    restores.push(cacheModule("./mass-campaign-authority-service", { creatorMassCampaignBlockers: async () => ({ total: fx.rows.filter(require("./mass-delivery-contract").hasMassCurrentDebt).length }) }));
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
      db: commitDatabaseFixture(makeDb(rows).db), agencyId: actor.agencyId, creatorId: actor.creatorId,
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
    }, { db: commitDatabaseFixture(db) });
    assert.equal(settled.delivery.status, "COMPLETED");
    assert.equal(row.remoteLifecycleState, "PENDING");
    assert.equal(row.remoteTargetId, "queue-native-durable-1");

    const duplicate = await authority.projectNativeMassWriteFromTeamEvent({
      eventKind: "BROADCAST_DISPATCH_CONFIRMED", actionSource: "BROADCAST", lifecycle: "CONFIRMED",
      agencyId: actor.agencyId, userId: actor.userId, memberId: actor.memberId, creatorId: actor.creatorId, deviceId: "device-a",
      broadcastDispatchId: "queue-native-durable-1",
      extra: { metadata: { massNative: { authorityVersion: "MASS_NATIVE_V3", kind: "MASS_NATIVE_QUEUE_CREATE", writeId: permit.writeId, requestKey: "wc:91:req:12", writeCommitRevision: permit.writeCommitRevision } } },
    }, { db: commitDatabaseFixture(db) });
    assert.equal(duplicate.duplicate, true);
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

test("programmatic MASS prepare grants a revision-bound receipt capability before wire, without minting on duplicate", async () => {
  await withAuthority([], async ({ authority, rows }) => {
    const common = { ...actor, deviceId: "device-a", kind: "MASS_QUEUE_CANCEL", idempotencyKey: "mass-cancel:creator-a:queue", payloadFingerprint: "sha256:receipt", targetId: "queue", payload: { queueId: "queue" } };
    const reserved = await authority.reserveProgrammaticWrite(common);
    const leased = { ...common, writeId: reserved.delivery.id, leaseToken: reserved.lease.token, leaseRevision: reserved.lease.revision };
    await authority.startProgrammaticWrite(leased);
    const prepared = await authority.prepareProgrammaticWrite(leased);
    assert.ok(prepared.settlementToken);
    assert.equal(rows[0].result.massSettlementTokenHash, require("node:crypto").createHash("sha256").update(prepared.settlementToken).digest("hex"));
    assert.equal(rows[0].result.massSettlementDeviceId, "device-a");
    assert.equal((await authority.prepareProgrammaticWrite(leased)).settlementToken, undefined);
  });
});
