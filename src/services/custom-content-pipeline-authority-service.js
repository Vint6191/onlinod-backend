"use strict";

const crypto = require("node:crypto");
const { findCancelledModelInstructionFollowupDebt, findConfirmedTelegramProjectionDebt } = require("./telegram-exact-authority-scan-service");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { lockAgencyLifecycleBarrier, agencyLifecycleBarrierKey } = require("./agency-lifecycle-barrier-service");

const ACTIVE = "ACTIVE";
const SALVAGE = "SALVAGE";
const ARCHIVED = "ARCHIVED";
const ABANDONED = "ABANDONED";
const UNKNOWN_DISPOSITION = "UNKNOWN";
const RESOLUTION_DISPOSITIONS = new Set([SALVAGE, ARCHIVED, ABANDONED]);
const PRECOMMIT_WRITE_STATUSES = ["QUEUED", "RETRY_SCHEDULED", "CLAIMED", "RUNNING"];
const ACTIVE_WRITE_STATUSES = [...PRECOMMIT_WRITE_STATUSES, "COMMITTING", "RECONCILE_REQUIRED"];
const UNRESOLVED_INBOUND_PROJECTION_STATES = ["PENDING", "FAILED_RETRYABLE", "REVIEW_REQUIRED"];
const ACTIVE_TELEGRAM_DELIVERY_STATES = ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT"];
const CUSTOM_EXTERNAL_ACTION_TYPES = ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"];
const CUSTOM_EXTERNAL_UNRESOLVED_STATUSES = ["COMMITTING", "RECONCILE_REQUIRED"];

function fail(code, message, status = 409, details = null) {
  const error = Object.assign(new Error(message), { code, status });
  if (details) error.details = details;
  return error;
}

function clean(value, max = 500) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function relayRecipient(value) {
  const text = clean(value, 240).replace(/^@+/, "");
  return /^(?:[A-Za-z0-9_]{3,64}|[1-9]\d{0,39})$/.test(text) ? text : null;
}


function normalizedSettlementMediaIds(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = clean(raw, 240);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function vaultSettlementFingerprint({ folderId, profileRevision, mediaIds } = {}) {
  const folder = clean(folderId, 240);
  const revision = Number(profileRevision);
  const ids = normalizedSettlementMediaIds(mediaIds);
  if (!folder || !Number.isInteger(revision) || revision <= 0 || !ids.length) return null;
  return crypto.createHash("sha256").update(JSON.stringify({ folderId: folder, profileRevision: revision, mediaIds: ids })).digest("hex");
}

function hasCurrentVaultSettlement(submission) {
  if (!submission?.executionPinnedAt) return false;
  const folderId = clean(submission.executionVaultFolderId, 240);
  const profileRevision = Number(submission.executionProfileRevision);
  const fingerprint = vaultSettlementFingerprint({ folderId, profileRevision, mediaIds: submission.ofMediaIds });
  return Boolean(
    folderId
    && fingerprint
    && clean(submission.vaultSettlementFolderId, 240) === folderId
    && Number(submission.vaultSettlementProfileRevision) === profileRevision
    && clean(submission.vaultSettlementMediaFingerprint, 128) === fingerprint
    && submission.vaultSettlementConfirmedAt
    && clean(submission.vaultSettlementConfirmedByDeviceId, 180)
  );
}

function customAssetMatchesPipelineProjection(submission, asset, order = null) {
  if (!submission || !asset) return false;
  const submissionId = clean(submission.id, 180);
  const orderId = submission.customOrderId == null ? null : clean(submission.customOrderId, 180);
  const folderId = clean(submission.executionVaultFolderId, 240);
  if (!submissionId || !folderId) return false;
  const expectedPrice = orderId ? Math.max(0, Math.round(Number(order?.priceCents) || 0)) : null;
  const folders = new Set((Array.isArray(asset.folderIds) ? asset.folderIds : []).map((value) => clean(value, 240)).filter(Boolean));
  return String(asset.source || "") === "CUSTOM"
    && clean(asset.customSubmissionId, 180) === submissionId
    && (asset.customOrderId == null ? null : clean(asset.customOrderId, 180)) === orderId
    && (orderId ? Number(asset.customFullPriceCents) === expectedPrice : asset.customFullPriceCents == null)
    && asset.catalogActive === true
    && String(asset.sortingStatus || "").toUpperCase() === "SORTED"
    && folders.has(folderId);
}

function invalidateVaultSettlementData() {
  return {
    vaultSettlementFolderId: null,
    vaultSettlementProfileRevision: null,
    vaultSettlementMediaFingerprint: null,
    vaultSettlementConfirmedAt: null,
    vaultSettlementConfirmedByDeviceId: null,
  };
}

function disposition(value) {
  const normalized = clean(value, 40).toUpperCase();
  if (!normalized) return UNKNOWN_DISPOSITION;
  return new Set([ACTIVE, SALVAGE, ARCHIVED, ABANDONED]).has(normalized) ? normalized : UNKNOWN_DISPOSITION;
}

function orderIsLiveContent(order) {
  return Boolean(order)
    && String(order.type || "").toUpperCase() === "CONTENT"
    && String(order.status || "").toUpperCase() === "PENDING"
    && !order.fanDeliveredAt;
}

function submissionAllowsNewPipelineWork(submission, order = null) {
  if (!submission || disposition(submission.pipelineDisposition) !== ACTIVE) return false;
  if (!submission.customOrderId) return true;
  return orderIsLiveContent(order);
}

function unresolvedPipelineSubmissionWhere() {
  return {
    OR: [
      { pipelineDisposition: SALVAGE },
      { pipelineDisposition: ACTIVE, customOrderId: null },
      {
        pipelineDisposition: ACTIVE,
        customOrder: { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } },
      },
    ],
  };
}

