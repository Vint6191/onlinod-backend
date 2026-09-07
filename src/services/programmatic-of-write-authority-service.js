"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { canUsePermission } = require("./team-access-control");
const { assertExecutionAccessFence, ExecutionAccessFenceError } = require("./execution-access-fence-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { classifyAutomationFailure, FAILURE_CATEGORIES } = require("./automation-failure-taxonomy");
const { isProviderStatusProvenNoEffect } = require("./provider-http-outcome-proof");

const ACTIVE_LEASE_STATUSES = new Set(["CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"]);
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "SKIPPED", "CANCELED"]);
const DEFAULT_LEASE_MS = 3 * 60_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;
const MAX_RECONCILIATION_WAIT_MS = 30 * 60_000;
const MASS_QUEUE_SNAPSHOT_FENCE_TTL_MS = 60 * 60_000;
const MASS_PROVIDER_SNAPSHOT_PROOF_ACTION = "MASS_PROVIDER_SNAPSHOT_PROOF";
const massQueueSnapshotFences = new Map();

function purgeMassQueueSnapshotFences(nowMs = Date.now()) {
  for (const [token, fence] of massQueueSnapshotFences.entries()) {
    if (!fence || Number(fence.expiresAtMs || 0) <= nowMs) massQueueSnapshotFences.delete(token);
  }
}


const PRODUCT_WRITE_KINDS = Object.freeze({
  MASS_QUEUE_CREATE: Object.freeze({
    moduleKey: "mass",
    actionType: "MASS_QUEUE_CREATE",
    permissionKey: "chats.mass_message",
    originKind: "INTERACTIVE",
    executionKind: "SOURCE_DEVICE",
    reconciliationKind: "MASS_QUEUE",
    writeSemantics: "NON_IDEMPOTENT_WRITE",
    commitClass: "BUSINESS_COMMIT",
    idempotencyNamespace: "mass",
    idempotencyEmbedsCreator: true,
    requiredSuccessField: "queueId",
  }),
  MASS_QUEUE_CANCEL: Object.freeze({
    moduleKey: "mass",
    actionType: "MASS_QUEUE_CANCEL",
    permissionKey: "chats.mass_message",
    originKind: "INTERACTIVE",
    // Cancellation is an idempotent desired-state operation bound to the
    // server-side queue id. Any currently authorized device may safely
    // continue it after another device disappears.
    executionKind: "AUTHORIZED_DEVICE",
    reconciliationKind: "MASS_QUEUE_CANCEL",
    writeSemantics: "IDEMPOTENT_WRITE",
    // Desired-state retry semantics remain idempotent, but this physical write
    // still requires a server-bound permission/commit permit.
    commitClass: "BUSINESS_COMMIT",
    idempotencyNamespace: "mass-cancel",
    idempotencyEmbedsCreator: true,
    requiredSuccessField: "queueId",
  }),
  MASS_NATIVE_QUEUE_CREATE: Object.freeze({
    moduleKey: "mass",
    actionType: "MASS_NATIVE_QUEUE_CREATE",
    permissionKey: "chats.mass_message",
    originKind: "INTERACTIVE",
    executionKind: "SOURCE_DEVICE",
    reconciliationKind: "MASS_NATIVE_QUEUE",
    writeSemantics: "NON_IDEMPOTENT_WRITE",
    commitClass: "BUSINESS_COMMIT",
    idempotencyNamespace: "mass-native-create",
    idempotencyEmbedsCreator: true,
    requiredSuccessField: "queueId",
  }),
  MASS_NATIVE_QUEUE_CANCEL: Object.freeze({
    moduleKey: "mass",
    actionType: "MASS_NATIVE_QUEUE_CANCEL",
    permissionKey: "chats.mass_message",
    originKind: "INTERACTIVE",
    executionKind: "SOURCE_DEVICE",
    reconciliationKind: "MASS_NATIVE_QUEUE_CANCEL",
    writeSemantics: "IDEMPOTENT_WRITE",
    commitClass: "BUSINESS_COMMIT",
    idempotencyNamespace: "mass-native-cancel",
    idempotencyEmbedsCreator: true,
    requiredSuccessField: "queueId",
  }),
  VAULT_RELAY_SEND: Object.freeze({
    moduleKey: "vault",
    actionType: "VAULT_RELAY_SEND",
    permissionKey: "content.manage_vault",
    originKind: "INTERACTIVE",
    executionKind: "SOURCE_DEVICE",
    reconciliationKind: "VAULT_RELAY",
    writeSemantics: "NON_IDEMPOTENT_WRITE",
    commitClass: "BUSINESS_COMMIT",
    idempotencyNamespace: "vault-relay",
    idempotencyEmbedsCreator: true,
    requiredSuccessField: "mediaId",
  }),
  VAULT_CREATE_LIST: Object.freeze({
    moduleKey: "vault",
    actionType: "VAULT_CREATE_LIST",
    permissionKey: "content.manage_vault",
    originKind: "INTERACTIVE",
    executionKind: "SOURCE_DEVICE",
    reconciliationKind: "VAULT_LIST",
    writeSemantics: "NON_IDEMPOTENT_WRITE",
    commitClass: "BUSINESS_COMMIT",
    idempotencyNamespace: "vault-create-list",
    idempotencyEmbedsCreator: true,
    requiredSuccessField: "folderId",
  }),
  CUSTOM_RELAY_SEND: Object.freeze({
    moduleKey: "customs",
    actionType: "CUSTOM_RELAY_SEND",
    permissionKey: null,
    originKind: "SYSTEM",
    executionKind: "AUTHORIZED_DEVICE",
    reconciliationKind: "CUSTOM_RELAY",
    writeSemantics: "NON_IDEMPOTENT_WRITE",
    commitClass: "BUSINESS_COMMIT",
    idempotencyNamespace: "custom-relay",
    idempotencyEmbedsCreator: false,
    requiredSuccessField: "mediaId",
  }),
  CUSTOM_MANUAL_SEND: Object.freeze({
    moduleKey: "customs",
    actionType: "CUSTOM_MANUAL_SEND",
    permissionKey: "chats.reply",
    originKind: "INTERACTIVE",
    executionKind: "AUTHORIZED_DEVICE",
    reconciliationKind: "CUSTOM_MANUAL_DELIVERY",
    writeSemantics: "NON_IDEMPOTENT_WRITE",
    commitClass: "BUSINESS_COMMIT",
    idempotencyNamespace: "custom-manual",
    idempotencyEmbedsCreator: false,
    requiredSuccessField: "messageId",
    allowPrecommitPayloadRebind: true,
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

const MASS_QUEUE_CREATE_KINDS = new Set(["MASS_QUEUE_CREATE", "MASS_NATIVE_QUEUE_CREATE"]);
const MASS_PROVIDER_OBSERVED_KIND = "MASS_PROVIDER_QUEUE_OBSERVED";
const MASS_REMOTE_QUEUE_KINDS = new Set([...MASS_QUEUE_CREATE_KINDS, MASS_PROVIDER_OBSERVED_KIND]);
const MASS_QUEUE_CANCEL_KINDS = new Set(["MASS_QUEUE_CANCEL", "MASS_NATIVE_QUEUE_CANCEL"]);
function isMassQueueCreateKind(kind) { return MASS_QUEUE_CREATE_KINDS.has(String(kind || "").toUpperCase()); }
function isMassRemoteQueueKind(kind) { return MASS_REMOTE_QUEUE_KINDS.has(String(kind || "").toUpperCase()); }
function isMassQueueCancelKind(kind) { return MASS_QUEUE_CANCEL_KINDS.has(String(kind || "").toUpperCase()); }

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
function mintLease(now = new Date(), leaseMs = DEFAULT_LEASE_MS) {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token), until: new Date(now.getTime() + leaseDuration(leaseMs)) };
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
    targetId: delivery.targetId || null,
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
    intentAcknowledgedAt: delivery.intentAcknowledgedAt || null,
    remoteLifecycleState: delivery.remoteLifecycleState || null,
    remoteTargetId: delivery.remoteTargetId || null,
    remoteLifecycleObservedAt: delivery.remoteLifecycleObservedAt || null,
    remoteSettledAt: delivery.remoteSettledAt || null,
    finishedAt: delivery.finishedAt || null,
    createdAt: delivery.createdAt || null,
    updatedAt: delivery.updatedAt || null,
  };
}
function assertProgrammaticIdempotencyNamespace(kind, config, creatorId, idempotencyKey) {
  const key = clean(idempotencyKey, 500);
  const namespace = clean(config.idempotencyNamespace, 80);
  if (!key || !namespace) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_IDEMPOTENCY_NAMESPACE_INVALID", "Programmatic write idempotency namespace is not configured", 500);
  const prefix = `${namespace}:`;
  if (!key.startsWith(prefix)) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_IDEMPOTENCY_NAMESPACE_MISMATCH", `Idempotency key must use the ${namespace}: namespace for ${kind}`, 400);
  }
  const rest = key.slice(prefix.length);
  if (!rest) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_IDEMPOTENCY_SUFFIX_REQUIRED", "Programmatic write idempotency key suffix is required", 400);
  if (config.idempotencyEmbedsCreator) {
    const creatorPrefix = `${creatorId}:`;
    if (!rest.startsWith(creatorPrefix) || !rest.slice(creatorPrefix.length)) {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_IDEMPOTENCY_CREATOR_MISMATCH", "Programmatic write idempotency key is not bound to the requested creator", 400);
    }
  } else if (kind === "CUSTOM_RELAY_SEND") {
    const parts = rest.split(":");
    if (parts.length !== 2 || !clean(parts[0], 180) || !/^\d+$/.test(parts[1] || "")) {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_IDEMPOTENCY_NAMESPACE_MISMATCH", "Custom relay idempotency key must be custom-relay:<submissionId>:<index>", 400);
    }
  } else if (kind === "CUSTOM_MANUAL_SEND") {
    const parts = rest.split(":");
    if (parts.length !== 3 || !clean(parts[0], 180) || !clean(parts[1], 180) || !/^\d+$/.test(parts[2] || "")) {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_IDEMPOTENCY_NAMESPACE_MISMATCH", "Custom manual-send idempotency key must be custom-manual:<orderId>:<submissionId>:<deliveryPhase>", 400);
    }
  }
}
function assertCompletionEvidence(delivery, result) {
  const kind = storedProgrammaticKind(delivery);
  const { config } = productKind(kind);
  const field = clean(config.requiredSuccessField, 80);
  if (!field) return;
  const value = field === "folderId" ? clean(result.folderId || object(result.list).id, 180) : clean(result[field], 180);
  if (!value) {
    throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_COMPLETION_EVIDENCE_REQUIRED", `${kind} requires ${field} before durable success may be recorded`, 409);
  }
}
function assertPayloadBinding(existing, input, config) {
  if (existing.agencyId !== input.agencyId || existing.creatorId !== input.creatorId || existing.actionType !== config.actionType
      || existing.originKind !== config.originKind || existing.moduleKey !== config.moduleKey
      || existing.executionKind !== config.executionKind || existing.reconciliationKind !== config.reconciliationKind) {
    throw new ProgrammaticOfWriteAuthorityError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another programmatic write authority identity", 409);
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


const CLIENT_RESULT_FIELDS = Object.freeze({
  MASS_QUEUE_CREATE: Object.freeze({ checkpoint: [], complete: ["queueId", "dispatchId", "audienceCount", "audienceHash", "contentHash"], reconcile: ["dispatchId", "audienceCount", "audienceHash", "contentHash", "candidates", "successfulReadback", "negativeObservationIsNotProof"] }),
  MASS_QUEUE_CANCEL: Object.freeze({ checkpoint: [], complete: ["queueId", "alreadyAbsent"], reconcile: ["queueId", "alreadyAbsent"] }),
  MASS_NATIVE_QUEUE_CREATE: Object.freeze({ checkpoint: [], complete: [], reconcile: [] }),
  MASS_NATIVE_QUEUE_CANCEL: Object.freeze({ checkpoint: [], complete: [], reconcile: [] }),
  VAULT_CREATE_LIST: Object.freeze({ checkpoint: ["vaultListPreflight"], complete: ["list", "folderId", "vaultListPreflight", "clientRequestId"], reconcile: ["list", "folderId", "vaultListPreflight", "clientRequestId", "vaultListProofKind", "vaultListReason", "vaultListCandidateIds", "vaultListNewIds", "reconciliationEvidenceInsufficient", "negativeObservationIsNotProof"] }),
  VAULT_RELAY_SEND: Object.freeze({ checkpoint: ["relayPreflight"], complete: ["mediaId", "mediaType", "mediaIsReady", "messageId", "relayPreflight"], reconcile: ["mediaId", "mediaType", "mediaIsReady", "messageId", "relayPreflight", "relayReconcileReason", "relayReadbackError", "relayReadbackCovered", "relayCandidateCount", "relayUncertainCandidateCount", "relayApproximateMatchIsNotProof", "negativeObservationIsNotProof"] }),
  CUSTOM_RELAY_SEND: Object.freeze({ checkpoint: ["relayPreflight"], complete: ["mediaId", "mediaType", "mediaIsReady", "messageId", "relayPreflight"], reconcile: ["mediaId", "mediaType", "mediaIsReady", "messageId", "relayPreflight", "relayReconcileReason", "relayReadbackError", "relayReadbackCovered", "relayCandidateCount", "relayUncertainCandidateCount", "relayApproximateMatchIsNotProof", "negativeObservationIsNotProof"] }),
  CUSTOM_MANUAL_SEND: Object.freeze({ checkpoint: [], complete: [], reconcile: [] }),
});
function storedProgrammaticKind(delivery) { return clean(object(delivery?.result).programmaticWriteKind, 80)?.toUpperCase() || null; }
function sanitizeClientResult(delivery, value, phase) {
  const source = object(value);
  const kind = storedProgrammaticKind(delivery);
  const allowed = new Set(CLIENT_RESULT_FIELDS[kind]?.[phase] || []);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key)));
}

