"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { canUsePermission } = require("./team-access-control");
const { assertExecutionAccessFence, ExecutionAccessFenceError } = require("./execution-access-fence-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { classifyAutomationFailure, FAILURE_CATEGORIES } = require("./automation-failure-taxonomy");

const ACTIVE_LEASE_STATUSES = new Set(["CLAIMED", "RUNNING", "COMMITTING"]);
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "SKIPPED", "CANCELED"]);
const DEFAULT_LEASE_MS = 3 * 60_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;

const PRODUCT_WRITE_KINDS = Object.freeze({
  MASS_QUEUE_CREATE: Object.freeze({
    moduleKey: "mass",
    actionType: "MASS_QUEUE_CREATE",
    permissionKey: "chats.mass_message",
    originKind: "INTERACTIVE",
    executionKind: "SOURCE_DEVICE",
    reconciliationKind: "MASS_QUEUE",
  }),
  VAULT_RELAY_SEND: Object.freeze({
    moduleKey: "vault",
    actionType: "VAULT_RELAY_SEND",
    permissionKey: "content.manage_vault",
    originKind: "INTERACTIVE",
    executionKind: "SOURCE_DEVICE",
    reconciliationKind: "VAULT_RELAY",
  }),
  VAULT_CREATE_LIST: Object.freeze({
    moduleKey: "vault",
    actionType: "VAULT_CREATE_LIST",
    permissionKey: "content.manage_vault",
    originKind: "INTERACTIVE",
    executionKind: "SOURCE_DEVICE",
    reconciliationKind: "VAULT_LIST",
  }),
  CUSTOM_RELAY_SEND: Object.freeze({
    moduleKey: "customs",
    actionType: "CUSTOM_RELAY_SEND",
    permissionKey: null,
    originKind: "SYSTEM",
    executionKind: "AUTHORIZED_DEVICE",
    reconciliationKind: "CUSTOM_RELAY",
  }),
});

class ProgrammaticOfWriteAuthorityError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "ProgrammaticOfWriteAuthorityError";
    this.code = code;
    this.status = status;
  }
}

function clean(value, max = 1000) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function hashToken(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function tokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const left = Buffer.from(hashToken(token), "hex");
  const right = Buffer.from(String(expectedHash), "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function leaseDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LEASE_MS;
  return Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(parsed)));
}
function productKind(value) {
  const key = clean(value, 80)?.toUpperCase();
  const config = key ? PRODUCT_WRITE_KINDS[key] : null;
  if (!config) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_KIND_INVALID", "Unsupported programmatic write kind", 400);
  return { key, config };
}
function publicDelivery(delivery) {
  if (!delivery) return null;
  return {
    id: delivery.id,
    agencyId: delivery.agencyId,
    creatorId: delivery.creatorId,
    actionType: delivery.actionType,
    originKind: delivery.originKind,
    sourceDeviceId: delivery.sourceDeviceId || null,
    payloadFingerprint: delivery.payloadFingerprint || null,
    executionKind: delivery.executionKind || null,
    reconciliationKind: delivery.reconciliationKind || null,
    idempotencyKey: delivery.idempotencyKey || null,
    status: delivery.status,
    leaseRevision: Number(delivery.leaseRevision || 0),
    writeCommitRevision: Number(delivery.writeCommitRevision || 0),
    writeCommitAt: delivery.writeCommitAt || null,
    failureCode: delivery.failureCode || null,
    failureCategory: delivery.failureCategory || null,
    result: object(delivery.result),
    messageId: delivery.messageId || null,
    finishedAt: delivery.finishedAt || null,
  };
}
function assertPayloadBinding(existing, input, config) {
  if (existing.agencyId !== input.agencyId || existing.creatorId !== input.creatorId || existing.actionType !== config.actionType) {
    throw new ProgrammaticOfWriteAuthorityError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another programmatic write", 409);
  }
  const existingFingerprint = clean(existing.payloadFingerprint, 200);
  const requestedFingerprint = clean(input.payloadFingerprint, 200);
  if (!existingFingerprint || !requestedFingerprint || existingFingerprint !== requestedFingerprint) {
    throw new ProgrammaticOfWriteAuthorityError("IDEMPOTENCY_CONFLICT", "Idempotency key payload fingerprint does not match the existing write", 409);
  }
}
async function assertLiveActor({ db, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey }) {
  let fenced;
  try {
    fenced = await assertExecutionAccessFence({ db, agencyId, userId, memberId, accessEpoch, creatorId, lock: true });
  } catch (error) {
    if (error instanceof ExecutionAccessFenceError) {
      throw new ProgrammaticOfWriteAuthorityError(error.code, error.message, error.status);
    }
    throw error;
  }
  if (permissionKey && !(await canUsePermission({ member: fenced.member, key: permissionKey, db }))) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_FORBIDDEN", `${permissionKey} permission is required`, 403);
  }
  return fenced;
}
async function assertDevice({ db, agencyId, userId, deviceId }) {
  const device = await db.workerDevice.findFirst({ where: { id: deviceId, agencyId, userId } });
  if (!device) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_DEVICE_INVALID", "Authenticated device is not registered for this agency", 403);
  return device;
}