function derivePipelineStage({ submission, order = null, finalized = false, blockedCode = null } = {}) {
  if (!submission) return "TERMINAL";
  const currentDisposition = disposition(submission.pipelineDisposition);
  if (currentDisposition === ARCHIVED || currentDisposition === ABANDONED) return "TERMINAL";
  if (currentDisposition === UNKNOWN_DISPOSITION) return "BLOCKED";

  const telegram = Array.from(new Set((Array.isArray(submission.telegramMessageIds) ? submission.telegramMessageIds : []).map(String).filter(Boolean)));
  const media = Array.from(new Set((Array.isArray(submission.ofMediaIds) ? submission.ofMediaIds : []).map(String).filter(Boolean)));

  // SALVAGE is not terminal execution state. Cancellation forbids NEW relay work,
  // but already-confirmed external media must still converge through the pinned
  // Vault destination and Content Library before an operator may ARCHIVE it.
  if (currentDisposition === SALVAGE) {
    // blockedCode is operational scheduling/observability state, never a second
    // business truth. A stale loser can report a failure after another Desktop
    // already finished Vault/Library convergence; once canonical finalization is
    // proven, that stale retry metadata must not keep SALVAGE from resolving.
    if (media.length > 0 && !finalized) return blockedCode ? "BLOCKED" : "FINALIZATION_PENDING";
    return "SALVAGE_READY";
  }

  // Business terminality is stronger than stale operational retry metadata. A completed/delivered
  // Custom must not remain operator-visible as BLOCKED merely because the last pre-terminal
  // execution attempt left a blockedCode projection behind.
  if (submission.customOrderId && !orderIsLiveContent(order)) return "TERMINAL";
  // Operational blocked state may replace only a CURRENT execution stage. Once
  // canonical source relay + finalization have advanced past execution, stale
  // retry metadata cannot hide assignment/review/delivery-ready business work.
  if (telegram.length === 0 || media.length < telegram.length) return blockedCode ? "BLOCKED" : "SOURCE_RELAY_PENDING";
  if (!finalized) return blockedCode ? "BLOCKED" : "FINALIZATION_PENDING";
  if (!submission.customOrderId) return "ASSIGNMENT_REQUIRED";
  const review = String(submission.reviewStatus || "WAITING_REVIEW").toUpperCase();
  if (review === "REVISION_REQUESTED") return "REVISION_WAITING";
  if (review === "APPROVED") return "APPROVED_DELIVERY_READY";
  return "REVIEW_READY";
}