async function sweepExpiredProgrammaticWriteLeases({ db = prisma, agencyId, creatorId = null, creatorIds = null, now = new Date() } = {}) {
  const scopedCreatorIds = Array.isArray(creatorIds) ? [...new Set(creatorIds.map(String).filter(Boolean))] : null;
  const creatorWhere = creatorId ? { creatorId } : (scopedCreatorIds ? { creatorId: { in: scopedCreatorIds.length ? scopedCreatorIds : ["__none__"] } } : {});
  const scopeWhere = { ...(agencyId ? { agencyId } : {}), originKind: { not: "AUTOMATION" }, ...creatorWhere };
  let changed = 0;
  const scanAll = async ({ where, select }, visit) => {
    let afterId = null;
    for (;;) {
      const page = await db.automationDelivery.findMany({
        where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) },
        select,
        orderBy: { id: "asc" },
        take: 500,
      });
      if (!page.length) return;
      for (const row of page) await visit(row);
      afterId = String(page[page.length - 1]?.id || "");
      if (!afterId || page.length < 500) return;
    }
  };
  const closeIfBoundExpired = async (row, where) => {
    const result = object(row.result);
    const startedAt = new Date(result.reconciliationStartedAt || row.writeCommitAt || now);
    if (!Number.isFinite(startedAt.getTime()) || now.getTime() - startedAt.getTime() < MAX_RECONCILIATION_WAIT_MS) return false;
    const closed = await db.automationDelivery.updateMany({
      where,
      data: {
        status: "FAILED",
        failureCode: "outcome_unresolved_do_not_retry",
        failureCategory: FAILURE_CATEGORIES.TERMINAL,
        ...(isMassQueueCreateKind(storedProgrammaticKind(row)) ? { remoteLifecycleState: "UNKNOWN", remoteLifecycleObservedAt: now, remoteSettledAt: null } : {}),
        lastError: "Reconciliation owner disappeared and the bounded verification window expired; logical commit closed permanently without retry",
        result: { ...result, outcomeState: "UNRESOLVED_DO_NOT_RETRY", unresolvedClosedAt: now.toISOString(), unresolvedCloseReason: "MAINTENANCE_RECONCILIATION_WINDOW_EXPIRED" },
        finishedAt: now, claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 }, lastCheckedAt: now,
      },
    });
    changed += closed.count;
    return Boolean(closed.count);
  };
  await scanAll({
    where: {
      ...scopeWhere,
      status: { in: ["CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"] },
      claimUntil: { lte: now },
    },
    select: { id: true, status: true, leaseRevision: true, result: true, writeCommitRevision: true, failureCode: true, writeCommitAt: true },
  }, async (row) => {
    const precommit = row.status === "CLAIMED" || row.status === "RUNNING";
    const reconciling = row.status === "RECONCILE_REQUIRED";
    if (reconciling && await closeIfBoundExpired(row, { id: row.id, status: row.status, leaseRevision: row.leaseRevision, claimUntil: { lte: now } })) return;
    const nextStatus = precommit ? "RETRY_SCHEDULED" : "RECONCILE_REQUIRED";
    const data = {
      status: nextStatus, claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 }, lastCheckedAt: now,
      ...(precommit ? {
        failureCode: "programmatic_precommit_lease_expired", failureCategory: FAILURE_CATEGORIES.DEFINITE_NO_WRITE_RETRYABLE,
        result: { ...object(row.result), outcomeState: "PROVEN_NO_EFFECT", leaseExpiredAt: now.toISOString() },
      } : {
        failureCode: row.failureCode || "write_outcome_unknown", failureCategory: FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE,
        result: { ...object(row.result), outcomeState: "RECONCILE_REQUIRED", reconciliationStartedAt: object(row.result).reconciliationStartedAt || row.writeCommitAt?.toISOString?.() || now.toISOString(), reconciliationLeaseExpiredAt: now.toISOString() },
      }),
    };
    const result = await db.automationDelivery.updateMany({ where: { id: row.id, status: row.status, leaseRevision: row.leaseRevision, claimUntil: { lte: now } }, data });
    changed += result.count;
  });
  // A reconciler may disappear and leave a deliberately unleased RECONCILE_REQUIRED
  // row. It still owns the global creator write lane, so maintenance must eventually
  // close it no-retry once the original bounded verification window expires.
  await scanAll({
    where: { ...scopeWhere, status: "RECONCILE_REQUIRED", claimUntil: null },
    select: { id: true, status: true, leaseRevision: true, result: true, failureCode: true, writeCommitAt: true },
  }, async (row) => {
    await closeIfBoundExpired(row, { id: row.id, status: "RECONCILE_REQUIRED", leaseRevision: row.leaseRevision, claimUntil: null });
  });
  return changed;
}


function massIntentTerminalOutcome(delivery) {
  if (!delivery) return null;
  if (delivery.status === "COMPLETED") return "PROVEN_SUCCESS";
  if (delivery.status === "FAILED" && delivery.failureCode === "outcome_unresolved_do_not_retry") return "UNRESOLVED_DO_NOT_RETRY";
  // Terminal pre-wire rejection/no-effect is a real logical MASS outcome. It
  // must be acknowledgeable; otherwise the one-unacknowledged-intent unique
  // index permanently deadlocks the creator after a correct fail-closed fence.
  if (["FAILED", "SKIPPED", "CANCELED"].includes(String(delivery.status || ""))) return "PROVEN_NO_EFFECT";
  return null;
}