async function reserveProgrammaticWrite(input) {
  const { key: kind, config } = productKind(input.kind);
  const agencyId = clean(input.agencyId, 180);
  const userId = clean(input.userId, 180);
  const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180);
  const deviceId = clean(input.deviceId, 180);
  const idempotencyKey = clean(input.idempotencyKey, 500);
  const payloadFingerprint = clean(input.payloadFingerprint, 200);
  const accessEpoch = Number(input.accessEpoch);
  if (!agencyId || !userId || !memberId || !creatorId || !deviceId || !idempotencyKey || !payloadFingerprint || !Number.isInteger(accessEpoch) || accessEpoch < 0) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RESERVE_INVALID", "Programmatic write identity, actor, device and payload fingerprint are required", 400);
  }
  const leaseMs = leaseDuration(input.leaseMs);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await assertDevice({ db: tx, agencyId, userId, deviceId });
    await assertLiveActor({ db: tx, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: input.permissionKeyOverride === undefined ? config.permissionKey : input.permissionKeyOverride });
    let delivery = await tx.automationDelivery.findUnique({ where: { idempotencyKey } });
    const replay = Boolean(delivery);
    if (delivery) {
      assertPayloadBinding(delivery, { agencyId, creatorId, payloadFingerprint }, config);
      if (TERMINAL_STATUSES.has(delivery.status)) {
        return { ok: true, replay: true, lease: null, delivery: publicDelivery(delivery) };
      }
      if (delivery.status === "COMMITTING") {
        // COMMITTING means a physical non-idempotent request may still be in-flight.
        // Never invalidate a live commit lease merely because another caller repeats reserve.
        // Recovery/takeover is allowed only after the commit lease is demonstrably expired.
        if (!delivery.claimUntil || delivery.claimUntil > now) {
          throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_COMMIT_IN_FLIGHT", "Programmatic write is still COMMITTING without a proven expired lease; reconciliation takeover is not allowed yet", 409);
        }
        const transitioned = await tx.automationDelivery.updateMany({
          where: {
            id: delivery.id,
            status: "COMMITTING",
            writeCommitRevision: delivery.writeCommitRevision,
            claimUntil: { lte: now },
          },
          data: {
            status: "RECONCILE_REQUIRED",
            failureCode: delivery.failureCode || "write_outcome_unknown",
            failureCategory: FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE,
            result: { ...object(delivery.result), outcomeState: "RECONCILE_REQUIRED", recoveredAfterCommitLeaseExpiredAt: now.toISOString() },
          },
        });
        if (!transitioned.count) {
          throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_COMMIT_IN_FLIGHT", "Programmatic write commit lease changed while recovery was attempted", 409);
        }
        delivery = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
      }
      if (ACTIVE_LEASE_STATUSES.has(delivery.status) && delivery.claimUntil && delivery.claimUntil > now && delivery.claimedByDeviceId !== deviceId) {
        throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_LEASE_BUSY", "Programmatic write is currently leased by another device", 409);
      }
      const reconciliation = delivery.status === "RECONCILE_REQUIRED";
      if (config.executionKind === "SOURCE_DEVICE" && delivery.sourceDeviceId && delivery.sourceDeviceId !== deviceId && !reconciliation) {
        throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_SOURCE_DEVICE_REQUIRED", "This write payload is bound to its original source device until a commit outcome requires reconciliation", 409);
      }
    }

    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const claimUntil = new Date(now.getTime() + leaseMs);
    if (!delivery) {
      try {
        delivery = await tx.automationDelivery.create({
          data: {
            agencyId,
            creatorId,
            moduleKey: config.moduleKey,
            actionType: config.actionType,
            targetId: clean(input.targetId, 180),
            fanId: clean(input.fanId, 180),
            dialogId: clean(input.dialogId, 180),
            idempotencyKey,
            payload: object(input.payload),
            status: "CLAIMED",
            scheduledAt: now,
            notBefore: now,
            claimedByDeviceId: deviceId,
            claimedAt: now,
            claimUntil,
            leaseTokenHash: hashToken(leaseToken),
            leaseRevision: 1,
            leaseMemberId: memberId,
            leaseAccessEpoch: accessEpoch,
            attempts: 1,
            maxAttempts: Math.max(1, Math.min(20, Number(input.maxAttempts) || 5)),
            createdByUserId: userId,
            originKind: config.originKind,
            sourceDeviceId: deviceId,
            payloadFingerprint,
            executionKind: config.executionKind,
            reconciliationKind: config.reconciliationKind,
            result: { reservedAt: now.toISOString(), programmaticWriteKind: kind },
          },
        });
      } catch (error) {
        if (error?.code === "P2002") {
          throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RESERVE_RACE", "Programmatic write idempotency or creator write lane changed while reserving; retry the same idempotency key", 409);
        }
        throw error;
      }
    } else {
      const reconciliation = delivery.status === "RECONCILE_REQUIRED";
      const claimable = reconciliation || ["QUEUED", "RETRY_SCHEDULED", "CLAIMED", "RUNNING"].includes(delivery.status);
      if (!claimable) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_CLAIMABLE", `Programmatic write status is ${delivery.status}`, 409);
      const changed = await tx.automationDelivery.updateMany({
        where: { id: delivery.id, leaseRevision: delivery.leaseRevision, status: delivery.status },
        data: {
          status: reconciliation ? "RECONCILE_REQUIRED" : "CLAIMED",
          claimedByDeviceId: deviceId,
          claimedAt: now,
          claimUntil,
          leaseTokenHash: hashToken(leaseToken),
          leaseRevision: { increment: 1 },
          leaseMemberId: memberId,
          leaseAccessEpoch: accessEpoch,
          sourceDeviceId: delivery.sourceDeviceId || deviceId,
          lastCheckedAt: now,
          result: { ...object(delivery.result), ...(reconciliation ? { outcomeState: "RECONCILE_REQUIRED" } : {}), reReservedAt: now.toISOString() },
        },
      });
      if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RESERVE_RACE", "Programmatic write changed while reserving", 409);
      delivery = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    }

    return {
      ok: true,
      replay,
      lease: { token: leaseToken, revision: delivery.leaseRevision, until: claimUntil },
      reconciliationRequired: delivery.status === "RECONCILE_REQUIRED",
      delivery: publicDelivery(delivery),
    };
  }, { timeout: 30_000 });
}

