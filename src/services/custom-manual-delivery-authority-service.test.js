"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return () => { delete require.cache[id]; if (previous) require.cache[id] = previous; };
}
function fresh(request) { const id = require.resolve(request); delete require.cache[id]; return require(request); }
function uniqueMediaIds(values) { return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]; }
function paymentSnapshot(total, paid) {
  const totalPriceCents = Math.max(0, Number(total || 0));
  const paidAmountCents = Math.max(0, Number(paid || 0));
  return { totalPriceCents, paidAmountCents, remainingAmountCents: Math.max(totalPriceCents - paidAmountCents, 0), paymentStatus: paidAmountCents >= totalPriceCents ? "PAID_IN_FULL" : "PARTIAL" };
}

async function withService({ preflight, isReady = () => true } = {}, run) {
  const restores = [];
  try {
    restores.push(cacheModule("../prisma", {}));
    restores.push(cacheModule("./custom-content-library-service", { uniqueMediaIds }));
    restores.push(cacheModule("./custom-content-delivery-service", {
      preflightCustomManualSend: preflight || (async () => ({ matched: false, allow: false, code: "NO_MATCH" })),
      loadAssets: async () => new Map(),
      isReady,
    }));
    restores.push(cacheModule("./custom-orders-service", { paymentSnapshot }));
    restores.push(cacheModule("./programmatic-of-write-authority-service", {
      reserveProgrammaticWrite: async () => { throw new Error("inject authority"); },
      startProgrammaticWrite: async () => { throw new Error("inject authority"); },
      prepareProgrammaticWrite: async () => { throw new Error("inject authority"); },
      failProgrammaticWrite: async () => { throw new Error("inject authority"); },
      sweepExpiredProgrammaticWriteLeases: async () => {},
    }));
    restores.push(cacheModule("./team-access-control", { canUsePermission: async () => true }));
    restores.push(cacheModule("../middleware/automation-permissions", { allowedCreatorScope: async () => ({ broad: true, creatorIds: [] }) }));
    const service = fresh("./custom-manual-delivery-authority-service");
    await run(service);
  } finally {
    delete require.cache[require.resolve("./custom-manual-delivery-authority-service")];
    for (const restore of restores.reverse()) restore();
  }
}

const member = { id: "member-1", userId: "user-1" };
const readyItem = {
  customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777",
  deliveryMessageIds: [], deliveryPriceCents: 2000,
};

test("Custom manual authority derives one deterministic server-visible phase key and binds exact physical semantics", async () => {
  const calls = [];
  await withService({
    preflight: async () => ({ matched: true, allow: true, item: readyItem, attemptedCustomMediaIds: ["9002", "9001"] }),
  }, async ({ prepareCustomManualDeliveryCommit }) => {
    const authority = {
      reserveProgrammaticWrite: async (input) => { calls.push(["reserve", input]); return { lease: { token: "lease-token", revision: 3 }, delivery: { id: "write-1", status: "CLAIMED" } }; },
      startProgrammaticWrite: async (input) => { calls.push(["start", input]); return { delivery: { id: "write-1", status: "RUNNING" } }; },
      prepareProgrammaticWrite: async (input) => { calls.push(["prepare", input]); return { delivery: { id: "write-1", status: "COMMITTING", writeCommitRevision: 7, writeCommitAt: new Date("2026-09-06T18:00:00Z") }, writeCommitRevision: 7, writeCommitAt: "2026-09-06T18:00:00.000Z" }; },
      failProgrammaticWrite: async (input) => { calls.push(["fail", input]); },
    };
    const result = await prepareCustomManualDeliveryCommit({
      agencyId: "agency-1", userId: "user-1", member, accessEpoch: 9, deviceId: "device-a",
      creatorId: "creator-1", dialogId: "777", mediaIds: ["9001", "9002"], priceCents: 2000,
      networkRequestId: "network-req-42", authority,
    });
    assert.equal(result.allow, true);
    assert.equal(result.commit.authorityVersion, "CUSTOM_MANUAL_V1");
    assert.equal(result.commit.writeCommitRevision, 7);
    const reserve = calls.find(([kind]) => kind === "reserve")[1];
    assert.equal(reserve.kind, "CUSTOM_MANUAL_SEND");
    assert.equal(reserve.idempotencyKey, "custom-manual:custom-1:sub-1:0");
    assert.equal(reserve.targetId, "custom-1");
    assert.equal(reserve.dialogId, "777");
    assert.deepEqual(reserve.payload.attemptedMediaIds, ["9001", "9002"]);
    assert.equal(reserve.payload.expectedPriceCents, 2000);
    assert.equal(reserve.payload.actualPriceCents, 2000);
    assert.equal(reserve.payload.networkRequestId, "network-req-42");
    assert.equal(reserve.payload.actorMemberId, "member-1");
    assert.equal(reserve.payload.actorUserId, "user-1");
    assert.equal(reserve.allowReconciliationTakeover, false);
    assert.equal(calls.some(([kind]) => kind === "checkpoint"), false, "manual Custom send must not depend on approximate prewrite/readback checkpoints");
  });
});