async function reserveMassLogicalIntent(input) {
  const { config } = productKind("MASS_QUEUE_CREATE");
  const agencyId = clean(input.agencyId, 180);
  const userId = clean(input.userId, 180);
  const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180);
  const deviceId = clean(input.deviceId, 180);
  const dispatchId = clean(input.dispatchId, 180);
  const payloadFingerprint = clean(input.payloadFingerprint, 200);
  const accessEpoch = Number(input.accessEpoch);
  if (!agencyId || !userId || !memberId || !creatorId || !deviceId || !dispatchId || !payloadFingerprint || !Number.isInteger(accessEpoch) || accessEpoch < 0) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_RESERVE_INVALID", "MASS logical intent identity, actor, device and fingerprint are required", 400);
  }
  const idempotencyKey = `mass:${creatorId}:${dispatchId}`;
  assertProgrammaticIdempotencyNamespace("MASS_QUEUE_CREATE", config, creatorId, idempotencyKey);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
    await lockAgencyPipelineLifecycle({ db: tx, agencyId });
    await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId });
    await assertDevice({ db: tx, agencyId, userId, deviceId });
    await assertLiveActor({ db: tx, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: config.permissionKey });
    const { invalidateCreatorMassProviderRetirementProof } = require("./mass-campaign-authority-service");
    await invalidateCreatorMassProviderRetirementProof({
      db: tx, agencyId, creatorId, reason: "MASS logical intent reserved/replayed after retirement snapshot", now,
    });

    const current = await tx.automationDelivery.findFirst({
      where: { agencyId, creatorId, actionType: "MASS_QUEUE_CREATE", intentAcknowledgedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (current) {
      if (clean(current.payloadFingerprint, 200) !== payloadFingerprint) {
        throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_ACK_REQUIRED", "Another unacknowledged MASS logical intent already exists for this creator", 409);
      }
      return {
        ok: true,
        replay: true,
        ownedByThisDevice: current.sourceDeviceId === deviceId,
        terminalOutcome: massIntentTerminalOutcome(current),
        canAbandonPrecommit: !current.writeCommitAt && !["COMMITTING", "RECONCILE_REQUIRED"].includes(String(current.status || "")),
        delivery: publicDelivery(current),
      };
    }

    const unresolvedSamePayload = await tx.automationDelivery.findFirst({
      where: {
        agencyId, creatorId, actionType: "MASS_QUEUE_CREATE", payloadFingerprint,
        status: "FAILED", failureCode: "outcome_unresolved_do_not_retry",
        OR: [{ remoteLifecycleState: null }, { remoteLifecycleState: { not: "SETTLED" } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (unresolvedSamePayload) {
      throw new ProgrammaticOfWriteAuthorityError(
        "MASS_UNRESOLVED_SAME_PAYLOAD",
        "A previous MASS send with the same reviewed audience/content has an unresolved remote outcome. Refresh/cancel native queues until that remote debt is settled before attempting the same payload again.",
        409,
      );
    }

    const reused = await tx.automationDelivery.findUnique({ where: { idempotencyKey } });
    if (reused) {
      if (clean(reused.payloadFingerprint, 200) !== payloadFingerprint || reused.creatorId !== creatorId || reused.actionType !== "MASS_QUEUE_CREATE") {
        throw new ProgrammaticOfWriteAuthorityError("IDEMPOTENCY_CONFLICT", "MASS dispatchId is already bound to another logical intent", 409);
      }
      throw new ProgrammaticOfWriteAuthorityError("MASS_DISPATCH_ID_ALREADY_USED", "This MASS dispatchId was already acknowledged; start a new logical intent with a new dispatchId", 409);
    }

    let delivery;
    try {
      delivery = await tx.automationDelivery.create({
        data: {
          agencyId, creatorId,
          moduleKey: config.moduleKey,
          actionType: config.actionType,
          targetId: dispatchId,
          idempotencyKey,
          payload: object(input.payload),
          status: "QUEUED",
          scheduledAt: now,
          notBefore: now,
          maxAttempts: Math.max(1, Math.min(20, Number(input.maxAttempts) || 8)),
          createdByUserId: userId,
          originKind: config.originKind,
          sourceDeviceId: deviceId,
          payloadFingerprint,
          executionKind: config.executionKind,
          reconciliationKind: config.reconciliationKind,
          intentAcknowledgedAt: null,
          remoteLifecycleState: "PRECOMMIT",
          remoteLifecycleObservedAt: now,
          result: { reservedAt: now.toISOString(), logicalIntentReservedAt: now.toISOString(), programmaticWriteKind: "MASS_QUEUE_CREATE" },
        },
      });
    } catch (error) {
      if (error?.code === "P2002") {
        throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_RESERVE_RACE", "Another device reserved the MASS logical intent concurrently; retry to recover the server-canonical intent", 409);
      }
      throw error;
    }
    return { ok: true, replay: false, ownedByThisDevice: true, terminalOutcome: null, canAbandonPrecommit: true, delivery: publicDelivery(delivery) };
  }, { timeout: 30_000 });
}

async function getCurrentMassLogicalIntent(input) {
  const agencyId = clean(input.agencyId, 180); const userId = clean(input.userId, 180); const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180); const deviceId = clean(input.deviceId, 180); const accessEpoch = Number(input.accessEpoch);
  if (!agencyId || !userId || !memberId || !creatorId || !deviceId || !Number.isInteger(accessEpoch) || accessEpoch < 0) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_GET_INVALID", "MASS logical intent actor/device identity is required", 400);
  }
  await assertDevice({ db: prisma, agencyId, userId, deviceId });
  await assertLiveActor({ db: prisma, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: "chats.mass_message" });
  const delivery = await prisma.automationDelivery.findFirst({
    where: { agencyId, creatorId, actionType: "MASS_QUEUE_CREATE", intentAcknowledgedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!delivery) return { ok: true, intent: null };
  return {
    ok: true,
    intent: publicDelivery(delivery),
    terminalOutcome: massIntentTerminalOutcome(delivery),
    ownedByThisDevice: delivery.sourceDeviceId === deviceId,
    canAbandonPrecommit: !delivery.writeCommitAt && !["COMMITTING", "RECONCILE_REQUIRED"].includes(String(delivery.status || "")),
  };
}

async function acknowledgeMassLogicalIntent(input) {
  const agencyId = clean(input.agencyId, 180); const userId = clean(input.userId, 180); const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180); const deviceId = clean(input.deviceId, 180); const dispatchId = clean(input.dispatchId, 180); const accessEpoch = Number(input.accessEpoch);
  if (!agencyId || !userId || !memberId || !creatorId || !deviceId || !dispatchId || !Number.isInteger(accessEpoch) || accessEpoch < 0) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_ACK_INVALID", "MASS logical intent acknowledgement identity is required", 400);
  }
  return prisma.$transaction(async (tx) => {
    await assertDevice({ db: tx, agencyId, userId, deviceId });
    await assertLiveActor({ db: tx, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: "chats.mass_message" });
    const delivery = await tx.automationDelivery.findFirst({ where: { agencyId, creatorId, actionType: "MASS_QUEUE_CREATE", targetId: dispatchId } });
    if (!delivery) throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_NOT_FOUND", "MASS logical intent was not found", 404);
    if (delivery.intentAcknowledgedAt) return { ok: true, duplicate: true, terminalOutcome: massIntentTerminalOutcome(delivery), delivery: publicDelivery(delivery) };
    if (!massIntentTerminalOutcome(delivery)) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_NOT_TERMINAL", "Active MASS logical intent cannot be acknowledged before a terminal outcome", 409);
    }
    const now = new Date();
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, intentAcknowledgedAt: null, status: delivery.status },
      data: { intentAcknowledgedAt: now, result: { ...object(delivery.result), massIntentAcknowledgedAt: now.toISOString() } },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_ACK_RACE", "MASS logical intent changed before acknowledgement", 409);
    const acknowledged = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    return { ok: true, terminalOutcome: massIntentTerminalOutcome(acknowledged), delivery: publicDelivery(acknowledged) };
  }, { timeout: 30_000 });
}

async function abandonMassLogicalIntentPrecommit(input) {
  const agencyId = clean(input.agencyId, 180); const userId = clean(input.userId, 180); const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180); const deviceId = clean(input.deviceId, 180); const dispatchId = clean(input.dispatchId, 180); const accessEpoch = Number(input.accessEpoch);
  if (!agencyId || !userId || !memberId || !creatorId || !deviceId || !dispatchId || !Number.isInteger(accessEpoch) || accessEpoch < 0) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_ABANDON_INVALID", "MASS logical intent abandon identity is required", 400);
  }
  return prisma.$transaction(async (tx) => {
    const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
    await lockAgencyPipelineLifecycle({ db: tx, agencyId });
    await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId });
    await lockAutomationWriteCommitFence({ db: tx, agencyId });
    await assertDevice({ db: tx, agencyId, userId, deviceId });
    await assertLiveActor({ db: tx, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: "chats.mass_message" });
    const delivery = await tx.automationDelivery.findFirst({ where: { agencyId, creatorId, actionType: "MASS_QUEUE_CREATE", targetId: dispatchId, intentAcknowledgedAt: null } });
    if (!delivery) throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_NOT_FOUND", "Unacknowledged MASS logical intent was not found", 404);
    if (delivery.writeCommitAt || ["COMMITTING", "RECONCILE_REQUIRED"].includes(String(delivery.status || ""))) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_WORK_EXISTS", "MASS intent reached the external commit boundary and cannot be abandoned as precommit", 409);
    }
    if (TERMINAL_STATUSES.has(delivery.status) && delivery.status !== "CANCELED") {
      throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_NOT_PRECOMMIT", "Terminal MASS result must be acknowledged instead of abandoned", 409);
    }
    const now = new Date();
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, writeCommitAt: null, intentAcknowledgedAt: null, leaseRevision: delivery.leaseRevision },
      data: {
        status: "CANCELED", intentAcknowledgedAt: now, remoteLifecycleState: "SETTLED", remoteLifecycleObservedAt: now, remoteSettledAt: now,
        failureCode: "mass_intent_abandoned_precommit", failureCategory: FAILURE_CATEGORIES.TERMINAL,
        lastError: "MASS logical intent was explicitly abandoned before external commit", finishedAt: now, claimUntil: null, leaseTokenHash: null,
        result: { ...object(delivery.result), outcomeState: "PROVEN_NO_EFFECT", massIntentAbandonedAt: now.toISOString(), massIntentAcknowledgedAt: now.toISOString() },
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("MASS_INTENT_ABANDON_RACE", "MASS logical intent changed before precommit abandon", 409);
    return { ok: true, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
  }, { timeout: 30_000 });
}

function massQueueSnapshotPurpose(value) {
  const purpose = clean(value, 40)?.toUpperCase() || "BROWSE";
  if (!["BROWSE", "RETIREMENT"].includes(purpose)) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_PURPOSE_INVALID", "MASS queue snapshot purpose must be BROWSE or RETIREMENT", 400);
  }
  return purpose;
}

function massQueueSnapshotPermission(purpose) {
  return purpose === "RETIREMENT" ? "creators.manage" : "chats.mass_message";
}

async function beginMassRemoteQueueSnapshot(input) {
  const agencyId = clean(input.agencyId, 180); const userId = clean(input.userId, 180); const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180); const deviceId = clean(input.deviceId, 180); const accessEpoch = Number(input.accessEpoch);
  const purpose = massQueueSnapshotPurpose(input.purpose);
  if (!agencyId || !userId || !memberId || !creatorId || !deviceId || !Number.isInteger(accessEpoch) || accessEpoch < 0) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_FENCE_INVALID", "MASS queue snapshot actor/device identity is required", 400);
  }
  await assertDevice({ db: prisma, agencyId, userId, deviceId });
  await assertLiveActor({ db: prisma, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: massQueueSnapshotPermission(purpose) });
  const now = new Date();
  purgeMassQueueSnapshotFences(now.getTime());
  const token = crypto.randomUUID();
  massQueueSnapshotFences.set(token, { agencyId, userId, memberId, creatorId, deviceId, accessEpoch, purpose, fenceAt: now, expiresAtMs: now.getTime() + MASS_QUEUE_SNAPSHOT_FENCE_TTL_MS });
  return { ok: true, purpose, snapshotFenceToken: token, fenceAt: now.toISOString(), expiresAt: new Date(now.getTime() + MASS_QUEUE_SNAPSHOT_FENCE_TTL_MS).toISOString() };
}

function consumeMassQueueSnapshotFence(input) {
  const token = clean(input.snapshotFenceToken, 180);
  if (!token) throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_FENCE_REQUIRED", "A server-issued MASS queue snapshot fence is required", 400);
  purgeMassQueueSnapshotFences();
  const fence = massQueueSnapshotFences.get(token);
  massQueueSnapshotFences.delete(token);
  if (!fence) throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_FENCE_EXPIRED", "MASS queue snapshot fence is missing, expired, consumed, or belongs to another backend process; refresh the queue again", 409);
  for (const key of ["agencyId", "userId", "memberId", "creatorId", "deviceId"]) {
    if (String(fence[key] || "") !== String(input[key] || "")) throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_FENCE_MISMATCH", "MASS queue snapshot fence belongs to another actor/device/creator", 403);
  }
  if (Number(fence.accessEpoch) !== Number(input.accessEpoch)) throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_FENCE_MISMATCH", "MASS queue snapshot fence belongs to another access epoch", 403);
  if (String(fence.purpose || "BROWSE") !== massQueueSnapshotPurpose(input.purpose)) throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_FENCE_MISMATCH", "MASS queue snapshot fence belongs to another purpose", 403);
  return fence;
}