async function requireProgrammaticLease(input, { db = prisma, allowTerminal = false, allowCommittedSettlement = false, lock = false } = {}) {
  const delivery = await db.automationDelivery.findUnique({ where: { id: clean(input.writeId, 180) || "__missing__" } });
  if (!delivery) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_FOUND", "Programmatic write not found", 404);
  if (delivery.originKind === "AUTOMATION") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_WRONG_AUTHORITY", "Automation-origin delivery must use automation worker authority", 403);
  if (delivery.agencyId !== input.agencyId) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_AGENCY_MISMATCH", "Programmatic write belongs to another agency", 403);

  const storedKind = clean(object(delivery.result).programmaticWriteKind, 80)?.toUpperCase();
  const requestedKind = clean(input.kind, 80)?.toUpperCase() || storedKind;
  const { key: kind, config } = productKind(requestedKind);
  if (storedKind !== kind || delivery.actionType !== config.actionType) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_KIND_MISMATCH", "Programmatic write kind does not match the durable operation", 409);
  }
  if (input.creatorId && delivery.creatorId !== String(input.creatorId)) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_CREATOR_MISMATCH", "Programmatic write belongs to another creator", 403);
  }

  const terminal = TERMINAL_STATUSES.has(delivery.status);
  if (!(ACTIVE_LEASE_STATUSES.has(delivery.status) || delivery.status === "RECONCILE_REQUIRED" || (allowTerminal && terminal))) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_LEASED", `Programmatic write status is ${delivery.status}`, 409);
  }

  // A terminal response may have been durably committed while the HTTP response
  // back to Desktop was lost. Replaying complete must return the terminal row;
  // its lease token is intentionally erased on completion. Current route auth
  // still binds the signed device and the durable row remains agency/creator/kind bound.
  if (terminal && allowTerminal) {
    if (lock) await assertDevice({ db, agencyId: delivery.agencyId, userId: input.userId, deviceId: input.deviceId });
    return delivery;
  }

  if (delivery.claimedByDeviceId !== input.deviceId) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_CLAIMED_BY_OTHER", "Programmatic write is leased by another device", 409);
  if (!tokenMatches(input.leaseToken, delivery.leaseTokenHash) || Number(input.leaseRevision) !== delivery.leaseRevision) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_LEASE_STALE", "Programmatic write lease is stale", 409);
  }
  const committedSettlement = allowCommittedSettlement && delivery.status === "COMMITTING" && delivery.writeCommitAt;
  if (!committedSettlement && delivery.status !== "RECONCILE_REQUIRED" && (!delivery.claimUntil || delivery.claimUntil <= new Date())) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_LEASE_EXPIRED", "Programmatic write lease expired", 409);
  }
  if (!committedSettlement) {
    await assertLiveActor({
      db,
      agencyId: delivery.agencyId,
      userId: input.userId,
      memberId: delivery.leaseMemberId,
      accessEpoch: delivery.leaseAccessEpoch,
      creatorId: delivery.creatorId,
      permissionKey: input.permissionKey === undefined ? config.permissionKey : input.permissionKey,
    });
  }
  if (lock) await assertDevice({ db, agencyId: delivery.agencyId, userId: input.userId, deviceId: input.deviceId });
  return delivery;
}