test("Custom manual commit-current fence rejects stale delivery phase, stale financial truth, or media outside approved submission", async () => {
  await withService({}, async ({ assertCustomManualDeliveryCommitCurrent }) => {
    const order = {
      id: "custom-1", creatorId: "creator-1", dialogId: "777", type: "CONTENT", status: "PENDING", fanDeliveredAt: null,
      priceCents: 6000, paidAmountCents: 4000, deliveryOfferedCents: 0, deliverySentMediaIds: [], deliveryMessageIds: [], updatedAt: new Date(),
    };
    const row = { id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1", pipelineDisposition: "ACTIVE", reviewStatus: "APPROVED", reviewedAt: new Date(), ofMediaIds: ["9001", "9002"], customOrder: order };
    const db = { customContentSubmission: { findFirst: async () => row } };
    const baseDelivery = {
      agencyId: "agency-1", creatorId: "creator-1", dialogId: "777",
      payload: { customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777", attemptedMediaIds: ["9001"], deliveryPhase: 0, expectedPriceCents: 2000, actualPriceCents: 2000, duplicateOverride: false, priceMismatchOverride: false },
    };
    const current = await assertCustomManualDeliveryCommitCurrent({ db, delivery: baseDelivery });
    assert.equal(current.currentExpected, 2000);

    order.deliveryMessageIds = ["message-already-sent"];
    await assert.rejects(() => assertCustomManualDeliveryCommitCurrent({ db, delivery: baseDelivery }), (error) => error?.code === "CUSTOM_DELIVERY_PHASE_CHANGED");
    order.deliveryMessageIds = [];

    order.paidAmountCents = 5000;
    await assert.rejects(() => assertCustomManualDeliveryCommitCurrent({ db, delivery: baseDelivery }), (error) => error?.code === "CUSTOM_DELIVERY_FINANCIAL_STATE_CHANGED");
    order.paidAmountCents = 4000;

    await assert.rejects(() => assertCustomManualDeliveryCommitCurrent({ db, delivery: { ...baseDelivery, payload: { ...baseDelivery.payload, attemptedMediaIds: ["not-approved"] } } }), (error) => error?.code === "CUSTOM_DELIVERY_STALE_MEDIA");
  });
});

test("Custom manual commit-current fence requires explicit duplicate and price overrides at the physical boundary", async () => {
  await withService({}, async ({ assertCustomManualDeliveryCommitCurrent }) => {
    const order = {
      id: "custom-1", creatorId: "creator-1", dialogId: "777", type: "CONTENT", status: "PENDING", fanDeliveredAt: null,
      priceCents: 6000, paidAmountCents: 4000, deliveryOfferedCents: 0, deliverySentMediaIds: ["9001"], deliveryMessageIds: [], updatedAt: new Date(),
    };
    const row = { id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1", pipelineDisposition: "ACTIVE", reviewStatus: "APPROVED", reviewedAt: new Date(), ofMediaIds: ["9001", "9002"], customOrder: order };
    const db = { customContentSubmission: { findFirst: async () => row } };
    const base = { agencyId: "agency-1", creatorId: "creator-1", dialogId: "777", payload: { customOrderId: "custom-1", submissionId: "sub-1", creatorId: "creator-1", dialogId: "777", attemptedMediaIds: ["9001"], deliveryPhase: 0, expectedPriceCents: 2000, actualPriceCents: 2000, duplicateOverride: false, priceMismatchOverride: false } };
    await assert.rejects(() => assertCustomManualDeliveryCommitCurrent({ db, delivery: base }), (error) => error?.code === "CUSTOM_DELIVERY_DUPLICATE_OVERRIDE_REQUIRED");
    const duplicateAllowed = { ...base, payload: { ...base.payload, duplicateOverride: true } };
    await assertCustomManualDeliveryCommitCurrent({ db, delivery: duplicateAllowed });
    const undercharge = { ...base, payload: { ...base.payload, attemptedMediaIds: ["9002"], actualPriceCents: 1000, priceMismatchOverride: false } };
    await assert.rejects(() => assertCustomManualDeliveryCommitCurrent({ db, delivery: undercharge }), (error) => error?.code === "CUSTOM_DELIVERY_PRICE_OVERRIDE_REQUIRED");
  });
});



test("CUSTOM_MANUAL_V2 mints its first settlement capability atomically with COMMITTING while V1 remains rolling-compatible", async () => {
  await withService({
    preflight: async () => ({ matched: true, allow: true, item: readyItem, attemptedCustomMediaIds: ["9001"] }),
  }, async ({ prepareCustomManualDeliveryCommit }) => {
    const prepareCalls = [];
    const attachCalls = [];
    const authority = {
      reserveProgrammaticWrite: async () => ({ lease: { token: "lease-token", revision: 3 }, delivery: { id: "write-v2", status: "CLAIMED" } }),
      startProgrammaticWrite: async () => ({ delivery: { id: "write-v2", status: "RUNNING" } }),
      prepareProgrammaticWrite: async (input) => {
        prepareCalls.push(input);
        return { delivery: { id: "write-v2", status: "COMMITTING", writeCommitRevision: 9, writeCommitAt: new Date("2026-09-07T10:00:00Z") }, writeCommitRevision: 9, writeCommitAt: "2026-09-07T10:00:00.000Z", ...(input.mintCustomManualSettlementCapability ? { settlementToken: "settle-custom-v2" } : {}) };
      },
      failProgrammaticWrite: async () => {},
      attachCustomManualSettlementCapability: async (input) => { attachCalls.push(input); return { ok: true, settlementToken: "should-not-be-used-on-first-grant" }; },
    };
    const common = {
      agencyId: "agency-1", userId: "user-1", member, accessEpoch: 9, deviceId: "device-a", creatorId: "creator-1", dialogId: "777",
      mediaIds: ["9001"], priceCents: 2000, networkRequestId: "network-v2-1", authority,
    };
    const v2 = await prepareCustomManualDeliveryCommit({ ...common, authorityVersion: "CUSTOM_MANUAL_V2" });
    assert.equal(v2.commit.authorityVersion, "CUSTOM_MANUAL_V2");
    assert.equal(v2.commit.settlementToken, "settle-custom-v2");
    assert.equal(prepareCalls[0].mintCustomManualSettlementCapability, true);
    assert.equal(attachCalls.length, 0, "first V2 grant must not have a second transaction gap");

    const v1 = await prepareCustomManualDeliveryCommit({ ...common, authorityVersion: "CUSTOM_MANUAL_V1" });
    assert.equal(v1.commit.authorityVersion, "CUSTOM_MANUAL_V1");
    assert.equal(v1.commit.settlementToken, undefined);
    assert.equal(prepareCalls[1].mintCustomManualSettlementCapability, false);
  });
});

test("CUSTOM_MANUAL_V2 exact duplicate preflight can recover a lost COMMITTING grant without reminting physical work", async () => {
  await withService({
    preflight: async () => ({ matched: true, allow: true, item: readyItem, attemptedCustomMediaIds: ["9001"] }),
  }, async ({ prepareCustomManualDeliveryCommit }) => {
    let failCalls = 0;
    const authority = {
      reserveProgrammaticWrite: async () => { throw Object.assign(new Error("lost grant response"), { code: "PROGRAMMATIC_WRITE_COMMIT_IN_FLIGHT" }); },
      startProgrammaticWrite: async () => { throw new Error("must not start a second write"); },
      prepareProgrammaticWrite: async () => { throw new Error("must not mint a second commit revision"); },
      failProgrammaticWrite: async () => { failCalls += 1; },
      attachCustomManualSettlementCapability: async (input) => ({ ok: true, writeId: "write-existing", writeCommitRevision: 7, writeCommitAt: "2026-09-07T10:00:00.000Z", settlementToken: "recovered-token", binding: input }),
    };
    const result = await prepareCustomManualDeliveryCommit({
      agencyId: "agency-1", userId: "user-1", member, accessEpoch: 9, deviceId: "device-a", creatorId: "creator-1", dialogId: "777",
      mediaIds: ["9001"], priceCents: 2000, networkRequestId: "network-replay", authorityVersion: "CUSTOM_MANUAL_V2", authority,
    });
    assert.equal(result.commit.writeId, "write-existing");
    assert.equal(result.commit.writeCommitRevision, 7);
    assert.equal(result.commit.settlementToken, "recovered-token");
    assert.equal(failCalls, 0);
  });
});

test("CUSTOM_MANUAL_V2 post-COMMITTING token formatting failure never downgrades the non-idempotent write", async () => {
  await withService({ preflight: async () => ({ matched: true, allow: true, item: readyItem, attemptedCustomMediaIds: ["9001"] }) }, async ({ prepareCustomManualDeliveryCommit }) => {
    let failCalls = 0;
    const authority = {
      reserveProgrammaticWrite: async () => ({ lease: { token: "lease-token", revision: 3 }, delivery: { id: "write-v2", status: "CLAIMED" } }),
      startProgrammaticWrite: async () => ({ delivery: { id: "write-v2", status: "RUNNING" } }),
      prepareProgrammaticWrite: async () => ({ delivery: { id: "write-v2", status: "COMMITTING", writeCommitRevision: 9, writeCommitAt: new Date() }, writeCommitRevision: 9, writeCommitAt: new Date().toISOString() }),
      failProgrammaticWrite: async () => { failCalls += 1; },
      attachCustomManualSettlementCapability: async () => { throw new Error("not used"); },
    };
    await assert.rejects(() => prepareCustomManualDeliveryCommit({
      agencyId: "agency-1", userId: "user-1", member, accessEpoch: 9, deviceId: "device-a", creatorId: "creator-1", dialogId: "777",
      mediaIds: ["9001"], priceCents: 2000, networkRequestId: "network-missing-token", authorityVersion: "CUSTOM_MANUAL_V2", authority,
    }), (error) => error?.code === "CUSTOM_DELIVERY_SETTLEMENT_CAPABILITY_INVALID");
    assert.equal(failCalls, 0, "a COMMITTING write may never be rewritten as precommit because token delivery failed");
  });
});

test("Custom manual authority exposes no approximate readback settlement surface", async () => {
  await withService({}, async (service) => {
    assert.equal(service.normalizeManualPreflight, undefined);
    assert.equal(service.normalizeManualReadbackEvidence, undefined);
    assert.equal(service.listCustomManualDeliveryReconciliationWork, undefined);
    assert.equal(service.resolveCustomManualDeliveryReconciliationMatched, undefined);
    assert.doesNotMatch(String(service.prepareCustomManualDeliveryCommit), /checkpointProgrammaticWrite/, "production default authority composition must not retain the retired checkpoint symbol");
  });
});