async function reconcileMassRemoteQueueSnapshot(input) {
  const agencyId = clean(input.agencyId, 180); const userId = clean(input.userId, 180); const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180); const deviceId = clean(input.deviceId, 180); const accessEpoch = Number(input.accessEpoch);
  const purpose = massQueueSnapshotPurpose(input.purpose);
  if (!agencyId || !userId || !memberId || !creatorId || !deviceId || !Number.isInteger(accessEpoch) || accessEpoch < 0) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_INVALID", "A complete live MASS queue snapshot and actor/device identity are required", 400);
  }
  const fence = consumeMassQueueSnapshotFence({ ...input, agencyId, userId, memberId, creatorId, deviceId, accessEpoch, purpose });
  const rawQueueIds = (Array.isArray(input.queueIds) ? input.queueIds : []).map((value) => clean(value, 180)).filter(Boolean);
  const liveQueueIds = Array.from(new Set(rawQueueIds));
  const snapshotItemCount = Number(input.snapshotItemCount);
  if (!Number.isInteger(snapshotItemCount) || snapshotItemCount < 0 || snapshotItemCount !== rawQueueIds.length || liveQueueIds.length !== rawQueueIds.length) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_SNAPSHOT_IDENTITY_INCOMPLETE", "Every provider queue row must have one unique exact queue id before absence may settle lifecycle state", 409);
  }
  return prisma.$transaction(async (tx) => {
    const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
    await lockAgencyPipelineLifecycle({ db: tx, agencyId });
    await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId });
    await assertDevice({ db: tx, agencyId, userId, deviceId });
    await assertLiveActor({ db: tx, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: massQueueSnapshotPermission(purpose) });
    const now = new Date();
    const { invalidateCreatorMassProviderRetirementProof } = require("./mass-campaign-authority-service");
    await invalidateCreatorMassProviderRetirementProof({
      db: tx, agencyId, creatorId, reason: `MASS ${purpose} provider reconciliation superseded the prior retirement snapshot`, now,
    });

    // A complete provider snapshot is itself durable evidence. Queues that were
    // created manually, by an older client, or before this authority existed
    // must become server-visible retirement blockers instead of disappearing
    // merely because no AutomationDelivery happened to exist yet. Do not put
    // the provider's whole set into Prisma IN/NOT IN predicates: a complete
    // snapshot may legitimately contain tens of thousands of ids and exceed
    // PostgreSQL's bind-parameter ceiling. Compare in memory, then mutate by
    // bounded primary-key chunks.
    const liveQueueIdSet = new Set(liveQueueIds);
    const knownRemoteRows = await tx.automationDelivery.findMany({
      where: { agencyId, creatorId, actionType: { in: [...MASS_REMOTE_QUEUE_KINDS] }, remoteTargetId: { not: null } },
      select: { id: true, remoteTargetId: true, remoteLifecycleState: true, remoteLifecycleObservedAt: true },
    });
    const knownIds = new Set(knownRemoteRows.map((row) => clean(row.remoteTargetId, 180)).filter(Boolean));
    const missing = liveQueueIds.filter((queueId) => !knownIds.has(queueId));
    let providerObservedCreated = 0;
    for (let offset = 0; offset < missing.length; offset += 500) {
      const chunk = missing.slice(offset, offset + 500);
      if (!chunk.length) continue;
      const created = await tx.automationDelivery.createMany({
        data: chunk.map((queueId) => ({
          agencyId, creatorId, moduleKey: "mass", actionType: MASS_PROVIDER_OBSERVED_KIND, targetId: queueId,
          idempotencyKey: `mass-provider-observed:${agencyId}:${creatorId}:${queueId}`,
          payload: { providerObservedQueueId: queueId }, status: "COMPLETED", scheduledAt: now, notBefore: now,
          maxAttempts: 1, createdByUserId: userId, originKind: "PROVIDER_OBSERVATION", sourceDeviceId: deviceId,
          executionKind: "NONE", reconciliationKind: "MASS_QUEUE", intentAcknowledgedAt: now,
          remoteLifecycleState: "PENDING", remoteTargetId: queueId, remoteLifecycleObservedAt: now, remoteSettledAt: null,
          result: { outcomeState: "PROVIDER_OBSERVED", providerObservedAt: now.toISOString(), queueId }, finishedAt: now,
        })),
        skipDuplicates: true,
      });
      providerObservedCreated += Number(created?.count || 0);
    }

    const updateRemoteRowsByIds = async (ids, data) => {
      let count = 0;
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const chunk = ids.slice(offset, offset + 1000);
        if (!chunk.length) continue;
        const result = await tx.automationDelivery.updateMany({ where: { id: { in: chunk } }, data });
        count += Number(result?.count || 0);
      }
      return count;
    };
    const observedBeforeFence = (row) => row.remoteLifecycleObservedAt instanceof Date && row.remoteLifecycleObservedAt <= fence.fenceAt;
    const fencedKnownRemote = knownRemoteRows.filter((row) => observedBeforeFence(row));

    // The fresh complete provider snapshot is the authority for remote presence.
    // A previously SETTLED row must reopen when its exact queue id is live again
    // (for example after provider read inconsistency/resurrection), otherwise the
    // historical projection could incorrectly release retirement while OF still
    // has a pending queue. Conversely, exact known ids that are absent may settle
    // regardless of whether their previous projection was PENDING, migration, or
    // UNKNOWN. UNKNOWN without a target id remains unattributable and is handled
    // separately below.
    const pendingIds = fencedKnownRemote
      .filter((row) => liveQueueIdSet.has(clean(row.remoteTargetId, 180)))
      .map((row) => row.id);
    const settledIds = fencedKnownRemote
      .filter((row) => clean(row.remoteTargetId, 180) && !liveQueueIdSet.has(clean(row.remoteTargetId, 180)))
      .map((row) => row.id);

    let pending = providerObservedCreated;
    let settled = 0;
    pending += await updateRemoteRowsByIds(pendingIds, { remoteLifecycleState: "PENDING", remoteLifecycleObservedAt: now, remoteSettledAt: null });
    settled += await updateRemoteRowsByIds(settledIds, { remoteLifecycleState: "SETTLED", remoteLifecycleObservedAt: now, remoteSettledAt: now });

    if (!liveQueueIds.length) {
      // UNKNOWN without an exact remote target cannot be attributed while any
      // provider queue exists. A complete empty snapshot proves only the narrower
      // future-effect fact: no MASS queue remains for this creator. Keep logical
      // write history unresolved forever, but release its remote lifecycle debt.
      const unknownRows = await tx.automationDelivery.findMany({
        where: {
          agencyId, creatorId, actionType: { in: [...MASS_REMOTE_QUEUE_KINDS] },
          remoteLifecycleState: "UNKNOWN", remoteTargetId: null, remoteLifecycleObservedAt: { lte: fence.fenceAt },
        },
        select: { id: true },
      });
      settled += await updateRemoteRowsByIds(unknownRows.map((row) => row.id), { remoteLifecycleState: "SETTLED", remoteLifecycleObservedAt: now, remoteSettledAt: now });
    }

    // A committed cancel is an idempotent desired-state write. A stable complete
    // provider snapshot that no longer contains its exact target queue proves the
    // desired state (queue absent), even when the DELETE response itself was lost.
    // Fence on writeCommitAt so a snapshot that started before a newer cancel was
    // permitted cannot settle that newer write from stale observation.
    const committedCancelBase = {
      agencyId,
      creatorId,
      actionType: { in: [...MASS_QUEUE_CANCEL_KINDS] },
      writeCommitAt: { not: null, lte: fence.fenceAt },
      targetId: { not: null },
      OR: [
        { status: { in: ["COMMITTING", "RECONCILE_REQUIRED"] } },
        { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
      ],
    };
    const committedCancels = await tx.automationDelivery.findMany({
      where: committedCancelBase,
      select: { id: true, targetId: true },
    });
    const settledCancelIds = committedCancels
      .filter((row) => !liveQueueIdSet.has(clean(row.targetId, 180)))
      .map((row) => row.id);
    const cancelSettled = await updateRemoteRowsByIds(settledCancelIds, {
      status: "COMPLETED",
      failureCode: null,
      failureCategory: null,
      lastError: null,
      remoteLifecycleState: "SETTLED",
      remoteLifecycleObservedAt: now,
      remoteSettledAt: now,
      finishedAt: now,
      claimUntil: null,
      leaseTokenHash: null,
      lastCheckedAt: now,
    });

    const unknown = await tx.automationDelivery.count({
      where: {
        agencyId, creatorId, actionType: { in: [...MASS_REMOTE_QUEUE_KINDS] },
        remoteLifecycleState: "UNKNOWN", remoteLifecycleObservedAt: { lte: fence.fenceAt },
      },
    });

    // Successful repeated-complete provider observation is also the retirement
    // proof. Keep one durable row per creator and refresh it only after the same
    // lifecycle transaction has reconciled every exact provider queue id. Delete
    // authority can therefore fail closed when nobody has actually observed OF.
    // BROWSE and RETIREMENT are different authorities. Never let a normal queue
    // refresh overwrite or satisfy the destructive retirement proof. Separate
    // durable identities also make a concurrent BROWSE refresh unable to erase
    // a just-completed RETIREMENT observation.
    const snapshotProofKey = `mass-provider-snapshot-proof:${agencyId}:${creatorId}:${purpose}`;
    const snapshotProofResult = {
      outcomeState: "PROVIDER_SNAPSHOT_PROVEN", purpose, providerSnapshotObservedAt: now.toISOString(),
      snapshotFenceAt: fence.fenceAt.toISOString(), snapshotItemCount, queueIdDigest: crypto.createHash("sha256").update(JSON.stringify(liveQueueIds)).digest("hex"),
    };
    const existingProof = await tx.automationDelivery.findUnique({ where: { idempotencyKey: snapshotProofKey } });
    if (existingProof) {
      await tx.automationDelivery.updateMany({
        where: { id: existingProof.id },
        data: {
          status: "COMPLETED", failureCode: null, failureCategory: null, lastError: null,
          sourceDeviceId: deviceId, createdByUserId: userId, payload: { snapshotPurpose: purpose },
          remoteLifecycleObservedAt: now, remoteSettledAt: now, result: snapshotProofResult, finishedAt: now, lastCheckedAt: now,
        },
      });
    } else {
      try {
        await tx.automationDelivery.create({
          data: {
            agencyId, creatorId, moduleKey: "mass", actionType: MASS_PROVIDER_SNAPSHOT_PROOF_ACTION, targetId: creatorId,
            idempotencyKey: snapshotProofKey, payload: { snapshotPurpose: purpose }, status: "COMPLETED", scheduledAt: now, notBefore: now,
            maxAttempts: 1, createdByUserId: userId, originKind: "PROVIDER_OBSERVATION", sourceDeviceId: deviceId, executionKind: "NONE",
            reconciliationKind: "MASS_PROVIDER_SNAPSHOT", intentAcknowledgedAt: now, remoteLifecycleState: "SETTLED",
            remoteLifecycleObservedAt: now, remoteSettledAt: now, result: snapshotProofResult, finishedAt: now, lastCheckedAt: now,
          },
        });
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        const racedProof = await tx.automationDelivery.findUnique({ where: { idempotencyKey: snapshotProofKey } });
        if (!racedProof) throw error;
        await tx.automationDelivery.updateMany({
          where: { id: racedProof.id },
          data: {
            status: "COMPLETED", failureCode: null, failureCategory: null, lastError: null,
            sourceDeviceId: deviceId, createdByUserId: userId, payload: { snapshotPurpose: purpose },
            remoteLifecycleObservedAt: now, remoteSettledAt: now, result: snapshotProofResult, finishedAt: now, lastCheckedAt: now,
          },
        });
      }
    }
    return { ok: true, purpose, liveQueueIds, pending, settled, cancelSettled, unknown, snapshotFenceAt: fence.fenceAt.toISOString(), observedAt: now.toISOString() };
  }, { timeout: 30_000 });
}


function mintWriteSettlementToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

function mintNativeMassSettlementToken() { return mintWriteSettlementToken(); }

async function readBoundNativeMassCommitGrant(input) {
  const agencyId = clean(input.agencyId, 180);
  const creatorId = clean(input.creatorId, 180);
  const deviceId = clean(input.deviceId, 180);
  const userId = clean(input.userId, 180);
  const kind = clean(input.kind, 80)?.toUpperCase();
  const idempotencyKey = clean(input.idempotencyKey, 500);
  const payloadFingerprint = clean(input.payloadFingerprint, 200);
  const requestKey = clean(input.requestKey, 500);
  const expectedWriteId = clean(input.writeId, 180);
  const expectedRevision = Number(input.writeCommitRevision || 0);
  const mintSettlement = input.mintSettlement === true;
  if (!agencyId || !creatorId || !deviceId || !userId || !kind || !idempotencyKey || !payloadFingerprint || !requestKey) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_SETTLEMENT_BINDING_INVALID", "Native MASS settlement binding is incomplete", 500);
  }
  return prisma.$transaction(async (tx) => {
    // Capability minting and exact response settlement share the same agency
    // commit fence. Without this serialization two simultaneous duplicate
    // preflights could both read the same result JSON and last-write-wins one
    // another's token hash, retroactively invalidating an already-issued grant.
    await lockAutomationWriteCommitFence({ db: tx, agencyId });
    const delivery = expectedWriteId
      ? await tx.automationDelivery.findUnique({ where: { id: expectedWriteId } })
      : await tx.automationDelivery.findUnique({ where: { idempotencyKey } });
    if (!delivery || delivery.agencyId !== agencyId || delivery.creatorId !== creatorId || delivery.sourceDeviceId !== deviceId
        || delivery.createdByUserId !== userId || storedProgrammaticKind(delivery) !== kind
        || clean(delivery.idempotencyKey, 500) !== idempotencyKey || clean(delivery.payloadFingerprint, 200) !== payloadFingerprint
        || clean(object(delivery.payload).nativeRequestKey, 500) !== requestKey) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_BINDING_MISMATCH", "Native MASS preflight replay belongs to another request/device/actor", 403);
    }
    if (delivery.status !== "COMMITTING" || !delivery.writeCommitAt || Number(delivery.writeCommitRevision || 0) < 1) {
      throw new ProgrammaticOfWriteAuthorityError(
        delivery.status === "COMPLETED" ? "MASS_NATIVE_WRITE_ALREADY_SETTLED" : "MASS_NATIVE_WRITE_NOT_COMMITTING",
        delivery.status === "COMPLETED"
          ? "Native MASS write already settled; another physical request must not be released"
          : `Native MASS write status is ${delivery.status}; no physical commit capability can be minted`,
        409,
      );
    }
    if (expectedRevision > 0 && Number(delivery.writeCommitRevision) !== expectedRevision) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_COMMIT_REVISION_MISMATCH", "Native MASS preflight commit revision changed before capability minting", 409);
    }
    if (!mintSettlement) return { delivery, settlement: null };
    const settlement = mintNativeMassSettlementToken();
    const currentResult = object(delivery.result);
    const priorSettlementHashes = (Array.isArray(currentResult.nativeSettlementTokenHashes) ? currentResult.nativeSettlementTokenHashes : [])
      .map((value) => clean(value, 200)).filter(Boolean);
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "COMMITTING", writeCommitRevision: delivery.writeCommitRevision },
      data: { result: { ...currentResult, nativeSettlementTokenHashes: [...priorSettlementHashes, settlement.hash] } },
    });
    if (!changed.count) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_SETTLEMENT_CAPABILITY_RACE", "Native MASS write changed before settlement capability could be attached", 409);
    }
    return { delivery, settlement };
  }, { timeout: 30_000 });
}