async function startProgrammaticWrite(input) {
  return prisma.$transaction(async (tx) => {
    const delivery = await requireProgrammaticLease(input, { db: tx, lock: true });
    if (delivery.status === "RECONCILE_REQUIRED") return { ok: true, reconciliationRequired: true, delivery: publicDelivery(delivery) };
    if (delivery.status === "RUNNING") return { ok: true, duplicate: true, delivery: publicDelivery(delivery) };
    if (delivery.status === "COMMITTING") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_ALREADY_COMMITTING", "Write already crossed the commit boundary", 409);
    if (delivery.status !== "CLAIMED") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_CLAIMED", `Programmatic write status is ${delivery.status}`, 409);
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "CLAIMED", leaseRevision: delivery.leaseRevision, claimedByDeviceId: input.deviceId },
      data: { status: "RUNNING", lastCheckedAt: new Date(), result: { ...object(delivery.result), attemptStartedAt: new Date().toISOString() } },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_START_RACE", "Programmatic write changed before start", 409);
    return { ok: true, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
  }, { timeout: 30_000 });
}


async function checkpointProgrammaticWrite(input) {
  return prisma.$transaction(async (tx) => {
    const delivery = await requireProgrammaticLease(input, { db: tx, lock: true });
    if (!new Set(["CLAIMED", "RUNNING", "RECONCILE_REQUIRED"]).has(delivery.status)) {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_CHECKPOINT_FORBIDDEN", `Programmatic write status is ${delivery.status}`, 409);
    }
    const patch = object(input.result);
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision, claimedByDeviceId: input.deviceId },
      data: { result: { ...object(delivery.result), ...patch, checkpointedAt: new Date().toISOString() }, lastCheckedAt: new Date() },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_CHECKPOINT_RACE", "Programmatic write changed before checkpoint", 409);
    return { ok: true, reconciliationRequired: delivery.status === "RECONCILE_REQUIRED", delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
  }, { timeout: 30_000 });
}

async function prepareProgrammaticWrite(input) {
  return prisma.$transaction(async (tx) => {
    let delivery = await requireProgrammaticLease(input, { db: tx, lock: true });
    await lockAutomationWriteCommitFence({ db: tx, agencyId: delivery.agencyId });
    delivery = await requireProgrammaticLease(input, { db: tx, lock: true });
    if (delivery.status === "COMMITTING" && delivery.writeCommitAt) {
      return { ok: true, duplicate: true, writeCommitRevision: delivery.writeCommitRevision, writeCommitAt: delivery.writeCommitAt, delivery: publicDelivery(delivery) };
    }
    if (delivery.status === "RECONCILE_REQUIRED") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RECONCILIATION_REQUIRED", "Previous external write outcome must be reconciled before another commit permit", 409);
    if (delivery.status !== "RUNNING") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_RUNNING", `Programmatic write status is ${delivery.status}`, 409);
    const now = new Date();
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "RUNNING", claimedByDeviceId: input.deviceId, leaseRevision: delivery.leaseRevision, leaseTokenHash: hashToken(input.leaseToken), claimUntil: { gt: now } },
      data: {
        status: "COMMITTING",
        writeCommitRevision: { increment: 1 },
        writeCommitAt: now,
        lastCheckedAt: now,
        result: { ...object(delivery.result), writeCommitGrantedAt: now.toISOString(), writeCommitLeaseRevision: delivery.leaseRevision },
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_COMMIT_PERMIT_STALE", "Programmatic write changed before commit permit", 409);
    delivery = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    return { ok: true, duplicate: false, writeCommitRevision: delivery.writeCommitRevision, writeCommitAt: delivery.writeCommitAt, delivery: publicDelivery(delivery) };
  }, { timeout: 30_000 });
}

