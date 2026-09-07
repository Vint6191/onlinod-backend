"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { uniqueMediaIds } = require("./custom-content-library-service");
const { loadAssets, isReady, preflightCustomManualSend } = require("./custom-content-delivery-service");
const { paymentSnapshot } = require("./custom-orders-service");
const {
  reserveProgrammaticWrite,
  startProgrammaticWrite,
  prepareProgrammaticWrite,
  failProgrammaticWrite,
  attachCustomManualSettlementCapability,
} = require("./programmatic-of-write-authority-service");


function fail(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 500) { return String(value == null ? "" : value).trim().slice(0, max); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function nonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(2_147_483_647, Math.round(n));
}
function sortedIds(values) { return uniqueMediaIds(values).slice().sort((a, b) => String(a).localeCompare(String(b))); }
function stableHash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function deliveryPhase(order) { return uniqueMediaIds(order?.deliveryMessageIds).length; }
function expectedDeliveryPrice(order) {
  const payment = paymentSnapshot(order?.priceCents, order?.paidAmountCents);
  return Math.max(payment.remainingAmountCents - nonNegativeInt(order?.deliveryOfferedCents), 0);
}

function commitPayloadFromPreflight({ item, attemptedMediaIds, actualPriceCents, overrideReason, duplicateOverride, priceMismatchOverride, networkRequestId, actorMemberId, actorUserId }) {
  const mediaIds = sortedIds(attemptedMediaIds);
  const deliveryPhaseNumber = uniqueMediaIds(item?.deliveryMessageIds).length;
  return {
    contractVersion: 1,
    customOrderId: clean(item?.customOrderId, 180),
    submissionId: clean(item?.submissionId, 180),
    creatorId: clean(item?.creatorId, 180),
    dialogId: clean(item?.dialogId, 180),
    attemptedMediaIds: mediaIds,
    deliveryPhase: deliveryPhaseNumber,
    expectedPriceCents: nonNegativeInt(item?.deliveryPriceCents),
    actualPriceCents: nonNegativeInt(actualPriceCents),
    overrideReason: clean(overrideReason, 500) || null,
    duplicateOverride: duplicateOverride === true,
    priceMismatchOverride: priceMismatchOverride === true,
    networkRequestId: clean(networkRequestId, 220) || null,
    actorMemberId: clean(actorMemberId, 180) || null,
    actorUserId: clean(actorUserId, 180) || null,
  };
}

function payloadFingerprint(payload) {
  // The fingerprint binds only physical/business semantics. Request identity and
  // human explanation are audit metadata, not a reason to create a new logical
  // external write. A proven-precommit retry may safely rebind those details.
  return `sha256:${stableHash({
    contractVersion: Number(payload.contractVersion || 1),
    customOrderId: payload.customOrderId,
    submissionId: payload.submissionId,
    creatorId: payload.creatorId,
    dialogId: payload.dialogId,
    attemptedMediaIds: sortedIds(payload.attemptedMediaIds),
    deliveryPhase: Number(payload.deliveryPhase),
    expectedPriceCents: nonNegativeInt(payload.expectedPriceCents),
    actualPriceCents: nonNegativeInt(payload.actualPriceCents),
    actorMemberId: clean(payload.actorMemberId, 180),
    actorUserId: clean(payload.actorUserId, 180),
  })}`;
}