async function appendCustomManualSettlementCapabilityTx(tx, delivery) {
  const settlement = mintWriteSettlementToken();
  const currentResult = object(delivery.result);
  const priorHashes = (Array.isArray(currentResult.customManualSettlementTokenHashes) ? currentResult.customManualSettlementTokenHashes : [])
    .map((value) => clean(value, 200)).filter(Boolean);
  const changed = await tx.automationDelivery.updateMany({
    where: { id: delivery.id, status: "COMMITTING", writeCommitRevision: delivery.writeCommitRevision },
    data: { result: { ...currentResult, customManualSettlementTokenHashes: [...priorHashes, settlement.hash] } },
  });
  if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("CUSTOM_MANUAL_SETTLEMENT_CAPABILITY_RACE", "Custom manual write changed before settlement capability could be attached", 409);
  return settlement;
}

async function attachCustomManualSettlementCapability(input) {
  const agencyId = clean(input.agencyId, 180);
  const creatorId = clean(input.creatorId, 180);
  const deviceId = clean(input.deviceId, 180);
  const userId = clean(input.userId, 180);
  const writeId = clean(input.writeId, 180);
  const idempotencyKey = clean(input.idempotencyKey, 500);
  const payloadFingerprint = clean(input.payloadFingerprint, 200);
  const networkRequestId = clean(input.networkRequestId, 220);
  const expectedRevision = Number(input.writeCommitRevision || 0);
  if (!agencyId || !creatorId || !deviceId || !userId || !idempotencyKey || !networkRequestId || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new ProgrammaticOfWriteAuthorityError("CUSTOM_MANUAL_SETTLEMENT_BINDING_INVALID", "Custom manual settlement binding is incomplete", 500);
  }
  return prisma.$transaction(async (tx) => {
    await lockAutomationWriteCommitFence({ db: tx, agencyId });
    const delivery = writeId
      ? await tx.automationDelivery.findUnique({ where: { id: writeId } })
      : await tx.automationDelivery.findUnique({ where: { idempotencyKey } });
    const payload = object(delivery?.payload);
    if (!delivery || delivery.agencyId !== agencyId || delivery.creatorId !== creatorId
        || delivery.sourceDeviceId !== deviceId || delivery.createdByUserId !== userId
        || storedProgrammaticKind(delivery) !== "CUSTOM_MANUAL_SEND"
        || clean(delivery.idempotencyKey, 500) !== idempotencyKey
        || (payloadFingerprint && clean(delivery.payloadFingerprint, 200) !== payloadFingerprint)
        || clean(payload.networkRequestId, 220) !== networkRequestId) {
      throw new ProgrammaticOfWriteAuthorityError("CUSTOM_MANUAL_WRITE_BINDING_MISMATCH", "Custom manual settlement capability belongs to another request/device/actor", 403);
    }
    if (delivery.status !== "COMMITTING" || !delivery.writeCommitAt || Number(delivery.writeCommitRevision || 0) < 1
        || (expectedRevision > 0 && Number(delivery.writeCommitRevision || 0) !== expectedRevision)) {
      throw new ProgrammaticOfWriteAuthorityError(
        delivery.status === "COMPLETED" ? "CUSTOM_MANUAL_WRITE_ALREADY_SETTLED" : "CUSTOM_MANUAL_WRITE_NOT_COMMITTING",
        delivery.status === "COMPLETED"
          ? "Custom manual write already settled; another physical request must not be released"
          : `Custom manual write status is ${delivery.status}; no settlement capability can be minted`,
        409,
      );
    }
    const settlement = await appendCustomManualSettlementCapabilityTx(tx, delivery);
    return {
      ok: true,
      writeId: delivery.id,
      writeCommitRevision: Number(delivery.writeCommitRevision),
      writeCommitAt: delivery.writeCommitAt,
      settlementToken: settlement.token,
    };
  }, { timeout: 30_000 });
}

async function settleNativeMassWriteProvenNoEffect(input) {
  const writeId = clean(input.writeId, 180);
  const settlementToken = clean(input.settlementToken, 500);
  const deviceId = clean(input.deviceId, 180);
  const requestKey = clean(input.requestKey, 500);
  const revision = Number(input.writeCommitRevision);
  const providerStatus = Number(input.providerStatus);
  if (!writeId || !settlementToken || !deviceId || !requestKey || !Number.isInteger(revision) || revision < 1 || !Number.isInteger(providerStatus)) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_REJECTION_PROOF_INVALID", "Native MASS rejection proof is incomplete", 400);
  }
  if (!isProviderStatusProvenNoEffect(providerStatus)) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_REJECTION_STATUS_AMBIGUOUS", `HTTP ${providerStatus} does not prove that no provider effect occurred`, 409);
  }
  return prisma.$transaction(async (tx) => {
    const initial = await tx.automationDelivery.findUnique({ where: { id: writeId } });
    if (!initial) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_NOT_FOUND", "Native MASS write authority was not found", 404);
    await lockAutomationWriteCommitFence({ db: tx, agencyId: initial.agencyId });
    const delivery = await tx.automationDelivery.findUnique({ where: { id: writeId } });
    const result = object(delivery?.result);
    const hashes = (Array.isArray(result.nativeSettlementTokenHashes) ? result.nativeSettlementTokenHashes : []).map((value) => clean(value, 200)).filter(Boolean);
    if (!delivery || !hashes.some((hash) => tokenMatches(settlementToken, hash))) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_SETTLEMENT_TOKEN_INVALID", "Native MASS settlement capability is invalid", 403);
    const kind = storedProgrammaticKind(delivery);
    if (!["MASS_NATIVE_QUEUE_CREATE", "MASS_NATIVE_QUEUE_CANCEL"].includes(kind)
        || delivery.sourceDeviceId !== deviceId || clean(object(delivery.payload).nativeRequestKey, 500) !== requestKey
        || Number(delivery.writeCommitRevision) !== revision) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_BINDING_MISMATCH", "Native MASS rejection belongs to another physical request", 403);
    }
    if (delivery.status === "FAILED" && delivery.failureCode === "provider_rejected_no_effect") return { ok: true, duplicate: true, provenNoEffect: true, delivery: publicDelivery(delivery) };
    if (!delivery.writeCommitAt) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_BINDING_MISMATCH", "Native MASS rejection belongs to a request that is no longer physically committed", 403);
    }
    if (!["COMMITTING", "RECONCILE_REQUIRED"].includes(String(delivery.status || ""))) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_NOT_SETTLEABLE", `Native MASS write status is ${delivery.status}`, 409);
    }
    const now = new Date();
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, writeCommitRevision: revision },
      data: {
        status: "FAILED", failureCode: "provider_rejected_no_effect", failureCategory: FAILURE_CATEGORIES.TERMINAL,
        lastError: `OnlyFans rejected the physical request with HTTP ${providerStatus}; no provider effect was committed`,
        writeCommitAt: null,
        result: { ...result, outcomeState: "PROVEN_NO_EFFECT", providerStatus, providerRejectedAt: now.toISOString() },
        finishedAt: now, claimUntil: null, leaseTokenHash: null, lastCheckedAt: now,
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_SETTLEMENT_RACE", "Native MASS write changed before rejection settlement", 409);
    return { ok: true, provenNoEffect: true, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
  }, { timeout: 30_000 });
}

async function authorizeNativeMassWrite(input) {
  const operation = clean(input.operation, 20)?.toUpperCase();
  const kind = operation === "CREATE" ? "MASS_NATIVE_QUEUE_CREATE" : operation === "CANCEL" ? "MASS_NATIVE_QUEUE_CANCEL" : null;
  const requestedAuthorityVersion = clean(input.authorityVersion, 40)?.toUpperCase();
  const authorityVersion = requestedAuthorityVersion === "MASS_NATIVE_V2" ? "MASS_NATIVE_V2" : "MASS_NATIVE_V3";
  if (!kind) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_OPERATION_INVALID", "Native MASS operation must be CREATE or CANCEL", 400);
  const agencyId = clean(input.agencyId, 180); const userId = clean(input.userId, 180); const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180); const deviceId = clean(input.deviceId, 180); const requestKey = clean(input.requestKey, 500);
  const accessEpoch = Number(input.accessEpoch); const queueId = clean(input.queueId, 180);
  if (!agencyId || !userId || !memberId || !creatorId || !deviceId || !requestKey || !Number.isInteger(accessEpoch) || accessEpoch < 0) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_AUTHORITY_INVALID", "Native MASS actor/device/request identity is required", 400);
  }
  if (operation === "CANCEL" && !queueId) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_QUEUE_ID_REQUIRED", "Native MASS cancel requires the exact queue id", 400);
  const requestHash = crypto.createHash("sha256").update(requestKey).digest("hex");
  const idempotencyKey = `${operation === "CREATE" ? "mass-native-create" : "mass-native-cancel"}:${creatorId}:${deviceId}:${requestHash}`;
  const payloadFingerprint = crypto.createHash("sha256").update(JSON.stringify({ kind, creatorId, deviceId, requestKey, queueId: queueId || null })).digest("hex");

  try {
    let authority = await reserveProgrammaticWrite({
      agencyId, userId, memberId, accessEpoch, creatorId, deviceId, kind,
      idempotencyKey, payloadFingerprint, payload: { nativeRequestKey: requestKey, nativeOperation: operation, nativeQueueId: queueId || null },
      targetId: queueId || null, maxAttempts: 1,
    });
    await startProgrammaticWrite({
      agencyId, userId, memberId, accessEpoch, creatorId, deviceId, kind,
      writeId: authority.delivery.id, leaseToken: authority.lease.token, leaseRevision: authority.lease.revision,
    });
    const prepared = await prepareProgrammaticWrite({
      agencyId, userId, memberId, accessEpoch, creatorId, deviceId, kind,
      writeId: authority.delivery.id, leaseToken: authority.lease.token, leaseRevision: authority.lease.revision,
    });
    const attached = await readBoundNativeMassCommitGrant({
      agencyId, creatorId, deviceId, userId, kind, idempotencyKey, payloadFingerprint, requestKey,
      writeId: authority.delivery.id, writeCommitRevision: prepared.writeCommitRevision, mintSettlement: authorityVersion === "MASS_NATIVE_V3",
    });
    return {
      ok: true, allowed: true, authorityVersion, permissionKey: "chats.mass_message",
      kind, operation, writeId: authority.delivery.id, idempotencyKey, requestKey,
      ...(attached.settlement ? { settlementToken: attached.settlement.token } : {}),
      writeCommitRevision: prepared.writeCommitRevision, writeCommitAt: prepared.writeCommitAt,
      actorAgencyId: agencyId, actorMemberId: memberId, actorUserId: userId,
    };
  } catch (error) {
    if (!["PROGRAMMATIC_WRITE_NOT_CLAIMABLE", "PROGRAMMATIC_WRITE_ALREADY_COMMITTING", "PROGRAMMATIC_WRITE_COMMIT_IN_FLIGHT"].includes(error?.code)) throw error;
    const attached = await readBoundNativeMassCommitGrant({
      agencyId, creatorId, deviceId, userId, kind, idempotencyKey, payloadFingerprint, requestKey,
      mintSettlement: authorityVersion === "MASS_NATIVE_V3",
    });
    return {
      ok: true, allowed: true, duplicate: true, authorityVersion, permissionKey: "chats.mass_message",
      kind, operation, writeId: attached.delivery.id, idempotencyKey, requestKey,
      ...(attached.settlement ? { settlementToken: attached.settlement.token } : {}),
      writeCommitRevision: attached.delivery.writeCommitRevision, writeCommitAt: attached.delivery.writeCommitAt,
      actorAgencyId: agencyId, actorMemberId: memberId, actorUserId: userId,
    };
  }
}