async function completeProgrammaticWrite(input) {
  return prisma.$transaction(async (tx) => {
    const delivery = await requireProgrammaticLease(input, { db: tx, allowTerminal: true, allowCommittedSettlement: true, lock: true });
    if (TERMINAL_STATUSES.has(delivery.status)) return { ok: true, duplicate: true, delivery: publicDelivery(delivery) };
    if (delivery.status !== "COMMITTING") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_COMMITTING", `Programmatic write status is ${delivery.status}`, 409);
    const now = new Date();
    const result = object(input.result);
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "COMMITTING", claimedByDeviceId: input.deviceId, leaseRevision: delivery.leaseRevision, writeCommitRevision: delivery.writeCommitRevision },
      data: {
        status: "COMPLETED",
        failureCode: null,
        failureCategory: null,
        lastError: null,
        messageId: clean(input.messageId || result.messageId || result.queueId || result.folderId, 180),
        result: { ...object(delivery.result), ...result, outcomeState: "PROVEN_SUCCESS", completedAt: now.toISOString() },
        finishedAt: now,
        claimUntil: null,
        leaseTokenHash: null,
        lastCheckedAt: now,
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_COMPLETE_RACE", "Programmatic write changed before completion", 409);
    return { ok: true, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
  }, { timeout: 30_000 });
}

async function failProgrammaticWrite(input) {
  return prisma.$transaction(async (tx) => {
    const delivery = await requireProgrammaticLease(input, { db: tx, allowCommittedSettlement: true, lock: true });
    const facts = object(input.facts);
    const reachedWire = facts.writeReachedWire === true || delivery.status === "COMMITTING";
    const endpointSemantics = clean(facts.endpointSemantics, 80)?.toUpperCase() || null;
    const idempotent = endpointSemantics === "IDEMPOTENT_WRITE";
    // Client evidence may describe transport facts, but it cannot declare a
    // non-idempotent COMMITTING write safe to repeat. Generic post-commit failures
    // (including HTTP 4xx/5xx) remain unknown until a dedicated reconciler proves
    // the remote result. Only a pre-wire failure can be authoritative no-effect here.
    const clientClaimedNoEffect = facts.provenNoEffect === true;
    const provenNoEffect = clientClaimedNoEffect && !reachedWire && delivery.status !== "COMMITTING";
    const failureCode = clean(input.failureCode, 120) || "unknown";
    const category = classifyAutomationFailure({
      failureCode,
      deliveryStatus: delivery.status,
      provenNoEffect,
      idempotent,
      reachedWire,
      endpointSemantics,
      writeReachedWire: reachedWire,
      outcomeState: facts.outcomeState || null,
      transportCode: facts.transportCode || facts.originalCode || null,
    });
    const reconcile = !provenNoEffect && reachedWire && !idempotent;
    const now = new Date();
    const nextStatus = reconcile ? "RECONCILE_REQUIRED" : (category === FAILURE_CATEGORIES.TERMINAL ? "FAILED" : "RETRY_SCHEDULED");
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, leaseRevision: delivery.leaseRevision, claimedByDeviceId: input.deviceId },
      data: {
        status: nextStatus,
        failureCode,
        failureCategory: reconcile ? FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE : category,
        lastError: clean(input.error, 2000),
        notBefore: nextStatus === "RETRY_SCHEDULED" ? new Date(now.getTime() + Math.max(5_000, Math.min(60 * 60_000, Number(input.retryAfterMs) || 30_000))) : delivery.notBefore,
        finishedAt: nextStatus === "FAILED" ? now : null,
        claimUntil: null,
        leaseTokenHash: null,
        lastCheckedAt: now,
        result: {
          ...object(delivery.result),
          ...facts,
          ...(clientClaimedNoEffect && !provenNoEffect ? { clientClaimedProvenNoEffect: true } : {}),
          provenNoEffect,
          outcomeState: reconcile ? "RECONCILE_REQUIRED" : (provenNoEffect ? "PROVEN_NO_EFFECT" : "TERMINAL"),
          failedAt: now.toISOString(),
        },
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_FAIL_RACE", "Programmatic write changed before failure settlement", 409);
    return { ok: true, reconciliationRequired: reconcile, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
  }, { timeout: 30_000 });
}

async function reconcileProgrammaticWrite(input) {
  return prisma.$transaction(async (tx) => {
    const delivery = await requireProgrammaticLease(input, { db: tx, lock: true });
    if (delivery.status !== "RECONCILE_REQUIRED") {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_RECONCILING", `Programmatic write status is ${delivery.status}`, 409);
    }
    const outcome = clean(input.outcome, 80)?.toUpperCase();
    if (!new Set(["MATCHED", "PROVEN_NO_EFFECT", "WAIT_FOR_READBACK"]).has(outcome)) {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RECONCILE_OUTCOME_INVALID", "Reconciliation outcome is invalid", 400);
    }
    // None of the current product write kinds has a documented strong negative
    // read-after-write contract. Absence from an eventual-consistency readback is
    // therefore WAIT_FOR_READBACK, never proof that a second POST is safe.
    if (outcome === "PROVEN_NO_EFFECT") {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NO_EFFECT_PROOF_REQUIRED", "This write kind has no authoritative negative-proof contract; keep reconciling instead of retrying", 409);
    }
    if (outcome === "WAIT_FOR_READBACK") {
      return { ok: true, reconciliationRequired: true, delivery: publicDelivery(delivery) };
    }
    const now = new Date();
    const evidence = object(input.result);
    const complete = outcome === "MATCHED";
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "RECONCILE_REQUIRED", leaseRevision: delivery.leaseRevision, claimedByDeviceId: input.deviceId },
      data: complete ? {
        status: "COMPLETED",
        failureCode: null,
        failureCategory: null,
        lastError: null,
        messageId: clean(evidence.messageId || evidence.queueId || evidence.folderId, 180),
        result: { ...object(delivery.result), ...evidence, outcomeState: "PROVEN_SUCCESS", reconciledAt: now.toISOString() },
        finishedAt: now,
        claimUntil: null,
        leaseTokenHash: null,
        lastCheckedAt: now,
      } : {
        status: "RETRY_SCHEDULED",
        failureCode: "proven_no_effect",
        failureCategory: FAILURE_CATEGORIES.DEFINITE_NO_WRITE_RETRYABLE,
        lastError: null,
        writeCommitAt: null,
        result: { ...object(delivery.result), ...evidence, outcomeState: "PROVEN_NO_EFFECT", reconciledAt: now.toISOString() },
        notBefore: now,
        finishedAt: null,
        claimUntil: null,
        leaseTokenHash: null,
        lastCheckedAt: now,
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RECONCILE_RACE", "Programmatic write changed before reconciliation settlement", 409);
    return {
      ok: true,
      reconciliationRequired: false,
      provenNoEffect: !complete,
      delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })),
    };
  }, { timeout: 30_000 });
}

async function getProgrammaticWrite({ agencyId, userId, memberId, accessEpoch, creatorId, writeId, db = prisma }) {
  const delivery = await db.automationDelivery.findFirst({ where: { id: writeId, agencyId, creatorId, originKind: { not: "AUTOMATION" } } });
  if (!delivery) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_FOUND", "Programmatic write not found", 404);
  const storedKind = clean(object(delivery.result).programmaticWriteKind, 80)?.toUpperCase();
  const { config } = productKind(storedKind);
  if (!config.permissionKey) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_GET_FORBIDDEN", "This write kind must be read through its product-specific adapter", 403);
  }
  await assertLiveActor({ db, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: config.permissionKey });
  return { ok: true, delivery: publicDelivery(delivery) };
}

module.exports = {
  PRODUCT_WRITE_KINDS,
  ProgrammaticOfWriteAuthorityError,
  reserveProgrammaticWrite,
  startProgrammaticWrite,
  prepareProgrammaticWrite,
  checkpointProgrammaticWrite,
  completeProgrammaticWrite,
  failProgrammaticWrite,
  reconcileProgrammaticWrite,
  getProgrammaticWrite,
};