async function assertCustomManualDeliveryCommitCurrent({ db, delivery }) {
  const payload = object(delivery?.payload);
  const agencyId = clean(delivery?.agencyId, 180);
  const creatorId = clean(payload.creatorId || delivery?.creatorId, 180);
  const customOrderId = clean(payload.customOrderId, 180);
  const submissionId = clean(payload.submissionId, 180);
  const dialogId = clean(payload.dialogId || delivery?.dialogId, 180);
  const attemptedMediaIds = sortedIds(payload.attemptedMediaIds);
  const expectedPhase = Number(payload.deliveryPhase);
  if (!agencyId || !creatorId || !customOrderId || !submissionId || !dialogId || !attemptedMediaIds.length || !Number.isInteger(expectedPhase) || expectedPhase < 0) {
    throw fail("CUSTOM_DELIVERY_COMMIT_PAYLOAD_INVALID", "Custom manual-send authority payload is incomplete", 500);
  }

  const row = await db.customContentSubmission.findFirst({
    where: {
      id: submissionId,
      agencyId,
      creatorId,
      customOrderId,
      pipelineDisposition: "ACTIVE",
      reviewStatus: "APPROVED",
      reviewedAt: { not: null },
      customOrder: { is: { id: customOrderId, creatorId, dialogId, type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
    },
    include: {
      customOrder: {
        select: {
          id: true, creatorId: true, dialogId: true, type: true, status: true, fanDeliveredAt: true,
          priceCents: true, paidAmountCents: true, deliveryOfferedCents: true,
          deliverySentMediaIds: true, deliveryMessageIds: true, completedAt: true, updatedAt: true,
        },
      },
    },
  });
  if (!row?.customOrder) throw fail("CUSTOM_DELIVERY_NOT_READY", "Custom is no longer ready at physical-send commit boundary", 409);
  const assets = await loadAssets(db, agencyId, [row]);
  if (!isReady(row, assets)) throw fail("CUSTOM_DELIVERY_NOT_READY", "Custom pipeline projection changed before physical-send commit", 409);

  const order = row.customOrder;
  if (deliveryPhase(order) !== expectedPhase) {
    throw fail("CUSTOM_DELIVERY_PHASE_CHANGED", "Another physical Custom delivery already advanced this order", 409);
  }
  const approved = new Set(uniqueMediaIds(row.ofMediaIds));
  if (attemptedMediaIds.some((mediaId) => !approved.has(mediaId))) {
    throw fail("CUSTOM_DELIVERY_STALE_MEDIA", "Selected media no longer belong to the current approved Custom submission", 409);
  }

  const currentExpected = expectedDeliveryPrice(order);
  if (currentExpected !== nonNegativeInt(payload.expectedPriceCents)) {
    throw fail("CUSTOM_DELIVERY_FINANCIAL_STATE_CHANGED", "Custom price/payment state changed after preflight; re-check before sending", 409);
  }
  const actual = nonNegativeInt(payload.actualPriceCents);
  const duplicateIds = attemptedMediaIds.filter((mediaId) => new Set(uniqueMediaIds(order.deliverySentMediaIds)).has(mediaId));
  if (duplicateIds.length && payload.duplicateOverride !== true) {
    throw fail("CUSTOM_DELIVERY_DUPLICATE_OVERRIDE_REQUIRED", "Already-delivered Custom media require an explicit duplicate override", 409);
  }
  if (actual !== currentExpected && payload.priceMismatchOverride !== true) {
    throw fail("CUSTOM_DELIVERY_PRICE_OVERRIDE_REQUIRED", "A changed Custom delivery price requires an explicit commit-time override", 409);
  }
  if (actual > currentExpected && clean(payload.overrideReason, 500).length < 3) {
    throw fail("CUSTOM_DELIVERY_OVERRIDE_REASON_REQUIRED", "Paid Custom overcharge override requires a reason", 409);
  }
  return { row, order, attemptedMediaIds, currentExpected, actualPriceCents: actual, duplicateIds };
}

async function prepareCustomManualDeliveryCommit({
  agencyId,
  userId,
  member,
  accessEpoch,
  deviceId,
  creatorId,
  dialogId,
  mediaIds,
  priceCents,
  networkRequestId,
  overrideReason = null,
  duplicateOverride = false,
  priceMismatchOverride = false,
  authorityVersion = "CUSTOM_MANUAL_V1",
  db = null,
  authority = null,
} = {}) {
  const client = db || prisma;
  const actorMemberId = clean(member?.id, 180);
  const actorUserId = clean(userId || member?.userId, 180);
  const boundDeviceId = clean(deviceId, 180);
  const epoch = Number(accessEpoch);
  const requestedAuthorityVersion = clean(authorityVersion, 80).toUpperCase();
  if (!["CUSTOM_MANUAL_V1", "CUSTOM_MANUAL_V2"].includes(requestedAuthorityVersion)) throw fail("CUSTOM_DELIVERY_AUTHORITY_VERSION_INVALID", "Unsupported Custom manual-send authority version", 400);
  if (!agencyId || !actorMemberId || !actorUserId || !boundDeviceId || !Number.isInteger(epoch) || epoch < 0) {
    throw fail("CUSTOM_DELIVERY_COMMIT_ACTOR_INVALID", "Authenticated actor/device/access epoch are required", 403);
  }
  const requestId = clean(networkRequestId, 220);
  if (!requestId) throw fail("CUSTOM_DELIVERY_NETWORK_REQUEST_REQUIRED", "Exact Network request identity is required", 409);

  // Product exact read is intentionally repeated here after the user has made
  // any price/duplicate override decision. The generic commit authority repeats
  // the business validation once more under its global commit fence.
  const preflight = await preflightCustomManualSend({ agencyId, member, creatorId, dialogId, mediaIds, db: client });
  if (!preflight.matched || !preflight.allow || !preflight.item) {
    throw fail(preflight.code || "CUSTOM_DELIVERY_NOT_READY", preflight.error || "Custom is no longer ready for manual delivery", 409);
  }
  const item = preflight.item;
  const payload = commitPayloadFromPreflight({
    item,
    attemptedMediaIds: preflight.attemptedCustomMediaIds || mediaIds,
    actualPriceCents: priceCents,
    overrideReason,
    duplicateOverride,
    priceMismatchOverride,
    networkRequestId: requestId,
    actorMemberId,
    actorUserId,
  });
  const key = `custom-manual:${payload.customOrderId}:${payload.submissionId}:${payload.deliveryPhase}`;
  const fingerprint = payloadFingerprint(payload);
  const ops = authority || { reserveProgrammaticWrite, startProgrammaticWrite, prepareProgrammaticWrite, failProgrammaticWrite, attachCustomManualSettlementCapability };

  let reserved = null;
  let lease = null;
  let commitPrepared = false;
  try {
    reserved = await ops.reserveProgrammaticWrite({
      kind: "CUSTOM_MANUAL_SEND",
      agencyId,
      userId: actorUserId,
      memberId: actorMemberId,
      accessEpoch: epoch,
      creatorId: payload.creatorId,
      deviceId: boundDeviceId,
      idempotencyKey: key,
      payloadFingerprint: fingerprint,
      payload,
      targetId: payload.customOrderId,
      fanId: payload.dialogId,
      dialogId: payload.dialogId,
      permissionKeyOverride: "chats.reply",
      allowReconciliationTakeover: false,
      leaseMs: 3 * 60_000,
      maxAttempts: 1,
    });
    lease = reserved?.lease || null;
    if (!lease) {
      const status = String(reserved?.delivery?.status || "UNKNOWN");
      throw fail(
        status === "COMPLETED" ? "CUSTOM_DELIVERY_ALREADY_COMMITTED" : "CUSTOM_DELIVERY_OUTCOME_UNRESOLVED",
        status === "COMPLETED"
          ? "This physical Custom delivery phase already has a confirmed external-write result"
          : "Previous physical Custom delivery outcome is unresolved; resend is forbidden",
        409,
      );
    }
    const started = await ops.startProgrammaticWrite({
      kind: "CUSTOM_MANUAL_SEND", agencyId, userId: actorUserId, memberId: actorMemberId, accessEpoch: epoch,
      creatorId: payload.creatorId, deviceId: boundDeviceId, writeId: reserved.delivery.id,
      leaseToken: lease.token, leaseRevision: lease.revision, permissionKey: "chats.reply",
    });
    if (started?.reconciliationRequired || String(started?.delivery?.status) === "RECONCILE_REQUIRED") {
      throw fail("CUSTOM_DELIVERY_OUTCOME_UNRESOLVED", "Previous physical Custom delivery outcome is unresolved; resend is forbidden", 409);
    }
    const prepared = await ops.prepareProgrammaticWrite({
      kind: "CUSTOM_MANUAL_SEND", agencyId, userId: actorUserId, memberId: actorMemberId, accessEpoch: epoch,
      creatorId: payload.creatorId, deviceId: boundDeviceId, writeId: reserved.delivery.id,
      leaseToken: lease.token, leaseRevision: lease.revision, permissionKey: "chats.reply",
      mintCustomManualSettlementCapability: requestedAuthorityVersion === "CUSTOM_MANUAL_V2",
    });
    commitPrepared = true;
    const writeCommitRevision = Number(prepared.writeCommitRevision || prepared.delivery.writeCommitRevision || 0);
    const settlementToken = requestedAuthorityVersion === "CUSTOM_MANUAL_V2" ? (clean(prepared?.settlementToken, 500) || null) : null;
    if (requestedAuthorityVersion === "CUSTOM_MANUAL_V2" && !settlementToken) {
      throw fail("CUSTOM_DELIVERY_SETTLEMENT_CAPABILITY_INVALID", "Custom manual V2 commit permit is missing its atomic settlement capability", 500);
    }
    return {
      ok: true,
      allow: true,
      code: null,
      item,
      attemptedCustomMediaIds: payload.attemptedMediaIds,
      commit: {
        authorityVersion: requestedAuthorityVersion,
        writeId: String(prepared.delivery.id),
        idempotencyKey: key,
        writeCommitRevision,
        writeCommitAt: prepared.writeCommitAt || prepared.delivery.writeCommitAt || null,
        ...(settlementToken ? { settlementToken } : {}),
      },
    };
  } catch (error) {
    const code = String(error?.code || "");
    // Lost backend response after an atomic V2 COMMITTING grant: recover only the
    // exact same request/fingerprint and mint another settlement capability. No
    // new physical request identity can be rebound through this path.
    if (requestedAuthorityVersion === "CUSTOM_MANUAL_V2"
        && ["PROGRAMMATIC_WRITE_COMMIT_IN_FLIGHT", "PROGRAMMATIC_WRITE_ALREADY_COMMITTING", "PROGRAMMATIC_WRITE_NOT_CLAIMABLE"].includes(code)
        && typeof ops.attachCustomManualSettlementCapability === "function") {
      const attached = await ops.attachCustomManualSettlementCapability({
        agencyId, creatorId: payload.creatorId, deviceId: boundDeviceId, userId: actorUserId,
        idempotencyKey: key, payloadFingerprint: fingerprint, networkRequestId: requestId, writeCommitRevision: 0,
      });
      const recoveredToken = clean(attached?.settlementToken, 500) || null;
      if (!recoveredToken) throw fail("CUSTOM_DELIVERY_SETTLEMENT_CAPABILITY_INVALID", "Recovered Custom V2 commit permit is missing its settlement capability", 500);
      return {
        ok: true, allow: true, code: null, item, attemptedCustomMediaIds: payload.attemptedMediaIds,
        commit: {
          authorityVersion: "CUSTOM_MANUAL_V2", writeId: String(attached.writeId), idempotencyKey: key,
          writeCommitRevision: Number(attached.writeCommitRevision), writeCommitAt: attached.writeCommitAt || null, settlementToken: recoveredToken,
        },
      };
    }
    // If the product-specific current-state fence rejected before COMMITTING, the
    // external wire was never permitted. Close the generic attempt as proven
    // precommit failure so a later current preflight may safely rebind payload.
    // Once COMMITTING exists, never downgrade it because a later response/token
    // formatting step failed; the exact V2 grant is recovered above on retry.
    if (!commitPrepared && reserved?.delivery?.id && lease && !code.includes("COMMIT_IN_FLIGHT")) {
      try {
        await ops.failProgrammaticWrite({
          kind: "CUSTOM_MANUAL_SEND", agencyId, userId: actorUserId, memberId: actorMemberId, accessEpoch: epoch,
          creatorId: payload.creatorId, deviceId: boundDeviceId, writeId: reserved.delivery.id,
          leaseToken: lease.token, leaseRevision: lease.revision, permissionKey: "chats.reply",
          failureCode: clean(error?.code, 120) || "custom_manual_precommit_failed",
          error: clean(error?.message, 1000) || "Custom manual-send commit preparation failed before wire",
          facts: { provenNoEffect: true, phase: "PRECOMMIT" },
          retryAfterMs: 5_000,
        });
      } catch { /* lease may already have changed; no commit permit means expiry remains safe */ }
    }
    throw error;
  }
}


module.exports = {
  assertCustomManualDeliveryCommitCurrent,
  prepareCustomManualDeliveryCommit,
  commitPayloadFromPreflight,
  payloadFingerprint,
  deliveryPhase,
  expectedDeliveryPrice,
};