async function settleNativeMassWriteExact(input, db) {
  const agencyId = clean(input.agencyId, 180); const userId = clean(input.userId, 180); const memberId = clean(input.memberId, 180);
  const creatorId = clean(input.creatorId, 180); const deviceId = clean(input.deviceId, 180); const writeId = clean(input.writeId, 180); const requestKey = clean(input.requestKey, 500);
  const queueId = clean(input.queueId, 180); const revision = Number(input.writeCommitRevision);
  if (!agencyId || !userId || !creatorId || !deviceId || !writeId || !requestKey || !queueId || !Number.isInteger(revision) || revision < 1) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_SETTLEMENT_INVALID", "Exact native MASS write/queue/request proof is required", 400);
  }
  await lockAutomationWriteCommitFence({ db, agencyId });
  const delivery = await db.automationDelivery.findUnique({ where: { id: writeId } });
  if (!delivery || delivery.agencyId !== agencyId || delivery.creatorId !== creatorId) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_NOT_FOUND", "Native MASS write authority was not found", 404);
  }
  const kind = storedProgrammaticKind(delivery);
  if (!["MASS_NATIVE_QUEUE_CREATE", "MASS_NATIVE_QUEUE_CANCEL"].includes(kind)) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_KIND_MISMATCH", "Write is not a native MASS authority", 409);
  }
  if (input.expectedKind && clean(input.expectedKind, 80)?.toUpperCase() !== kind) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_EVENT_KIND_MISMATCH", "Native MASS event kind does not match the durable write", 409);
  }
  if (delivery.sourceDeviceId !== deviceId || delivery.createdByUserId !== userId || (memberId && delivery.leaseMemberId && delivery.leaseMemberId !== memberId)
      || clean(object(delivery.payload).nativeRequestKey, 500) !== requestKey) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_BINDING_MISMATCH", "Native MASS response belongs to another request/device/actor", 403);
  }
  if (Number(delivery.writeCommitRevision) !== revision || !delivery.writeCommitAt) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_COMMIT_REVISION_MISMATCH", "Native MASS response does not match the granted physical commit permit", 409);
  }
  if (delivery.status === "COMPLETED") {
    if (clean(delivery.remoteTargetId, 180) === queueId) return { ok: true, duplicate: true, delivery: publicDelivery(delivery) };
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_TERMINAL_MISMATCH", "Native MASS write already completed with another queue id", 409);
  }
  const lateUnresolved = delivery.status === "FAILED" && delivery.failureCode === "outcome_unresolved_do_not_retry";
  if (!["COMMITTING", "RECONCILE_REQUIRED"].includes(delivery.status) && !lateUnresolved) {
    throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_NOT_SETTLEABLE", `Native MASS write status is ${delivery.status}`, 409);
  }
  if (kind === "MASS_NATIVE_QUEUE_CANCEL") {
    const expectedQueueId = clean(delivery.targetId || object(delivery.payload).nativeQueueId, 180);
    if (!expectedQueueId || expectedQueueId !== queueId) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_CANCEL_QUEUE_MISMATCH", "Native MASS cancel response queue id changed after preflight", 409);
  }
  const now = new Date();
  const changed = await db.automationDelivery.updateMany({
    where: { id: delivery.id, status: delivery.status, writeCommitRevision: revision },
    data: {
      status: "COMPLETED", failureCode: null, failureCategory: null, lastError: null,
      remoteLifecycleState: isMassQueueCreateKind(kind) ? "PENDING" : "SETTLED",
      remoteTargetId: queueId, remoteLifecycleObservedAt: now,
      remoteSettledAt: isMassQueueCancelKind(kind) ? now : null,
      result: { ...object(delivery.result), queueId, outcomeState: "PROVEN_SUCCESS", completedAt: now.toISOString(), nativeResponseProof: true },
      finishedAt: now, claimUntil: null, leaseTokenHash: null, lastCheckedAt: now,
    },
  });
  if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_SETTLEMENT_RACE", "Native MASS write changed before exact response settlement", 409);
  if (isMassQueueCancelKind(kind)) {
    await db.automationDelivery.updateMany({
      where: { agencyId, creatorId, actionType: { in: [...MASS_REMOTE_QUEUE_KINDS] }, remoteTargetId: queueId },
      data: { remoteLifecycleState: "SETTLED", remoteLifecycleObservedAt: now, remoteSettledAt: now },
    });
  }
  return { ok: true, delivery: publicDelivery(await db.automationDelivery.findUnique({ where: { id: delivery.id } })) };
}

async function completeNativeMassWrite(input) {
  return prisma.$transaction(async (tx) => settleNativeMassWriteExact(input, tx), { timeout: 30_000 });
}

async function completeNativeMassWriteWithSettlementToken(input) {
  const writeId = clean(input.writeId, 180);
  const settlementToken = clean(input.settlementToken, 500);
  if (!writeId || !settlementToken) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_SETTLEMENT_TOKEN_REQUIRED", "Native MASS settlement capability is required", 401);
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.automationDelivery.findUnique({ where: { id: writeId } });
    if (!delivery) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_WRITE_NOT_FOUND", "Native MASS write authority was not found", 404);
    const expectedHashes = (Array.isArray(object(delivery.result).nativeSettlementTokenHashes) ? object(delivery.result).nativeSettlementTokenHashes : [])
      .map((value) => clean(value, 200)).filter(Boolean);
    if (!expectedHashes.some((expectedHash) => tokenMatches(settlementToken, expectedHash))) {
      throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_SETTLEMENT_TOKEN_INVALID", "Native MASS settlement capability is invalid", 403);
    }
    return settleNativeMassWriteExact({
      agencyId: delivery.agencyId, userId: delivery.createdByUserId, memberId: delivery.leaseMemberId,
      creatorId: delivery.creatorId, deviceId: input.deviceId, writeId, requestKey: input.requestKey,
      queueId: input.queueId, writeCommitRevision: input.writeCommitRevision, expectedKind: input.expectedKind,
    }, tx);
  }, { timeout: 30_000 });
}

async function projectNativeMassWriteFromTeamEvent(event, { db = prisma } = {}) {
  const eventKind = clean(event?.eventKind, 80)?.toUpperCase();
  if (!["BROADCAST_DISPATCH_CONFIRMED", "BROADCAST_QUEUE_CANCELED_CONFIRMED"].includes(eventKind)) return { ok: true, skipped: true };
  if (clean(event?.actionSource, 40)?.toUpperCase() !== "BROADCAST" || clean(event?.lifecycle, 40)?.toUpperCase() !== "CONFIRMED") return { ok: true, skipped: true };
  const extra = object(event?.extra); const metadata = object(extra.metadata); const binding = object(metadata.massNative);
  if (!["MASS_NATIVE_V2", "MASS_NATIVE_V3"].includes(clean(binding.authorityVersion, 80))) return { ok: true, skipped: true };
  const expectedKind = eventKind === "BROADCAST_QUEUE_CANCELED_CONFIRMED" ? "MASS_NATIVE_QUEUE_CANCEL" : "MASS_NATIVE_QUEUE_CREATE";
  const boundKind = clean(binding.kind, 80)?.toUpperCase();
  if (boundKind !== expectedKind) throw new ProgrammaticOfWriteAuthorityError("MASS_NATIVE_EVENT_KIND_MISMATCH", "Durable Team event native MASS binding does not match its event kind", 409);
  return settleNativeMassWriteExact({
    agencyId: event.agencyId,
    userId: event.userId,
    memberId: event.memberId,
    creatorId: event.creatorId || event.accountId,
    deviceId: event.deviceId,
    writeId: binding.writeId,
    requestKey: binding.requestKey,
    queueId: event.broadcastDispatchId,
    writeCommitRevision: binding.writeCommitRevision,
    expectedKind,
  }, db);
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
  assertProgrammaticIdempotencyNamespace(kind, config, creatorId, idempotencyKey);
  const leaseMs = leaseDuration(input.leaseMs);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // CUSTOM_MANUAL_SEND is part of the durable Custom pipeline lifecycle.
    // Serialize NEW manual-write creation against agency/creator retirement so a
    // retire transaction cannot pass its blocker query and have a durable external
    // write appear immediately afterwards. Lock order matches the rest of the
    // pipeline: Agency -> Creator -> (later, at commit) Automation write fence.
    if (["CUSTOM_MANUAL_SEND", ...MASS_QUEUE_CREATE_KINDS, ...MASS_QUEUE_CANCEL_KINDS].includes(kind)) {
      const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
      await lockAgencyPipelineLifecycle({ db: tx, agencyId });
      await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId });
    }
    await assertDevice({ db: tx, agencyId, userId, deviceId });
    await assertLiveActor({ db: tx, agencyId, userId, memberId, accessEpoch, creatorId, permissionKey: input.permissionKeyOverride === undefined ? config.permissionKey : input.permissionKeyOverride });
    if ([...MASS_QUEUE_CREATE_KINDS, ...MASS_QUEUE_CANCEL_KINDS].includes(kind)) {
      const { invalidateCreatorMassProviderRetirementProof } = require("./mass-campaign-authority-service");
      await invalidateCreatorMassProviderRetirementProof({
        db: tx, agencyId, creatorId, reason: `${kind} authority reserved/replayed after retirement snapshot`, now,
      });
    }
    // The creator write lane is global across origins. Before a programmatic
    // reserve tries to acquire it, clear expired Automation precommit leases
    // with Automation semantics, then clear/transition expired programmatic
    // leases with programmatic semantics. Neither policy may process the other.
    const { sweepExpiredAutomationLeases } = require("./automation-action-delivery-service");
    await sweepExpiredAutomationLeases({ now, agencyId, creatorIds: [creatorId] });
    await sweepExpiredProgrammaticWriteLeases({ db: tx, agencyId, creatorId, now });
    let delivery = await tx.automationDelivery.findUnique({ where: { idempotencyKey } });
    const replay = Boolean(delivery);
    if (delivery) {
      const sameIdentity = delivery.agencyId === agencyId && delivery.creatorId === creatorId
        && delivery.actionType === config.actionType && delivery.originKind === config.originKind
        && delivery.moduleKey === config.moduleKey && delivery.executionKind === config.executionKind
        && delivery.reconciliationKind === config.reconciliationKind;
      if (!sameIdentity) {
        throw new ProgrammaticOfWriteAuthorityError("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another programmatic write authority identity", 409);
      }
      const sameFingerprint = clean(delivery.payloadFingerprint, 200) === payloadFingerprint;
      if (!sameFingerprint) {
        const safeRebind = config.allowPrecommitPayloadRebind === true
          && !delivery.writeCommitAt
          && ["QUEUED", "RETRY_SCHEDULED"].includes(String(delivery.status || ""));
        if (!safeRebind) assertPayloadBinding(delivery, { agencyId, creatorId, payloadFingerprint }, config);
        const rebound = await tx.automationDelivery.updateMany({
          where: { id: delivery.id, status: delivery.status, writeCommitAt: null, leaseRevision: delivery.leaseRevision },
          data: {
            payloadFingerprint, payload: object(input.payload), targetId: clean(input.targetId, 180), fanId: clean(input.fanId, 180), dialogId: clean(input.dialogId, 180),
            sourceDeviceId: deviceId, failureCode: null, failureCategory: null, lastError: null, lastCheckedAt: now,
            result: { ...object(delivery.result), precommitPayloadReboundAt: now.toISOString() },
          },
        });
        if (!rebound.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RESERVE_RACE", "Programmatic write changed while rebinding proven-precommit payload", 409);
        delivery = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
      }
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
            result: { ...object(delivery.result), outcomeState: "RECONCILE_REQUIRED", reconciliationStartedAt: object(delivery.result).reconciliationStartedAt || delivery.writeCommitAt?.toISOString?.() || now.toISOString(), recoveredAfterCommitLeaseExpiredAt: now.toISOString() },
          },
        });
        if (!transitioned.count) {
          throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_COMMIT_IN_FLIGHT", "Programmatic write commit lease changed while recovery was attempted", 409);
        }
        delivery = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
      }
      if (delivery.status === "RECONCILE_REQUIRED" && input.allowReconciliationTakeover === false) {
        throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RECONCILIATION_REQUIRED", "Previous external write outcome must be reconciled before another commit permit", 409);
      }
      if (delivery.status === "RECONCILE_REQUIRED" && delivery.claimUntil && delivery.claimUntil > now) {
        throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_LEASE_BUSY", "Programmatic write reconciliation is currently owned by another active lease", 409);
      }
      if (ACTIVE_LEASE_STATUSES.has(delivery.status) && delivery.claimUntil && delivery.claimUntil > now && delivery.claimedByDeviceId !== deviceId) {
        throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_LEASE_BUSY", "Programmatic write is currently leased by another device", 409);
      }
      const reconciliation = delivery.status === "RECONCILE_REQUIRED";
      if (config.executionKind === "SOURCE_DEVICE" && delivery.sourceDeviceId && delivery.sourceDeviceId !== deviceId && !reconciliation) {
        throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_SOURCE_DEVICE_REQUIRED", "This write payload is bound to its original source device until a commit outcome requires reconciliation", 409);
      }
    }

    if (kind === "MASS_QUEUE_CREATE" && !delivery) {
      // Rolling cutover is intentionally fail-closed. MASS logical intent must
      // first be reserved by the product-specific server authority so two
      // Desktops cannot mint unrelated dispatchIds for one user action.
      throw new ProgrammaticOfWriteAuthorityError("MASS_LOGICAL_INTENT_RESERVATION_REQUIRED", "Reserve the server-canonical MASS logical intent before claiming its external write", 409);
    }

    const minted = mintLease(now, leaseMs);
    const leaseToken = minted.token;
    const claimUntil = minted.until;
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
  if (!committedSettlement && (!delivery.claimUntil || delivery.claimUntil <= new Date())) {
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
    const patch = sanitizeClientResult(delivery, object(input.result), "checkpoint");
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
      let settlementToken = null;
      if (storedProgrammaticKind(delivery) === "CUSTOM_MANUAL_SEND" && input.mintCustomManualSettlementCapability === true) {
        settlementToken = (await appendCustomManualSettlementCapabilityTx(tx, delivery)).token;
      }
      return { ok: true, duplicate: true, writeCommitRevision: delivery.writeCommitRevision, writeCommitAt: delivery.writeCommitAt, delivery: publicDelivery(delivery), ...(settlementToken ? { settlementToken } : {}) };
    }
    if (delivery.status === "RECONCILE_REQUIRED") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RECONCILIATION_REQUIRED", "Previous external write outcome must be reconciled before another commit permit", 409);
    if (delivery.status !== "RUNNING") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_RUNNING", `Programmatic write status is ${delivery.status}`, 409);
    if (storedProgrammaticKind(delivery) === "CUSTOM_MANUAL_SEND") {
      const { assertCustomManualDeliveryCommitCurrent } = require("./custom-manual-delivery-authority-service");
      await assertCustomManualDeliveryCommitCurrent({ db: tx, delivery });
    }
    const now = new Date();
    const wantsCustomSettlement = storedProgrammaticKind(delivery) === "CUSTOM_MANUAL_SEND" && input.mintCustomManualSettlementCapability === true;
    const customSettlement = wantsCustomSettlement ? mintWriteSettlementToken() : null;
    const currentResult = object(delivery.result);
    const priorCustomHashes = (Array.isArray(currentResult.customManualSettlementTokenHashes) ? currentResult.customManualSettlementTokenHashes : [])
      .map((value) => clean(value, 200)).filter(Boolean);
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "RUNNING", claimedByDeviceId: input.deviceId, leaseRevision: delivery.leaseRevision, leaseTokenHash: hashToken(input.leaseToken), claimUntil: { gt: now } },
      data: {
        status: "COMMITTING",
        writeCommitRevision: { increment: 1 },
        writeCommitAt: now,
        lastCheckedAt: now,
        result: {
          ...currentResult,
          writeCommitGrantedAt: now.toISOString(), writeCommitLeaseRevision: delivery.leaseRevision,
          ...(customSettlement ? { customManualSettlementTokenHashes: [...priorCustomHashes, customSettlement.hash] } : {}),
        },
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_COMMIT_PERMIT_STALE", "Programmatic write changed before commit permit", 409);
    delivery = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    return { ok: true, duplicate: false, writeCommitRevision: delivery.writeCommitRevision, writeCommitAt: delivery.writeCommitAt, delivery: publicDelivery(delivery), ...(customSettlement ? { settlementToken: customSettlement.token } : {}) };
  }, { timeout: 30_000 });
}