async function lockCreatorPipelineLifecycle({ db, agencyId, creatorId, allowDeleted = false }) {
  const id = clean(creatorId, 180);
  if (!id || !agencyId) throw fail("CREATOR_NOT_FOUND", "Creator not found", 404);
  let row = null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT "id", "agencyId", "deletedAt", "status"
       FROM "CreatorAccount"
       WHERE "id" = $1 AND "agencyId" = $2
       FOR UPDATE`,
      id,
      String(agencyId),
    );
    row = Array.isArray(rows) ? rows[0] || null : null;
  } else if (db?.creatorAccount?.findFirst) {
    // Test/fallback compatibility. Production Prisma transactions always expose
    // $queryRawUnsafe; without it we can validate state but cannot claim to have
    // the serialization fence.
    row = await db.creatorAccount.findFirst({ where: { id, agencyId }, select: { id: true, agencyId: true, deletedAt: true, status: true } });
  }
  if (!row) throw fail("CREATOR_NOT_FOUND", "Creator not found", 404);
  if (!allowDeleted && row.deletedAt) throw fail("CREATOR_RETIRED", "Creator has already been removed and cannot accept new Custom pipeline work", 409);
  return row;
}

async function lockAgencyPipelineLifecycle({ db, agencyId, allowDeleted = false, mode = "shared" }) {
  const id = clean(agencyId, 180);
  if (!id) throw fail("AGENCY_NOT_FOUND", "Agency not found", 404);
  const lockMode = String(mode || "shared").toLowerCase() === "exclusive" ? "exclusive" : "shared";

  // Phase 2 lock topology: normal creator/order/provider work shares the generic
  // transaction-scoped Agency lifecycle barrier; destructive Agency lifecycle takes it
  // exclusively. Domain-local locks remain below this barrier.
  const barrier = await lockAgencyLifecycleBarrier({ db, agencyId: id, mode: lockMode });
  const row = barrier.row;
  if (!row) throw fail("AGENCY_NOT_FOUND", "Agency not found", 404);
  if (!allowDeleted && row.deletedAt) throw fail("AGENCY_RETIRED", "Agency has been removed and cannot accept new Custom pipeline work", 409);
  return row;
}

async function lockAgencyPipelineLifecycleExclusive({ db, agencyId, allowDeleted = false }) {
  return lockAgencyPipelineLifecycle({ db, agencyId, allowDeleted, mode: "exclusive" });
}

async function withSubmissionPipelineLock({ db, agencyId, submissionId, work }) {
  const id = clean(submissionId, 180);
  if (!db || !agencyId || !id || typeof work !== "function") {
    throw fail("CUSTOM_SUBMISSION_LOCK_INVALID", "Submission lifecycle lock requires a database, agency, submission and work callback", 500);
  }
  const run = async (tx) => {
    if (typeof tx?.$queryRawUnsafe === "function") {
      const rows = await tx.$queryRawUnsafe(
        `SELECT "id" FROM "CustomContentSubmission" WHERE "id" = $1 AND "agencyId" = $2 FOR UPDATE`,
        id,
        String(agencyId),
      );
      if (Array.isArray(rows) && rows.length === 0) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
    } else if (tx?.customContentSubmission?.findFirst) {
      // Unit-test / adapter fallback. Production Prisma transactions use the
      // FOR UPDATE branch above; this fallback validates existence but does not
      // pretend to provide cross-request serialization.
      const row = await tx.customContentSubmission.findFirst({ where: { id, agencyId }, select: { id: true } });
      if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
    }
    return work(tx);
  };
  return typeof db.$transaction === "function" ? db.$transaction(run, { timeout: 35_000 }) : run(db);
}


async function lockCustomExecutionDefaults({ db, agencyId }) {
  const id = clean(agencyId, 180);
  if (!db || !id) throw fail("CUSTOM_EXECUTION_DEFAULTS_LOCK_INVALID", "Execution-default lock requires a database and agency", 500);
  // Reuse the canonical transaction-scoped advisory-lock authority. This fence is
  // intentionally independent of Agency/Creator row locks: profile pinning can already
  // hold the submission row, while cancellation/removal use the opposite
  // Agency -> Creator -> business-row order. One shared advisory-lock implementation
  // gives default publication/pinning a linearization point without creating a second
  // lock primitive or a row-lock cycle.
  await lockDbAdvisoryXact({ db, key: `custom-content-execution-defaults:${id}` });
  return { agencyId: id };
}

async function withCustomExecutionDefaultsLock({ db, agencyId, work }) {
  if (!db || typeof work !== "function") throw fail("CUSTOM_EXECUTION_DEFAULTS_LOCK_INVALID", "Execution-default lock requires a database and work callback", 500);
  const run = async (tx) => {
    await lockCustomExecutionDefaults({ db: tx, agencyId });
    return work(tx);
  };
  return typeof db.$transaction === "function"
    ? db.$transaction(run, { timeout: 35_000 })
    : run(db);
}

async function readExecutionDefaults({ db, agencyId, creatorId }) {
  const [creator, recipientRow] = await Promise.all([
    db.creatorAccount.findFirst({
      where: { id: creatorId, agencyId, deletedAt: null },
      select: { id: true, customsVaultFolderId: true },
    }),
    db.workspaceSetting?.findUnique
      ? db.workspaceSetting.findUnique({
        where: { agencyId_key: { agencyId, key: "vaultUploadRecipient" } },
        select: { value: true },
      }).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!creator) throw fail("CREATOR_NOT_FOUND", "Creator not found", 404);
  return {
    vaultFolderId: clean(creator.customsVaultFolderId, 240) || null,
    relayRecipient: relayRecipient(recipientRow?.value),
  };
}

const HISTORICAL_RELAY_EXECUTION_STATUSES = ["QUEUED", "RETRY_SCHEDULED", "CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED", "COMPLETED"];

function historicalRelayRecipientFromRows({ submission, rows }) {
  const submissionId = clean(submission?.id, 180);
  const creatorId = clean(submission?.creatorId, 180);
  if (!submissionId || !creatorId || !Array.isArray(rows) || !rows.length) return null;
  const telegramIds = Array.isArray(submission.telegramMessageIds) ? submission.telegramMessageIds.map(String) : [];
  const expectedAccountId = clean(submission.telegramSourceAccountId, 180);
  const expectedUserId = clean(submission.telegramSourceUserId, 40);
  const recipients = new Set();
  for (const row of rows) {
    if (clean(row?.creatorId, 180) && clean(row.creatorId, 180) !== creatorId) continue;
    const payload = row?.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
    const index = Number(payload.expectedIndex);
    const expectedKey = Number.isInteger(index) && index >= 0 ? `custom-relay:${submissionId}:${index}` : "";
    const expectedMessageId = Number.isInteger(index) && index >= 0 ? clean(telegramIds[index], 40) : "";
    const boundSubmissionId = clean(payload.submissionId, 180);
    const boundAccountId = clean(payload.telegramSourceAccountId, 180);
    const boundUserId = clean(payload.telegramSourceUserId, 40);
    const boundMessageId = clean(payload.telegramMessageId, 40);
    const recipient = relayRecipient(payload.recipient);
    if (!expectedKey || clean(row.idempotencyKey, 500) !== expectedKey || boundSubmissionId !== submissionId
        || !expectedMessageId || boundAccountId !== expectedAccountId || boundUserId !== expectedUserId
        || boundMessageId !== expectedMessageId || !recipient) {
      throw fail(
        "CUSTOM_SUBMISSION_EXECUTION_PROFILE_LEGACY_BINDING_CONFLICT",
        "Historical Custom relay execution cannot be bound safely to the submission execution profile",
        409,
        { submissionId, writeId: clean(row.id, 180) || null },
      );
    }
    recipients.add(recipient);
  }
  if (recipients.size > 1) {
    throw fail(
      "CUSTOM_SUBMISSION_EXECUTION_PROFILE_LEGACY_RECIPIENT_CONFLICT",
      "Historical Custom relay writes used multiple recipients; explicit operator reconciliation is required before execution can continue",
      409,
      { submissionId, recipients: [...recipients] },
    );
  }
  return [...recipients][0] || null;
}

async function historicalRelayRecipientsForSubmissions({ db, agencyId, submissions }) {
  const list = Array.from(new Map((Array.isArray(submissions) ? submissions : [])
    .filter((submission) => clean(submission?.id, 180) && clean(submission?.creatorId, 180))
    .map((submission) => [String(submission.id), submission])).values());
  const result = new Map(list.map((submission) => [String(submission.id), { recipient: null, error: null }]));
  if (!list.length || !db?.automationDelivery?.findMany) return result;

  const queryChunk = 100;
  for (let offset = 0; offset < list.length; offset += queryChunk) {
    const chunk = list.slice(offset, offset + queryChunk);
    const rows = await db.automationDelivery.findMany({
      where: {
        agencyId,
        actionType: "CUSTOM_RELAY_SEND",
        status: { in: HISTORICAL_RELAY_EXECUTION_STATUSES },
        OR: chunk.map((submission) => ({
          creatorId: String(submission.creatorId),
          idempotencyKey: { startsWith: `custom-relay:${String(submission.id)}:` },
        })),
      },
      select: { id: true, creatorId: true, idempotencyKey: true, status: true, payload: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const submission of chunk) {
      const prefix = `custom-relay:${String(submission.id)}:`;
      const matching = (rows || []).filter((row) => String(row?.creatorId || "") === String(submission.creatorId)
        && String(row?.idempotencyKey || "").startsWith(prefix));
      try {
        result.set(String(submission.id), { recipient: historicalRelayRecipientFromRows({ submission, rows: matching }), error: null });
      } catch (error) {
        result.set(String(submission.id), { recipient: null, error });
      }
    }
  }
  return result;
}

async function historicalRelayRecipientForSubmission({ db, agencyId, submission }) {
  const map = await historicalRelayRecipientsForSubmissions({ db, agencyId, submissions: [submission] });
  const entry = map.get(String(submission?.id || ""));
  if (entry?.error) throw entry.error;
  return entry?.recipient || null;
}

async function ensureSubmissionExecutionProfile({ db, agencyId, submission, now = new Date(), requireRelayRecipient = true }) {
  if (!submission) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  const pinnedFolder = clean(submission.executionVaultFolderId, 240) || null;
  const pinnedRecipient = clean(submission.executionRelayRecipient, 240) || null;
  if (pinnedFolder && submission.executionPinnedAt && (pinnedRecipient || !requireRelayRecipient)) {
    return { submission, vaultFolderId: pinnedFolder, relayRecipient: pinnedRecipient, pinnedNow: false };
  }

  return withCustomExecutionDefaultsLock({ db, agencyId, work: async (lockedDb) => {
    // Re-check after waiting for the default-publication fence. Another executor may
    // have pinned this submission while we were queued; immutable pinned facts always win.
    const fresh = lockedDb.customContentSubmission?.findFirst
      ? await lockedDb.customContentSubmission.findFirst({ where: { id: submission.id, agencyId } })
      : null;
    const base = fresh || submission;
    const existingFolder = clean(base.executionVaultFolderId, 240) || null;
    const existingRecipient = clean(base.executionRelayRecipient, 240) || null;
    if (existingFolder && base.executionPinnedAt && (existingRecipient || !requireRelayRecipient)) {
      return { submission: base, vaultFolderId: existingFolder, relayRecipient: existingRecipient, pinnedNow: false };
    }

    const defaults = await readExecutionDefaults({ db: lockedDb, agencyId, creatorId: String(base.creatorId) });
    // Rolling-cutover safety: pre-cutover CUSTOM_RELAY_SEND rows already pinned
    // their recipient in the durable write payload even though the submission had
    // no execution-profile columns yet. That historical execution fact outranks
    // the current Workspace default. If history is internally contradictory we
    // fail closed instead of inventing one recipient for the remaining media.
    const historicalRecipient = requireRelayRecipient
      ? await historicalRelayRecipientForSubmission({ db: lockedDb, agencyId, submission: base })
      : null;
    // FINALIZE_LIBRARY is deliberately relay-recipient independent. Do not let
    // contradictory historical transport configuration block move-only recovery,
    // and do not pin today's mutable relay default onto work that will never relay
    // another source message.
    const chosenRecipient = requireRelayRecipient ? (historicalRecipient || defaults.relayRecipient) : (existingRecipient || null);
    if (!defaults.vaultFolderId) throw fail("CUSTOM_SUBMISSION_VAULT_RELAY_REQUIRED", "Customs Vault destination is not configured", 409);
    if (requireRelayRecipient && !chosenRecipient) throw fail("CUSTOM_SUBMISSION_VAULT_RECIPIENT_REQUIRED", "Vault upload recipient is not configured", 409);

    const changed = await lockedDb.customContentSubmission.updateMany({
      where: {
        id: base.id,
        agencyId,
        executionPinnedAt: null,
        executionVaultFolderId: null,
        ...(requireRelayRecipient ? { executionRelayRecipient: null } : {}),
      },
      data: {
        executionVaultFolderId: defaults.vaultFolderId,
        executionRelayRecipient: chosenRecipient || null,
        executionProfileRevision: { increment: 1 },
        executionPinnedAt: now,
        ...invalidateVaultSettlementData(),
      },
    });
    const current = Number(changed?.count || 0) === 1
      ? { ...base, executionVaultFolderId: defaults.vaultFolderId, executionRelayRecipient: chosenRecipient, executionProfileRevision: Number(base.executionProfileRevision || 0) + 1, executionPinnedAt: now }
      : await lockedDb.customContentSubmission.findFirst({ where: { id: base.id, agencyId } });
    const vaultFolderId = clean(current?.executionVaultFolderId, 240) || null;
    const relayRecipient = clean(current?.executionRelayRecipient, 240) || null;
    if (!vaultFolderId || (requireRelayRecipient && !relayRecipient) || !current?.executionPinnedAt) {
      throw fail("CUSTOM_SUBMISSION_EXECUTION_PROFILE_CONFLICT", "Submission execution profile could not be pinned atomically", 409);
    }
    return { submission: current, vaultFolderId, relayRecipient, pinnedNow: Number(changed?.count || 0) === 1 };
  } });
}

async function loadSubmissionLifecycle({ db, agencyId, submissionId }) {
  const row = await db.customContentSubmission.findFirst({
    where: { id: submissionId, agencyId },
    include: {
      customOrder: { select: { id: true, type: true, status: true, fanDeliveredAt: true, creatorId: true } },
    },
  });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  return row;
}

async function assertNewRelayWorkAllowed({ db, agencyId, submissionId }) {
  const row = await loadSubmissionLifecycle({ db, agencyId, submissionId });
  if (!submissionAllowsNewPipelineWork(row, row.customOrder)) {
    throw fail("CUSTOM_SUBMISSION_PIPELINE_TERMINAL", "This Custom content pipeline no longer permits new relay writes", 409, {
      disposition: disposition(row.pipelineDisposition),
      customOrderStatus: row.customOrder?.status || null,
    });
  }
  return row;
}

async function cancelPrecommitRelayWritesForSubmissions({ db, agencyId, creatorId = null, submissionIds, now = new Date(), reason = "CUSTOM_PIPELINE_TERMINAL" }) {
  const ids = Array.from(new Set((submissionIds || []).map((id) => clean(id, 180)).filter(Boolean)));
  if (!ids.length) return { changed: 0 };
  const changed = await db.automationDelivery.updateMany({
    where: {
      agencyId,
      ...(creatorId ? { creatorId } : {}),
      actionType: "CUSTOM_RELAY_SEND",
      status: { in: PRECOMMIT_WRITE_STATUSES },
      OR: ids.map((id) => ({ targetId: { startsWith: `${id}:` } })),
    },
    data: {
      status: "CANCELED",
      failureCode: "custom_pipeline_cancelled_precommit",
      failureCategory: "TERMINAL",
      lastError: clean(reason, 500) || "Custom pipeline became terminal before external commit",
      finishedAt: now,
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      lastCheckedAt: now,
    },
  });
  return { changed: Number(changed?.count || 0) };
}

async function cancelPrecommitManualWritesForOrder({ db, agencyId, customOrderId, now = new Date(), reason = "CUSTOM_ORDER_CANCELLED" }) {
  const orderId = clean(customOrderId, 180);
  if (!orderId) return { changed: 0 };
  const changed = await db.automationDelivery.updateMany({
    where: {
      agencyId,
      actionType: "CUSTOM_MANUAL_SEND",
      targetId: orderId,
      status: { in: PRECOMMIT_WRITE_STATUSES },
    },
    data: {
      status: "CANCELED",
      failureCode: "custom_manual_delivery_cancelled_precommit",
      failureCategory: "TERMINAL",
      lastError: clean(reason, 500) || "Custom order became terminal before physical-send commit",
      finishedAt: now,
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      lastCheckedAt: now,
    },
  });
  return { changed: Number(changed?.count || 0) };
}


function customExternalWriteClassification({ delivery, submission = null, order = null } = {}) {
  const actionType = clean(delivery?.actionType, 80);
  const status = clean(delivery?.status, 80).toUpperCase();
  const failureCode = clean(delivery?.failureCode, 180);
  const result = delivery?.result && typeof delivery.result === "object" && !Array.isArray(delivery.result) ? delivery.result : {};
  if (!CUSTOM_EXTERNAL_ACTION_TYPES.includes(actionType)) return { state: "IRRELEVANT", converged: true };
  if (PRECOMMIT_WRITE_STATUSES.includes(status)) return { state: "PRECOMMIT", converged: false };
  if (CUSTOM_EXTERNAL_UNRESOLVED_STATUSES.includes(status)
      || (status === "FAILED" && failureCode === "outcome_unresolved_do_not_retry")) {
    return { state: "OUTCOME_UNRESOLVED", converged: false };
  }
  if (status !== "COMPLETED") return { state: "PROVEN_NO_EFFECT_OR_TERMINAL", converged: true };

  if (actionType === "CUSTOM_RELAY_SEND") {
    const mediaId = clean(result.mediaId, 240);
    const projected = new Set(normalizedSettlementMediaIds(submission?.ofMediaIds));
    if (!mediaId || !submission || !projected.has(mediaId)) {
      return { state: "COMPLETED_UNPROJECTED", converged: false, mediaId: mediaId || null };
    }
    return { state: "FULLY_CONVERGED", converged: true, mediaId };
  }

  const messageId = clean(delivery?.messageId || result.messageId, 240);
  const mediaIds = normalizedSettlementMediaIds(result.mediaIds);
  const projectedMessages = new Set(normalizedSettlementMediaIds(order?.deliveryMessageIds));
  const projectedMedia = new Set(normalizedSettlementMediaIds(order?.deliverySentMediaIds));
  const projected = Boolean(order && messageId && projectedMessages.has(messageId)
    && mediaIds.length > 0 && mediaIds.every((mediaId) => projectedMedia.has(mediaId)));
  return projected
    ? { state: "FULLY_CONVERGED", converged: true, messageId, mediaIds }
    : { state: "COMPLETED_UNPROJECTED", converged: false, messageId: messageId || null, mediaIds };
}

async function customSubmissionExternalEffectConvergence({ db, agencyId, submission, order = undefined }) {
  if (!submission?.id) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  const customOrder = order === undefined && submission.customOrderId && db.customOrder?.findFirst
    ? await db.customOrder.findFirst({
      where: { id: submission.customOrderId, agencyId, creatorId: submission.creatorId },
      select: { id: true, deliveryMessageIds: true, deliverySentMediaIds: true },
    })
    : (order || null);
  const ors = [{ actionType: "CUSTOM_RELAY_SEND", targetId: { startsWith: `${submission.id}:` } }];
  if (submission.customOrderId) ors.push({ actionType: "CUSTOM_MANUAL_SEND", targetId: String(submission.customOrderId) });
  const writes = db.automationDelivery?.findMany ? await db.automationDelivery.findMany({
    where: { agencyId, creatorId: submission.creatorId, OR: ors },
    select: { id: true, actionType: true, targetId: true, status: true, failureCode: true, result: true, messageId: true, updatedAt: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  }) : [];
  const items = (writes || []).map((delivery) => ({
    deliveryId: String(delivery.id), actionType: String(delivery.actionType || ""), status: String(delivery.status || ""),
    ...customExternalWriteClassification({ delivery, submission, order: customOrder }),
  }));
  const debt = items.filter((item) => !item.converged);
  return {
    converged: debt.length === 0,
    debt,
    items,
    precommit: debt.filter((item) => item.state === "PRECOMMIT"),
    unresolved: debt.filter((item) => item.state === "OUTCOME_UNRESOLVED"),
    completedUnprojected: debt.filter((item) => item.state === "COMPLETED_UNPROJECTED"),
  };
}

async function findCompletedCustomExternalProjectionDebt({ db, agencyId, creatorId = null }) {
  if (!db.automationDelivery?.findMany) return [];
  const debt = [];
  let cursor = null;
  for (;;) {
    const rows = await db.automationDelivery.findMany({
      where: {
        agencyId,
        ...(creatorId ? { creatorId } : {}),
        actionType: { in: CUSTOM_EXTERNAL_ACTION_TYPES },
        status: "COMPLETED",
      },
      select: { id: true, creatorId: true, actionType: true, targetId: true, status: true, failureCode: true, payload: true, result: true, messageId: true, updatedAt: true },
      orderBy: [{ id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
      const result = row.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {};
      const submissionId = clean(payload.submissionId || result.submissionId || (String(row.actionType) === "CUSTOM_RELAY_SEND" ? String(row.targetId || "").split(":")[0] : ""), 180);
      const orderId = clean(payload.customOrderId || result.customOrderId || (String(row.actionType) === "CUSTOM_MANUAL_SEND" ? row.targetId : ""), 180);
      const [submission, order] = await Promise.all([
        submissionId && db.customContentSubmission?.findFirst
          ? db.customContentSubmission.findFirst({ where: { id: submissionId, agencyId, creatorId: row.creatorId }, select: { id: true, ofMediaIds: true } })
          : Promise.resolve(null),
        orderId && db.customOrder?.findFirst
          ? db.customOrder.findFirst({ where: { id: orderId, agencyId, creatorId: row.creatorId }, select: { id: true, deliveryMessageIds: true, deliverySentMediaIds: true } })
          : Promise.resolve(null),
      ]);
      const classification = customExternalWriteClassification({ delivery: row, submission, order });
      if (!classification.converged) debt.push({ deliveryId: String(row.id), creatorId: String(row.creatorId), actionType: String(row.actionType), ...classification });
    }
    if (rows.length < 200) break;
  }
  return debt;
}

async function assertCustomSubmissionExternalEffectsConverged({ db, agencyId, submission, order = undefined }) {
  const convergence = await customSubmissionExternalEffectConvergence({ db, agencyId, submission, order });
  if (!convergence.converged) {
    throw fail("CUSTOM_SUBMISSION_EXTERNAL_EFFECT_NOT_CONVERGED", "All Custom external effects must converge before terminal resolution", 409, {
      debt: convergence.debt.map((item) => ({ deliveryId: item.deliveryId, actionType: item.actionType, status: item.status, state: item.state })),
    });
  }
  return convergence;
}

async function adjudicateCustomOrderCancellation({ db, agencyId, customOrderId, now = new Date(), reason = "CUSTOM_ORDER_CANCELLED" }) {
  // Cancellation and relay reservation serialize on the same submission rows.
  // The caller executes this inside the CustomOrder update transaction. If a
  // relay reserve already owns a row lock, cancellation waits and then sees the
  // durable reservation; if cancellation owns the row first, a late reserve
  // cannot pass its lifecycle recheck until SALVAGE has committed.
  const submissions = typeof db?.$queryRawUnsafe === "function"
    ? await db.$queryRawUnsafe(
      `SELECT "id", "creatorId"
       FROM "CustomContentSubmission"
       WHERE "agencyId" = $1 AND "customOrderId" = $2 AND "pipelineDisposition" = 'ACTIVE'
       ORDER BY "id" ASC
       FOR UPDATE`,
      String(agencyId),
      String(customOrderId),
    )
    : await db.customContentSubmission.findMany({
      where: { agencyId, customOrderId, pipelineDisposition: ACTIVE },
      select: { id: true, creatorId: true },
    });
  const changed = await db.customContentSubmission.updateMany({
    where: { agencyId, customOrderId, pipelineDisposition: ACTIVE },
    data: { pipelineDisposition: SALVAGE, pipelineDispositionReason: clean(reason, 300), pipelineDispositionChangedAt: now },
  });
  // Cancellation is a real external-write boundary. A write that has not
  // crossed COMMITTING is proven precommit and can be terminalized. If the
  // commit CAS wins first, this update no longer matches and COMMITTING /
  // RECONCILE_REQUIRED is deliberately preserved for outcome settlement.
  const byCreator = new Map();
  for (const row of submissions || []) {
    const creatorId = clean(row.creatorId, 180);
    const ids = byCreator.get(creatorId) || []; ids.push(row.id); byCreator.set(creatorId, ids);
  }
  let cancelledPrecommitWrites = 0;
  for (const [creatorId, submissionIds] of byCreator.entries()) {
    const cancelled = await cancelPrecommitRelayWritesForSubmissions({ db, agencyId, creatorId, submissionIds, now, reason });
    cancelledPrecommitWrites += cancelled.changed;
  }
  const cancelledManual = await cancelPrecommitManualWritesForOrder({ db, agencyId, customOrderId, now, reason });
  cancelledPrecommitWrites += cancelledManual.changed;
  return { changed: Number(changed?.count || 0), cancelledPrecommitWrites, disposition: SALVAGE };
}

async function setUnassignedSubmissionDisposition({ db, agencyId, submissionId, nextDisposition, reason = null, now = new Date(), allowRetiredConfirmedAbandon = false }) {
  const next = disposition(nextDisposition);
  if (!RESOLUTION_DISPOSITIONS.has(next)) throw fail("CUSTOM_SUBMISSION_DISPOSITION_INVALID", "Content can only be resolved as SALVAGE, ARCHIVED, or ABANDONED", 400);
  return withSubmissionPipelineLock({ db, agencyId, submissionId, work: async (lockedDb) => {
    const row = await lockedDb.customContentSubmission.findFirst({ where: { id: submissionId, agencyId } });
    if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
    const current = disposition(row.pipelineDisposition);
    if ([ARCHIVED, ABANDONED].includes(current)) {
      if (next === current) return { ok: true, unchanged: true, submissionId: row.id, pipelineDisposition: current };
      throw fail("CUSTOM_SUBMISSION_DISPOSITION_TERMINAL_REWRITE_FORBIDDEN", "Terminal Custom content disposition cannot be rewritten by the ordinary resolution endpoint", 409);
    }
    if (row.customOrderId && current !== SALVAGE) {
      throw fail("CUSTOM_SUBMISSION_DISPOSITION_ASSIGNED", "Live assigned content must be resolved through its Custom order lifecycle", 409);
    }
    if (row.customOrderId && next === SALVAGE) return { ok: true, submissionId: row.id, pipelineDisposition: SALVAGE };
    if (next === ARCHIVED || next === ABANDONED) {
      await cancelPrecommitRelayWritesForSubmissions({ db: lockedDb, agencyId, creatorId: row.creatorId, submissionIds: [row.id], now, reason: reason || `CUSTOM_SUBMISSION_${next}` });
      if (row.customOrderId) await cancelPrecommitManualWritesForOrder({ db: lockedDb, agencyId, customOrderId: row.customOrderId, now, reason: reason || `CUSTOM_SUBMISSION_${next}` });
      await assertCustomSubmissionExternalEffectsConverged({ db: lockedDb, agencyId, submission: row });
    }

    if (next === ARCHIVED || next === ABANDONED) {
      const mediaIds = Array.from(new Set((Array.isArray(row.ofMediaIds) ? row.ofMediaIds : []).map(String).filter(Boolean)));
      if (next === ARCHIVED && mediaIds.length === 0) {
        throw fail("CUSTOM_SUBMISSION_ARCHIVE_MEDIA_REQUIRED", "Ordinary ARCHIVE requires proven Custom media; source-only content can only be abandoned or explicitly recovered", 409);
      }
      if (mediaIds.length && next === ABANDONED) {
        const creator = allowRetiredConfirmedAbandon
          ? await lockedDb.creatorAccount.findFirst({ where: { id: row.creatorId, agencyId }, select: { id: true, deletedAt: true } })
          : null;
        const retired = Boolean(creator?.deletedAt);
        if (!retired) {
          throw fail("CUSTOM_SUBMISSION_ABANDON_CONFIRMED_MEDIA_FORBIDDEN", "Confirmed Custom media cannot be abandoned while the creator is active; finish safe salvage and archive it instead", 409);
        }
        if (!clean(reason, 300)) {
          throw fail("CUSTOM_SUBMISSION_RETIRED_ABANDON_REASON_REQUIRED", "Explicit reason is required to abandon confirmed media for a retired creator", 400);
        }
        // Historical creator removal may have destroyed the only OF/Vault execution capability
        // before this cutover existed. ABANDONED is therefore an explicit operator decision to
        // stop convergence, not proof of Vault settlement. Canonical ofMediaIds / relay receipts
        // remain untouched for audit/history and no synthetic destination fact is created.
      }
      if (mediaIds.length && next !== ABANDONED) {
        // A historical CreatorMediaAsset projection is not proof that legacy or
        // cancelled media was physically reconciled into a durable destination.
        // The execution profile is the historical destination authority; without
        // it, retirement must remain fail-closed and the move-only finalizer must
        // heal the submission first.
        if (!hasCurrentVaultSettlement(row)) {
          throw fail("CUSTOM_SUBMISSION_SALVAGE_FINALIZATION_REQUIRED", "Confirmed Custom media must have a current durable Vault-settlement receipt before terminal resolution", 409);
        }
        const assets = await lockedDb.creatorMediaAsset.findMany({
          where: { agencyId, creatorId: row.creatorId, mediaId: { in: mediaIds }, source: "CUSTOM", customSubmissionId: row.id },
          select: { mediaId: true, source: true, customOrderId: true, customSubmissionId: true, customFullPriceCents: true, catalogActive: true, sortingStatus: true, folderIds: true },
          take: mediaIds.length,
        });
        const order = row.customOrderId
          ? await lockedDb.customOrder.findFirst({ where: { id: row.customOrderId, agencyId, creatorId: row.creatorId }, select: { id: true, priceCents: true } })
          : null;
        const projected = new Map(assets.map((asset) => [String(asset.mediaId), asset]));
        if (mediaIds.some((mediaId) => !customAssetMatchesPipelineProjection(row, projected.get(mediaId), order))) {
          throw fail("CUSTOM_SUBMISSION_SALVAGE_FINALIZATION_REQUIRED", "Confirmed Custom media must finish safe Vault/Content Library salvage before terminal resolution", 409);
        }
      }
    }
    await lockedDb.customContentSubmission.update({
      where: { id: row.id },
      data: {
        pipelineDisposition: next,
        pipelineDispositionReason: clean(reason, 300) || null,
        pipelineDispositionChangedAt: now,
        pipelineBlockedCode: null,
        pipelineBlockedAt: null,
        pipelineNextAttemptAt: null,
      },
    });
    return { ok: true, submissionId: row.id, pipelineDisposition: next };
  } });
}

function executionFailureStillApplies({ submission, order = null, expectedWorkKind = null, expectedIndex = null, expectedExecutionProfileRevision = null } = {}) {
  const kind = clean(expectedWorkKind, 40).toUpperCase();
  if (!kind) return true; // Server-side diagnostic reports are already derived from current state.
  const expectedRevision = Number(expectedExecutionProfileRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0 || Number(submission?.executionProfileRevision || 0) !== expectedRevision) return false;

  const currentDisposition = disposition(submission?.pipelineDisposition);
  const telegram = normalizedSettlementMediaIds(submission?.telegramMessageIds);
  const media = normalizedSettlementMediaIds(submission?.ofMediaIds);
  if (kind === "UPLOAD_MEDIA") {
    const index = Number(expectedIndex);
    if (!Number.isInteger(index) || index < 0) return false;
    return currentDisposition === ACTIVE
      && submissionAllowsNewPipelineWork(submission, order)
      && media.length === index
      && index < telegram.length;
  }
  if (kind === "FINALIZE_LIBRARY") {
    if (![ACTIVE, SALVAGE].includes(currentDisposition) || media.length === 0) return false;
    if (currentDisposition === ACTIVE && media.length !== telegram.length) return false;
    if (currentDisposition === ACTIVE && !submissionAllowsNewPipelineWork(submission, order)) return false;
    return true;
  }
  return false;
}

async function reportSubmissionExecutionAttempt({
  db, agencyId, submissionId, success, code = null, now = new Date(),
  expectedWorkKind = null, expectedIndex = null, expectedExecutionProfileRevision = null,
}) {
  return withSubmissionPipelineLock({ db, agencyId, submissionId, work: async (lockedDb) => {
    const row = await lockedDb.customContentSubmission.findFirst({ where: { id: submissionId, agencyId } });
    if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
    if (success) {
      // Success may legitimately advance the canonical stage before this best-effort
      // scheduling report arrives. Clearing retry metadata can only make recovery
      // earlier; external-write correctness remains fenced by the durable write authority.
      await lockedDb.customContentSubmission.update({
        where: { id: row.id },
        data: { pipelineBlockedCode: null, pipelineBlockedAt: null, pipelineLastAttemptAt: now, pipelineNextAttemptAt: null },
      });
      return { ok: true, blocked: false, stale: false, nextAttemptAt: null };
    }

    const order = row.customOrderId && lockedDb.customOrder?.findFirst
      ? await lockedDb.customOrder.findFirst({
        where: { id: row.customOrderId, agencyId, creatorId: row.creatorId },
        select: { id: true, type: true, status: true, fanDeliveredAt: true },
      })
      : null;
    if (!executionFailureStillApplies({
      submission: row, order, expectedWorkKind, expectedIndex, expectedExecutionProfileRevision,
    })) {
      // A slower/failed executor must not put a newer canonical stage back behind
      // its old 90-second retry barrier. This is operational projection only: stale
      // reports are acknowledged and discarded, never converted into business truth.
      return { ok: true, blocked: false, stale: true, nextAttemptAt: row.pipelineNextAttemptAt ? new Date(row.pipelineNextAttemptAt).toISOString() : null };
    }

    const normalizedCode = clean(code, 180) || "CUSTOM_SUBMISSION_EXECUTION_FAILED";
    const nextAttemptAt = new Date(now.getTime() + 90_000);
    await lockedDb.customContentSubmission.update({
      where: { id: row.id },
      data: { pipelineBlockedCode: normalizedCode, pipelineBlockedAt: now, pipelineLastAttemptAt: now, pipelineNextAttemptAt: nextAttemptAt },
    });
    return { ok: true, blocked: true, stale: false, code: normalizedCode, nextAttemptAt: nextAttemptAt.toISOString() };
  } });
}

async function creatorCustomPipelineBlockers({ db, agencyId, creatorId }) {
  const [pendingOrders, activeSubmissions, activeWrites, activeTelegramDeliveries, unresolvedInboundEvents, cancelledTelegramFollowupDebtRows, latentConfirmedProjectionDebtRows, completedExternalProjectionDebtRows] = await Promise.all([
    // Every PENDING CustomOrder is live business work. CALL / PHYSICAL do not
    // use the Content submission pipeline, but retiring their creator would
    // still orphan their task/reminder/status lifecycle.
    db.customOrder.count({ where: { agencyId, creatorId, status: "PENDING" } }),
    db.customContentSubmission.count({
      where: { agencyId, creatorId, ...unresolvedPipelineSubmissionWhere() },
    }),
    db.automationDelivery.count({ where: {
      agencyId, creatorId, actionType: { in: ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"] },
      OR: [
        { status: { in: ACTIVE_WRITE_STATUSES } },
        { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
      ],
    } }),
    db.telegramDeliveryIntent?.count
      ? db.telegramDeliveryIntent.count({
        where: {
          agencyId, creatorId,
          OR: [
            { state: { in: ACTIVE_TELEGRAM_DELIVERY_STATES } },
            { state: "CONFIRMED", projectionBlockedAt: { not: null } },
          ],
        },
      })
      : Promise.resolve(0),
    db.telegramInboundEvent?.count
      ? db.telegramInboundEvent.count({
        where: {
          agencyId, creatorId, hasMedia: true, submissionId: null,
          projectionState: { in: UNRESOLVED_INBOUND_PROJECTION_STATES },
        },
      })
      : Promise.resolve(0),
    findCancelledModelInstructionFollowupDebt({ agencyId, creatorIds: [creatorId], db }),
    findConfirmedTelegramProjectionDebt({ agencyId, creatorIds: [creatorId], db, onlyUnmarked: true }),
    findCompletedCustomExternalProjectionDebt({ db, agencyId, creatorId }),
  ]);
  const cancelledTelegramFollowupDebt = cancelledTelegramFollowupDebtRows.length;
  const confirmedTelegramProjectionDebt = latentConfirmedProjectionDebtRows.length;
  const completedExternalProjectionDebt = completedExternalProjectionDebtRows.length;
  return {
    pendingOrders, activeSubmissions, activeWrites, activeTelegramDeliveries, unresolvedInboundEvents, cancelledTelegramFollowupDebt, confirmedTelegramProjectionDebt, completedExternalProjectionDebt,
    total: pendingOrders + activeSubmissions + activeWrites + activeTelegramDeliveries + unresolvedInboundEvents + cancelledTelegramFollowupDebt + confirmedTelegramProjectionDebt + completedExternalProjectionDebt,
  };
}

async function agencyCustomPipelineBlockers({ db, agencyId }) {
  const [pendingOrders, activeSubmissions, activeWrites, activeTelegramDeliveries, unresolvedInboundEvents, cancelledTelegramFollowupDebtRows, latentConfirmedProjectionDebtRows, completedExternalProjectionDebtRows] = await Promise.all([
    db.customOrder.count({ where: { agencyId, status: "PENDING" } }),
    db.customContentSubmission.count({ where: { agencyId, ...unresolvedPipelineSubmissionWhere() } }),
    db.automationDelivery.count({ where: {
      agencyId, actionType: { in: ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"] },
      OR: [
        { status: { in: ACTIVE_WRITE_STATUSES } },
        { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry" },
      ],
    } }),
    db.telegramDeliveryIntent?.count
      ? db.telegramDeliveryIntent.count({
        where: {
          agencyId,
          OR: [
            { state: { in: ACTIVE_TELEGRAM_DELIVERY_STATES } },
            { state: "CONFIRMED", projectionBlockedAt: { not: null } },
          ],
        },
      })
      : Promise.resolve(0),
    db.telegramInboundEvent?.count
      ? db.telegramInboundEvent.count({
        where: {
          agencyId, hasMedia: true, submissionId: null,
          projectionState: { in: UNRESOLVED_INBOUND_PROJECTION_STATES },
        },
      })
      : Promise.resolve(0),
    findCancelledModelInstructionFollowupDebt({ agencyId, db }),
    findConfirmedTelegramProjectionDebt({ agencyId, db, onlyUnmarked: true }),
    findCompletedCustomExternalProjectionDebt({ db, agencyId }),
  ]);
  const cancelledTelegramFollowupDebt = cancelledTelegramFollowupDebtRows.length;
  const confirmedTelegramProjectionDebt = latentConfirmedProjectionDebtRows.length;
  const completedExternalProjectionDebt = completedExternalProjectionDebtRows.length;
  return {
    pendingOrders, activeSubmissions, activeWrites, activeTelegramDeliveries, unresolvedInboundEvents, cancelledTelegramFollowupDebt, confirmedTelegramProjectionDebt, completedExternalProjectionDebt,
    total: pendingOrders + activeSubmissions + activeWrites + activeTelegramDeliveries + unresolvedInboundEvents + cancelledTelegramFollowupDebt + confirmedTelegramProjectionDebt + completedExternalProjectionDebt,
  };
}

async function assertCreatorCustomPipelineRetirable({ db, agencyId, creatorId }) {
  const blockers = await creatorCustomPipelineBlockers({ db, agencyId, creatorId });
  if (blockers.total > 0) {
    throw fail("CREATOR_HAS_ACTIVE_CUSTOMS", "Resolve active Custom / Telegram work before removing this creator", 409, blockers);
  }
  return blockers;
}

async function assertAgencyCustomPipelineRetirable({ db, agencyId }) {
  const blockers = await agencyCustomPipelineBlockers({ db, agencyId });
  if (blockers.total > 0) {
    throw fail("AGENCY_HAS_ACTIVE_CUSTOMS", "Resolve active Custom / Telegram work before removing this agency", 409, blockers);
  }
  return blockers;
}

module.exports = {
  ACTIVE,
  SALVAGE,
  ARCHIVED,
  ABANDONED,
  PRECOMMIT_WRITE_STATUSES,
  ACTIVE_WRITE_STATUSES,
  UNRESOLVED_INBOUND_PROJECTION_STATES,
  CUSTOM_EXTERNAL_ACTION_TYPES,
  customExternalWriteClassification,
  customSubmissionExternalEffectConvergence,
  assertCustomSubmissionExternalEffectsConverged,
  findCompletedCustomExternalProjectionDebt,
  disposition,
  normalizedSettlementMediaIds,
  vaultSettlementFingerprint,
  hasCurrentVaultSettlement,
  customAssetMatchesPipelineProjection,
  invalidateVaultSettlementData,
  orderIsLiveContent,
  submissionAllowsNewPipelineWork,
  unresolvedPipelineSubmissionWhere,
  derivePipelineStage,
  executionFailureStillApplies,
  lockAgencyPipelineLifecycle,
  lockAgencyPipelineLifecycleExclusive,
  agencyPipelineLifecycleBarrierKey: agencyLifecycleBarrierKey,
  lockCreatorPipelineLifecycle,
  withSubmissionPipelineLock,
  lockCustomExecutionDefaults,
  withCustomExecutionDefaultsLock,
  ensureSubmissionExecutionProfile,
  historicalRelayRecipientsForSubmissions,
  assertNewRelayWorkAllowed,
  cancelPrecommitRelayWritesForSubmissions,
  cancelPrecommitManualWritesForOrder,
  adjudicateCustomOrderCancellation,
  setUnassignedSubmissionDisposition,
  reportSubmissionExecutionAttempt,
  creatorCustomPipelineBlockers,
  agencyCustomPipelineBlockers,
  assertCreatorCustomPipelineRetirable,
  assertAgencyCustomPipelineRetirable,
};