async function canRevealTerminalProgrammaticResult(input, delivery, db) {
  const storedKind = storedProgrammaticKind(delivery);
  const { config } = productKind(storedKind);
  // SYSTEM/custom writes have product-specific adapters and intentionally do not
  // expose durable terminal result through the generic authority endpoint.
  if (!config.permissionKey) return false;
  try {
    await assertLiveActor({
      db,
      agencyId: delivery.agencyId,
      userId: input.userId,
      memberId: input.memberId,
      accessEpoch: input.accessEpoch,
      creatorId: delivery.creatorId,
      permissionKey: config.permissionKey,
    });
    return true;
  } catch {
    return false;
  }
}

async function completeProgrammaticWrite(input) {
  return prisma.$transaction(async (tx) => {
    const delivery = await requireProgrammaticLease(input, { db: tx, allowTerminal: true, allowCommittedSettlement: true, lock: true });
    if (storedProgrammaticKind(delivery) === "CUSTOM_MANUAL_SEND") {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_PRODUCT_SETTLEMENT_REQUIRED", "CUSTOM_MANUAL_SEND can settle only through canonical Custom delivery/Team-event authority", 409);
    }
    if (TERMINAL_STATUSES.has(delivery.status)) {
      if (await canRevealTerminalProgrammaticResult(input, delivery, tx)) {
        return { ok: true, duplicate: true, terminal: true, delivery: publicDelivery(delivery) };
      }
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_TERMINAL_RESULT_FORBIDDEN", "Current creator access and product permission are required to replay a terminal programmatic-write result", 403);
    }
    if (delivery.status !== "COMMITTING") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_COMMITTING", `Programmatic write status is ${delivery.status}`, 409);
    const now = new Date();
    const result = sanitizeClientResult(delivery, object(input.result), "complete");
    const kind = storedProgrammaticKind(delivery);
    assertCompletionEvidence(delivery, result);
    const actualMessageId = new Set(["VAULT_RELAY_SEND", "CUSTOM_RELAY_SEND"]).has(kind)
      ? clean(result.messageId || input.messageId, 180)
      : null;
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "COMMITTING", claimedByDeviceId: input.deviceId, leaseRevision: delivery.leaseRevision, writeCommitRevision: delivery.writeCommitRevision },
      data: {
        status: "COMPLETED",
        failureCode: null,
        failureCategory: null,
        lastError: null,
        messageId: actualMessageId,
        ...(isMassQueueCreateKind(kind) ? {
          remoteLifecycleState: "PENDING",
          remoteTargetId: clean(result.queueId, 180),
          remoteLifecycleObservedAt: now,
          remoteSettledAt: null,
        } : isMassQueueCancelKind(kind) ? {
          remoteLifecycleState: "SETTLED",
          remoteTargetId: clean(result.queueId, 180),
          remoteLifecycleObservedAt: now,
          remoteSettledAt: now,
        } : {}),
        result: { ...object(delivery.result), ...result, outcomeState: "PROVEN_SUCCESS", completedAt: now.toISOString() },
        finishedAt: now,
        claimUntil: null,
        leaseTokenHash: null,
        lastCheckedAt: now,
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_COMPLETE_RACE", "Programmatic write changed before completion", 409);
    if (isMassQueueCancelKind(kind)) {
      const queueId = clean(result.queueId, 180);
      if (queueId) {
        await tx.automationDelivery.updateMany({
          where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, actionType: { in: [...MASS_REMOTE_QUEUE_KINDS] }, remoteTargetId: queueId },
          data: { remoteLifecycleState: "SETTLED", remoteLifecycleObservedAt: now, remoteSettledAt: now },
        });
      }
    }
    return { ok: true, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
  }, { timeout: 30_000 });
}

async function failProgrammaticWrite(input) {
  return prisma.$transaction(async (tx) => {
    const delivery = await requireProgrammaticLease(input, { db: tx, allowCommittedSettlement: true, lock: true });
    const facts = object(input.facts);
    const storedKind = storedProgrammaticKind(delivery);
    const { config } = productKind(storedKind);
    const endpointSemantics = config.writeSemantics;
    const idempotent = endpointSemantics === "IDEMPOTENT_WRITE";
    const reachedWire = delivery.status === "COMMITTING" || Boolean(delivery.writeCommitAt);
    // Backend owns repeat/no-repeat policy. Client booleans/semantics are retained
    // only as diagnostics and can never make a committed non-idempotent write retryable.
    const clientClaimedNoEffect = facts.provenNoEffect === true;
    const provenNoEffect = !reachedWire;
    const failureCode = clean(input.failureCode, 120) || "unknown";
    const category = reachedWire && !idempotent
      ? FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE
      : classifyAutomationFailure({
        failureCode, deliveryStatus: delivery.status, provenNoEffect, idempotent, endpointSemantics,
        writeReachedWire: reachedWire, outcomeState: reachedWire ? "ON_WIRE_UNKNOWN" : "PRE_WIRE_FAILURE",
        transportCode: facts.transportCode || facts.originalCode || null,
      });
    const reconcile = reachedWire && !idempotent;
    const now = new Date();
    const reconciliationLease = reconcile ? mintLease(now, DEFAULT_LEASE_MS) : null;
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
        // An idempotent desired-state write may safely receive a fresh commit
        // permit after an ambiguous/failed attempt; non-idempotent writes never do.
        writeCommitAt: idempotent ? null : delivery.writeCommitAt,
        claimUntil: reconciliationLease ? reconciliationLease.until : null,
        leaseTokenHash: reconciliationLease ? reconciliationLease.hash : null,
        leaseRevision: reconcile ? { increment: 1 } : undefined,
        lastCheckedAt: now,
        result: {
          ...object(delivery.result),
          failureEvidence: {
            endpointSemantics,
            reportedEndpointSemantics: clean(facts.endpointSemantics, 80)?.toUpperCase() || null,
            writeReachedWire: reachedWire,
            httpStatus: Number.isFinite(Number(facts.httpStatus)) ? Number(facts.httpStatus) : null,
            transportCode: clean(facts.transportCode || facts.originalCode, 160),
            reconciliationEvidence: object(facts.reconciliationEvidence),
          },
          ...(clientClaimedNoEffect && !provenNoEffect ? { clientClaimedProvenNoEffect: true } : {}),
          provenNoEffect,
          outcomeState: reconcile ? "RECONCILE_REQUIRED" : (provenNoEffect ? "PROVEN_NO_EFFECT" : "TERMINAL"),
          ...(reconcile ? { reconciliationStartedAt: object(delivery.result).reconciliationStartedAt || delivery.writeCommitAt?.toISOString?.() || now.toISOString() } : {}),
          failedAt: now.toISOString(),
        },
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_FAIL_RACE", "Programmatic write changed before failure settlement", 409);
    const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
    return {
      ok: true,
      reconciliationRequired: reconcile,
      lease: reconciliationLease ? { token: reconciliationLease.token, revision: current.leaseRevision, until: reconciliationLease.until } : null,
      delivery: publicDelivery(current),
    };
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
    const reconciliationKind = storedProgrammaticKind(delivery);
    if (reconciliationKind === "CUSTOM_MANUAL_SEND" && outcome !== "WAIT_FOR_READBACK") {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_PRODUCT_SETTLEMENT_REQUIRED", "CUSTOM_MANUAL_SEND success can settle only through canonical Custom delivery/Team-event authority", 409);
    }
    if (reconciliationKind === "MASS_QUEUE_CREATE" && outcome === "MATCHED") {
      throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_CORRELATION_PROOF_REQUIRED", "MASS queue shape/readback is evidence, not proof of the lost POST; only the exact queueId returned by the commit response may prove success", 409);
    }
    // None of the current product write kinds has a documented strong negative
    // read-after-write contract. Absence from an eventual-consistency readback is
    // therefore WAIT_FOR_READBACK, never proof that a second POST is safe.
    if (outcome === "PROVEN_NO_EFFECT") {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NO_EFFECT_PROOF_REQUIRED", "This write kind has no authoritative negative-proof contract; keep reconciling instead of retrying", 409);
    }
    if (outcome === "WAIT_FOR_READBACK") {
      const now = new Date();
      const storedResult = object(delivery.result);
      const startedAt = new Date(storedResult.reconciliationStartedAt || delivery.writeCommitAt || now);
      if (Number.isFinite(startedAt.getTime()) && now.getTime() - startedAt.getTime() >= MAX_RECONCILIATION_WAIT_MS) {
        const closed = await tx.automationDelivery.updateMany({
          where: { id: delivery.id, status: "RECONCILE_REQUIRED", leaseRevision: delivery.leaseRevision, claimedByDeviceId: input.deviceId, leaseTokenHash: hashToken(input.leaseToken) },
          data: {
            status: "FAILED", failureCode: "outcome_unresolved_do_not_retry", failureCategory: FAILURE_CATEGORIES.TERMINAL,
            ...(isMassQueueCreateKind(storedProgrammaticKind(delivery)) ? { remoteLifecycleState: "UNKNOWN", remoteLifecycleObservedAt: now, remoteSettledAt: null } : {}),
            lastError: "Reconciliation evidence remained insufficient beyond the bounded verification window; logical commit closed permanently without retry",
            result: { ...storedResult, ...sanitizeClientResult(delivery, object(input.result), "reconcile"), outcomeState: "UNRESOLVED_DO_NOT_RETRY", unresolvedClosedAt: now.toISOString(), unresolvedCloseReason: "RECONCILIATION_WINDOW_EXPIRED" },
            finishedAt: now, claimUntil: null, leaseTokenHash: null, lastCheckedAt: now,
          },
        });
        if (!closed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RECONCILE_RACE", "Programmatic write changed while closing unresolved reconciliation", 409);
        if (tx.auditLog?.create) await tx.auditLog.create({ data: {
          agencyId: delivery.agencyId, actorUserId: input.userId || null, action: "programmatic_write.auto_close_unresolved_do_not_retry",
          targetType: "AutomationDelivery", targetId: delivery.id, metadata: { creatorId: delivery.creatorId, actionType: delivery.actionType, originKind: delivery.originKind, idempotencyKey: delivery.idempotencyKey },
        } });
        return { ok: true, reconciliationRequired: false, unresolved: true, lease: null, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
      }
      const renewedUntil = new Date(now.getTime() + DEFAULT_LEASE_MS);
      const renewed = await tx.automationDelivery.updateMany({
        where: { id: delivery.id, status: "RECONCILE_REQUIRED", leaseRevision: delivery.leaseRevision, claimedByDeviceId: input.deviceId, leaseTokenHash: hashToken(input.leaseToken) },
        data: {
          claimUntil: renewedUntil,
          lastCheckedAt: now,
          result: { ...object(delivery.result), ...sanitizeClientResult(delivery, object(input.result), "reconcile"), outcomeState: "RECONCILE_REQUIRED", lastReadbackAt: now.toISOString() },
        },
      });
      if (!renewed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_RECONCILE_RACE", "Programmatic write changed while renewing reconciliation lease", 409);
      const current = await tx.automationDelivery.findUnique({ where: { id: delivery.id } });
      return {
        ok: true,
        reconciliationRequired: true,
        lease: { token: input.leaseToken, revision: current.leaseRevision, until: renewedUntil },
        delivery: publicDelivery(current),
      };
    }
    const now = new Date();
    const evidence = sanitizeClientResult(delivery, object(input.result), "reconcile");
    const complete = outcome === "MATCHED";
    if (complete) assertCompletionEvidence(delivery, evidence);
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "RECONCILE_REQUIRED", leaseRevision: delivery.leaseRevision, claimedByDeviceId: input.deviceId },
      data: complete ? {
        status: "COMPLETED",
        failureCode: null,
        failureCategory: null,
        lastError: null,
        messageId: clean(evidence.messageId, 180),
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

async function closeProgrammaticWriteUnresolved(input) {
  return prisma.$transaction(async (tx) => {
    const delivery = await requireProgrammaticLease(input, { db: tx, lock: true });
    if (delivery.status !== "RECONCILE_REQUIRED") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_RECONCILING", `Programmatic write status is ${delivery.status}`, 409);
    if (input.expectedIdempotencyKey && delivery.idempotencyKey !== input.expectedIdempotencyKey) {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_IDEMPOTENCY_MISMATCH", "Programmatic write does not belong to the requested product operation", 409);
    }
    const now = new Date();
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "RECONCILE_REQUIRED", leaseRevision: delivery.leaseRevision, claimedByDeviceId: input.deviceId, leaseTokenHash: hashToken(input.leaseToken) },
      data: {
        status: "FAILED",
        failureCode: "outcome_unresolved_do_not_retry",
        failureCategory: FAILURE_CATEGORIES.TERMINAL,
        ...(isMassQueueCreateKind(storedProgrammaticKind(delivery)) ? { remoteLifecycleState: "UNKNOWN", remoteLifecycleObservedAt: now, remoteSettledAt: null } : {}),
        lastError: clean(input.reason, 1000) || "Remote outcome could not be proven; logical commit closed permanently without retry",
        result: { ...object(delivery.result), outcomeState: "UNRESOLVED_DO_NOT_RETRY", unresolvedClosedAt: now.toISOString() },
        finishedAt: now,
        claimUntil: null,
        leaseTokenHash: null,
        lastCheckedAt: now,
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_CLOSE_RACE", "Programmatic write changed before unresolved close", 409);
    if (tx.auditLog?.create) {
      await tx.auditLog.create({ data: {
        agencyId: delivery.agencyId, actorUserId: input.userId || null,
        action: "programmatic_write.close_unresolved_do_not_retry",
        targetType: "AutomationDelivery", targetId: delivery.id,
        metadata: { creatorId: delivery.creatorId, actionType: delivery.actionType, originKind: delivery.originKind, idempotencyKey: delivery.idempotencyKey },
      } });
    }
    return { ok: true, unresolved: true, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
  }, { timeout: 30_000 });
}

async function resolveProgrammaticWriteUnresolvedMatched(input) {
  return prisma.$transaction(async (tx) => {
    const writeId = clean(input.writeId, 180);
    const delivery = await tx.automationDelivery.findUnique({ where: { id: writeId || "__missing__" } });
    if (!delivery || delivery.originKind === "AUTOMATION") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_FOUND", "Programmatic write not found", 404);
    if (delivery.agencyId !== input.agencyId || delivery.creatorId !== String(input.creatorId || "")) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_CREATOR_MISMATCH", "Programmatic write belongs to another creator or agency", 403);
    const storedKind = storedProgrammaticKind(delivery);
    const { key: kind, config } = productKind(input.kind || storedKind);
    if (storedKind !== kind || delivery.actionType !== config.actionType) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_KIND_MISMATCH", "Programmatic write kind does not match the durable operation", 409);
    if (kind === "CUSTOM_MANUAL_SEND") throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_PRODUCT_SETTLEMENT_REQUIRED", "CUSTOM_MANUAL_SEND unresolved success can settle only through canonical Custom delivery/Team-event authority", 409);
    if (kind === "MASS_QUEUE_CREATE") throw new ProgrammaticOfWriteAuthorityError("MASS_QUEUE_CORRELATION_PROOF_REQUIRED", "MASS_QUEUE_CREATE unresolved success cannot be matched from queue shape or a manually supplied queueId without provider correlation", 409);
    if (input.expectedIdempotencyKey && delivery.idempotencyKey !== input.expectedIdempotencyKey) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_IDEMPOTENCY_MISMATCH", "Programmatic write does not belong to the requested product operation", 409);
    await assertDevice({ db: tx, agencyId: delivery.agencyId, userId: input.userId, deviceId: input.deviceId });
    await assertLiveActor({ db: tx, agencyId: delivery.agencyId, userId: input.userId, memberId: input.memberId, accessEpoch: input.accessEpoch, creatorId: delivery.creatorId, permissionKey: input.permissionKey === undefined ? config.permissionKey : input.permissionKey });
    if (delivery.status !== "FAILED" || delivery.failureCode !== "outcome_unresolved_do_not_retry") {
      throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_NOT_UNRESOLVED", "Only a permanently unresolved no-retry operation may be manually matched", 409);
    }
    const evidence = sanitizeClientResult(delivery, object(input.result), "reconcile");
    const valid = kind === "MASS_QUEUE_CREATE" ? Boolean(clean(evidence.queueId, 180))
      : kind === "VAULT_CREATE_LIST" ? Boolean(clean(evidence.folderId || object(evidence.list).id, 180))
      : Boolean(clean(evidence.mediaId, 180));
    if (!valid) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_MANUAL_MATCH_EVIDENCE_REQUIRED", "A typed remote object identity is required to match the unresolved write", 400);
    const now = new Date();
    const actualMessageId = new Set(["VAULT_RELAY_SEND", "CUSTOM_RELAY_SEND"]).has(kind) ? clean(evidence.messageId, 180) : null;
    const changed = await tx.automationDelivery.updateMany({
      where: { id: delivery.id, status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
      data: {
        status: "COMPLETED", failureCode: null, failureCategory: null, lastError: null,
        messageId: actualMessageId,
        result: { ...object(delivery.result), ...evidence, outcomeState: "PROVEN_SUCCESS", manualResolvedAt: now.toISOString(), manualResolutionKind: "MATCH_EXISTING_REMOTE_RESULT" },
        finishedAt: now, lastCheckedAt: now,
      },
    });
    if (!changed.count) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_MANUAL_RESOLVE_RACE", "Programmatic write changed before manual resolution", 409);
    if (tx.auditLog?.create) await tx.auditLog.create({ data: {
      agencyId: delivery.agencyId, actorUserId: input.userId || null, action: "programmatic_write.match_unresolved_remote_result",
      targetType: "AutomationDelivery", targetId: delivery.id, metadata: { creatorId: delivery.creatorId, actionType: delivery.actionType, originKind: delivery.originKind, idempotencyKey: delivery.idempotencyKey },
    } });
    return { ok: true, matched: true, delivery: publicDelivery(await tx.automationDelivery.findUnique({ where: { id: delivery.id } })) };
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
  reserveMassLogicalIntent,
  getCurrentMassLogicalIntent,
  acknowledgeMassLogicalIntent,
  abandonMassLogicalIntentPrecommit,
  beginMassRemoteQueueSnapshot,
  reconcileMassRemoteQueueSnapshot,
  authorizeNativeMassWrite,
  attachCustomManualSettlementCapability,
  completeNativeMassWrite,
  completeNativeMassWriteWithSettlementToken,
  settleNativeMassWriteProvenNoEffect,
  projectNativeMassWriteFromTeamEvent,
  reserveProgrammaticWrite,
  startProgrammaticWrite,
  prepareProgrammaticWrite,
  checkpointProgrammaticWrite,
  completeProgrammaticWrite,
  failProgrammaticWrite,
  reconcileProgrammaticWrite,
  closeProgrammaticWriteUnresolved,
  resolveProgrammaticWriteUnresolvedMatched,
  sweepExpiredProgrammaticWriteLeases,
  getProgrammaticWrite,
};
