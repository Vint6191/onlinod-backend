"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { assertTelegramInboundRuntimeLease } = require("./telegram-execution-runtime");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { resolveTelegramAccountId } = require("./custom-order-reminders");
const { createCustomContentSubmissionFromInboundEvent, assignCustomContentSubmission } = require("./custom-content-submissions-service");

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 4000) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }
function positiveInt(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw fail("TELEGRAM_INBOUND_MESSAGE_ID_INVALID", `${field} must be a positive Telegram message id`); return n;
}
function sentAt(value, now) { const d = new Date(String(value || "")); if (!Number.isFinite(d.getTime())) return new Date(now); return d; }
function eventId({ agencyId, accountId, senderTelegramUserId, messageId }) { return `tgi_${crypto.createHash("sha256").update(`${agencyId}\n${accountId}\n${senderTelegramUserId}\n${messageId}`).digest("hex")}`; }

async function resolveCreator({ agencyId, accountId, senderTelegramUserId, replyToMessageId = null, db }) {
  // A direct Reply to our own CONFIRMED provider message is the strongest correlation proof.
  // It also works when remoteRecipientTelegramUserId could not be persisted during manual repair.
  if (replyToMessageId && db.telegramDeliveryIntent?.findFirst) {
    const replied = await db.telegramDeliveryIntent.findFirst({
      where: { agencyId, accountId, state: "CONFIRMED", remoteMessageId: replyToMessageId },
      select: { creatorId: true, customOrderId: true, remoteRecipientTelegramUserId: true },
      orderBy: { confirmedAt: "desc" },
    });
    if (replied) {
      const provenRecipient = clean(replied.remoteRecipientTelegramUserId, 40);
      if (provenRecipient && provenRecipient !== String(senderTelegramUserId)) return { creator: null, proven: true, conflict: true, customOrderId: null };
      return { creator: { id: String(replied.creatorId), telegramAccountId: accountId, telegramUserId: senderTelegramUserId }, proven: true, conflict: false, customOrderId: String(replied.customOrderId) };
    }
  }

  // A confirmed provider recipient receipt is stronger than the best-effort
  // Creator.telegramUserId projection. This keeps inbound correlation alive when
  // the post-send identity PATCH was lost and prevents stale identity projection
  // from becoming submission provenance while a provider receipt is still pending.
  if (db.telegramDeliveryIntent?.findMany) {
    const proven = await db.telegramDeliveryIntent.findMany({
      where: { agencyId, accountId, state: "CONFIRMED", remoteRecipientTelegramUserId: senderTelegramUserId },
      select: { creatorId: true }, orderBy: [{ confirmedAt: "desc" }, { id: "desc" }], take: 20,
    });
    const provenCreatorIds = Array.from(new Set((proven || []).map((row) => String(row.creatorId || "")).filter(Boolean)));
    if (provenCreatorIds.length === 1) return { creator: { id: provenCreatorIds[0], telegramAccountId: accountId, telegramUserId: senderTelegramUserId }, proven: true, conflict: false, customOrderId: null };
    if (provenCreatorIds.length > 1) return { creator: null, proven: true, conflict: true, customOrderId: null };
  }

  // Legacy/best-effort identity may still be useful for diagnostics/UI, but it is
  // intentionally NOT strong enough to establish Custom submission provenance.
  const candidates = await db.creatorAccount.findMany({ where: { agencyId, deletedAt: null, telegramUserId: senderTelegramUserId }, select: { id: true, telegramAccountId: true, telegramContact: true }, take: 20 });
  const matched = [];
  for (const creator of candidates) {
    const resolved = await resolveTelegramAccountId({ agencyId, creator, db });
    if (resolved && String(resolved) === String(accountId)) matched.push(creator);
  }
  return { creator: matched.length === 1 ? matched[0] : null, proven: false, conflict: matched.length > 1, customOrderId: null };
}

async function correlateOrder({ agencyId, accountId, creatorId, replyToMessageId, db }) {
  if (!creatorId) return null;
  if (replyToMessageId) {
    // A direct Reply is strong correlation only when the replied-to provider message is itself
    // a canonical CONFIRMED Telegram delivery.  Never reinterpret an unmatched Reply as the
    // generic single-active-order fallback and never use legacy CustomOrder message-id projections
    // as a second business fact authority.
    const intent = await db.telegramDeliveryIntent.findFirst({ where: { agencyId, accountId, creatorId, state: "CONFIRMED", remoteMessageId: replyToMessageId }, orderBy: { confirmedAt: "desc" } });
    return intent ? String(intent.customOrderId) : null;
  }
  // Non-Reply intake has an explicit product fallback: exactly one active CONTENT custom.
  const active = await db.customOrder.findMany({ where: { agencyId, creatorId, type: "CONTENT", status: "PENDING" }, select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 2 });
  return active.length === 1 ? String(active[0].id) : null;
}

async function updateFreshProjection({ agencyId, creatorId, orderId, messageId, observedAt, db }) {
  if (!creatorId || !orderId) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await db.customOrder.findFirst({ where: { id: orderId, agencyId, creatorId }, select: { id: true, telegramLastModelMessageId: true, telegramLastModelMessageAt: true, updatedAt: true } });
    if (!row) return;
    const previousAt = row.telegramLastModelMessageAt ? new Date(row.telegramLastModelMessageAt).getTime() : -1;
    const nextAt = observedAt.getTime(); const previousId = Number(row.telegramLastModelMessageId || 0);
    if (previousAt > nextAt || (previousAt === nextAt && previousId >= messageId)) return;
    const changed = await db.customOrder.updateMany({ where: { id: row.id, agencyId, updatedAt: row.updatedAt }, data: { telegramLastModelMessageId: messageId, telegramLastModelMessageAt: observedAt } });
    if (Number(changed?.count || 0) === 1) return;
  }
}



function boundedLimit(value, fallback = 50, max = 200) {
  return Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)));
}
function creatorScopeWhere(scope) {
  if (scope?.broad) return {};
  const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : [];
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}
async function requireInboundReviewView({ agencyId, member, db }) {
  if (!agencyId || !member?.id) throw fail("TELEGRAM_INBOUND_REVIEW_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "team.analytics.view", db })) throw fail("TELEGRAM_INBOUND_REVIEW_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
}
async function requireInboundReviewWrite({ agencyId, member, db }) {
  if (!agencyId || !member?.id) throw fail("TELEGRAM_INBOUND_REVIEW_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "content.review_customs", db })) throw fail("TELEGRAM_INBOUND_REVIEW_FORBIDDEN", "content.review_customs permission is required", 403);
}
function reviewResolution(value) {
  const mode = clean(value, 60).toUpperCase();
  if (!["RETRY_AFTER_REPAIR", "ASSIGN_TO_CONTENT_ORDER", "SKIP"].includes(mode)) {
    throw fail("TELEGRAM_INBOUND_REVIEW_RESOLUTION_INVALID", "resolution must be RETRY_AFTER_REPAIR, ASSIGN_TO_CONTENT_ORDER or SKIP");
  }
  return mode;
}
function reviewReason(value) {
  const reason = clean(value, 400);
  if (!reason) throw fail("TELEGRAM_INBOUND_REVIEW_REASON_REQUIRED", "A management resolution reason is required");
  return reason;
}
function reviewCreatorSummary(row) {
  return row ? { id: String(row.id), displayName: row.displayName || null, username: row.username || null, avatarUrl: row.avatarUrl || null } : null;
}
function reviewOrderSummary(row) {
  return row ? {
    customOrderId: String(row.id), creatorId: String(row.creatorId), scenario: row.scenario || "", type: String(row.type || "CONTENT"), status: String(row.status || "PENDING"),
    dueAt: row.dueAt ? new Date(row.dueAt).toISOString() : null, createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  } : null;
}
async function runInboundReviewTransaction(client, operation) {
  if (typeof client?.$transaction !== "function") {
    throw fail("TELEGRAM_INBOUND_REVIEW_TRANSACTION_REQUIRED", "Telegram inbound review resolution requires transactional storage", 500);
  }
  try {
    return await client.$transaction(operation, { isolationLevel: "Serializable" });
  } catch (error) {
    if (String(error?.code || "") === "P2034") {
      throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed concurrently; refresh the queue", 409);
    }
    throw error;
  }
}
async function loadReviewCandidateOrders({ agencyId, creatorIds, db }) {
  const ids = Array.from(new Set((creatorIds || []).map(String).filter(Boolean)));
  const byCreator = new Map();
  // REVIEW_REQUIRED is an exception queue, so correctness beats one globally-truncated query.
  // Fetch a bounded top-20 per creator with bounded concurrency; one creator with hundreds of
  // pending Customs must never starve another creator's only valid human-resolution target.
  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = ids.slice(offset, offset + 8);
    const groups = await Promise.all(batch.map(async (creatorId) => {
      const rows = await db.customOrder.findMany({
        where: { agencyId, creatorId, type: "CONTENT", status: "PENDING" },
        select: { id: true, creatorId: true, scenario: true, type: true, status: true, dueAt: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20,
      });
      return [creatorId, (rows || []).map(reviewOrderSummary)];
    }));
    for (const [creatorId, rows] of groups) byCreator.set(creatorId, rows);
  }
  return byCreator;
}
async function convergeLinkedSubmissionState({ row, now = new Date(), db }) {
  if (!row?.submissionId || String(row.projectionState || "") === "APPLIED") return row;
  await db.telegramInboundEvent.updateMany({
    where: { id: row.id, agencyId: row.agencyId, submissionId: { not: null }, projectionState: { not: "APPLIED" } },
    data: { projectionState: "APPLIED", projectionReason: "SUBMISSION_ALREADY_LINKED", projectedAt: now },
  });
  return db.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId: row.agencyId } }) || row;
}

const PROJECTION_RETRYABLE_STATES = ["PENDING", "FAILED_RETRYABLE"];
const PROJECTION_REVIEW_CODES = new Set([
  "CUSTOM_SUBMISSION_SOURCE_ACCOUNT_CONFLICT",
  "CUSTOM_SUBMISSION_SOURCE_USER_CONFLICT",
  "CUSTOM_SUBMISSION_SOURCE_FROZEN",
  "CUSTOM_SUBMISSION_INBOUND_EVENT_REUSED",
  "CUSTOM_SUBMISSION_ORDER_NOT_FOUND",
]);

async function setProjectionState({ row, state, reason = null, projectedAt = null, db }) {
  if (!row?.id) return row;
  const attempts = Math.max(0, Number(row.projectionAttempts || 0)) + 1;
  // Projection results are monotonic. Multiple backend workers may race the same durable
  // provider observation, but a late retry/transient result must never downgrade a terminal
  // APPLIED/SKIPPED/REVIEW_REQUIRED decision back into PENDING/FAILED_RETRYABLE.
  await db.telegramInboundEvent.updateMany({
    where: { id: row.id, agencyId: row.agencyId, projectionState: { in: PROJECTION_RETRYABLE_STATES } },
    data: { projectionState: state, projectionReason: clean(reason, 500) || null, projectionAttempts: attempts, projectedAt },
  });
  return db.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId: row.agencyId } }) || row;
}

function durableProjectionResult(row, { state, submission = null, reason = null } = {}) {
  const durableState = clean(row?.projectionState, 40) || state || "PENDING";
  const durableReason = clean(row?.projectionReason, 500) || null;
  const durableSubmissionId = clean(row?.submissionId, 180);
  return {
    ok: true,
    state: durableState,
    submission: durableSubmissionId ? { id: durableSubmissionId } : (durableState === "APPLIED" ? submission : null),
    reason: durableState === "APPLIED" ? null : (durableReason || reason || null),
  };
}

async function projectTelegramInboundEvent({ eventId: inputEventId, actorUserId = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  let row = await client.telegramInboundEvent.findFirst({ where: { id: clean(inputEventId, 180) } });
  if (!row) return { ok: false, state: "MISSING", submission: null, reason: "EVENT_NOT_FOUND" };
  if (row.submissionId) {
    row = await convergeLinkedSubmissionState({ row, now, db: client });
    return durableProjectionResult(row, { state: "APPLIED", submission: { id: String(row.submissionId) } });
  }

  try {
    // Projection owns correlation retries after the provider observation has already been accepted.
    // Desktop is never the scheduler for this derived business state.
    const resolution = await resolveCreator({
      agencyId: row.agencyId, accountId: row.accountId, senderTelegramUserId: row.senderTelegramUserId,
      replyToMessageId: row.replyToMessageId, db: client,
    });
    if (resolution.proven && resolution.conflict) {
      row = await setProjectionState({ row, state: "REVIEW_REQUIRED", reason: "PROVEN_CREATOR_CONFLICT", projectedAt: now, db: client });
      return durableProjectionResult(row, { state: "REVIEW_REQUIRED", reason: "PROVEN_CREATOR_CONFLICT" });
    }
    if (!resolution.proven || !resolution.creator?.id) {
      row = await setProjectionState({ row, state: "PENDING", reason: "CREATOR_UNRESOLVED", projectedAt: null, db: client });
      return durableProjectionResult(row, { state: "PENDING", reason: "CREATOR_UNRESOLVED" });
    }

    const creatorId = String(resolution.creator.id);
    const customOrderId = resolution.customOrderId || await correlateOrder({
      agencyId: row.agencyId, accountId: row.accountId, creatorId, replyToMessageId: row.replyToMessageId, db: client,
    });
    if (row.submissionId && String(row.creatorId || "") !== creatorId) {
      row = await setProjectionState({ row, state: "REVIEW_REQUIRED", reason: "PROVENANCE_CONFLICT", projectedAt: now, db: client });
      return durableProjectionResult(row, { state: "REVIEW_REQUIRED", reason: "PROVENANCE_CONFLICT" });
    }
    if (!row.submissionId && (String(row.creatorId || "") !== creatorId || String(row.customOrderId || "") !== String(customOrderId || ""))) {
      await client.telegramInboundEvent.updateMany({
        where: { id: row.id, agencyId: row.agencyId, submissionId: null },
        data: { creatorId, customOrderId: customOrderId || null },
      });
      row = await client.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId: row.agencyId } }) || row;
    }

    const effectiveCreatorId = String(row.creatorId || creatorId);
    const effectiveOrderId = row.customOrderId || customOrderId || null;
    await updateFreshProjection({ agencyId: row.agencyId, creatorId: effectiveCreatorId, orderId: effectiveOrderId, messageId: Number(row.messageId), observedAt: new Date(row.sentAt), db: client });
    if (row.hasMedia !== true) {
      row = await setProjectionState({ row, state: "SKIPPED", reason: "NO_MEDIA", projectedAt: now, db: client });
      return durableProjectionResult(row, { state: "SKIPPED", reason: "NO_MEDIA" });
    }

    let projected;
    try {
      projected = await createCustomContentSubmissionFromInboundEvent({ eventId: row.id, actorUserId, now, db: client });
    } catch (error) {
      const code = clean(error?.code || error?.message, 180) || "SUBMISSION_PROJECTION_FAILED";
      if (code === "CUSTOM_SUBMISSION_ORDER_TYPE_INVALID") {
        row = await setProjectionState({ row, state: "SKIPPED", reason: "NON_CONTENT_ORDER", projectedAt: now, db: client });
        return durableProjectionResult(row, { state: "SKIPPED", reason: "NON_CONTENT_ORDER" });
      }
      if (PROJECTION_REVIEW_CODES.has(code)) {
        row = await setProjectionState({ row, state: "REVIEW_REQUIRED", reason: code, projectedAt: now, db: client });
        return durableProjectionResult(row, { state: "REVIEW_REQUIRED", reason: code });
      }
      row = await setProjectionState({ row, state: "FAILED_RETRYABLE", reason: code, projectedAt: null, db: client });
      return durableProjectionResult(row, { state: "FAILED_RETRYABLE", reason: code });
    }

    const submissionId = projected?.submission?.id || null;
    const state = submissionId ? "APPLIED" : (projected?.reason === "CREATOR_UNRESOLVED" ? "PENDING" : "SKIPPED");
    const reason = submissionId ? null : (projected?.reason || "NO_SUBMISSION_REQUIRED");
    row = await setProjectionState({ row, state, reason, projectedAt: state === "PENDING" ? null : now, db: client });
    return durableProjectionResult(row, { state, submission: projected?.submission || null, reason });
  } catch (error) {
    const code = clean(error?.code || error?.message, 180) || "INBOUND_PROJECTION_FAILED";
    const durable = await setProjectionState({ row, state: "FAILED_RETRYABLE", reason: code, projectedAt: null, db: client }).catch(() => null);
    return durable ? durableProjectionResult(durable, { state: "FAILED_RETRYABLE", reason: code }) : { ok: true, state: "FAILED_RETRYABLE", submission: null, reason: code };
  }
}


async function listTelegramInboundReviewQueue({ agencyId, member, limit = 50, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  await requireInboundReviewView({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = boundedLimit(limit);
  const where = { agencyId, projectionState: "REVIEW_REQUIRED", ...creatorScopeWhere(scope) };
  const [rows, count, canResolve] = await Promise.all([
    client.telegramInboundEvent.findMany({ where, orderBy: [{ projectedAt: "asc" }, { observedAt: "asc" }, { id: "asc" }], take }),
    client.telegramInboundEvent.count ? client.telegramInboundEvent.count({ where }) : Promise.resolve(null),
    canUsePermission({ member, key: "content.review_customs", db: client }),
  ]);

  const creatorIds = Array.from(new Set((rows || []).map((row) => clean(row.creatorId, 180)).filter(Boolean)));
  const orderIds = Array.from(new Set((rows || []).map((row) => clean(row.customOrderId, 180)).filter(Boolean)));
  const creators = creatorIds.length && client.creatorAccount?.findMany
    ? await client.creatorAccount.findMany({ where: { agencyId, deletedAt: null, id: { in: creatorIds } }, select: { id: true, displayName: true, username: true, avatarUrl: true }, take: Math.max(creatorIds.length, 1) })
    : [];
  const creatorById = new Map((creators || []).map((row) => [String(row.id), row]));
  const currentOrders = orderIds.length && client.customOrder?.findMany
    ? await client.customOrder.findMany({ where: { agencyId, id: { in: orderIds } }, select: { id: true, creatorId: true, scenario: true, type: true, status: true, dueAt: true, createdAt: true }, take: Math.max(orderIds.length, 1) })
    : [];
  const currentOrderById = new Map((currentOrders || []).map((row) => [String(row.id), row]));
  const candidatesByCreator = creatorIds.length && client.customOrder?.findMany
    ? await loadReviewCandidateOrders({ agencyId, creatorIds, db: client })
    : new Map();

  const items = (rows || []).map((row) => ({
    eventId: String(row.id), accountId: String(row.accountId), senderTelegramUserId: String(row.senderTelegramUserId),
    messageId: String(row.messageId), replyToMessageId: row.replyToMessageId == null ? null : String(row.replyToMessageId), groupedId: row.groupedId || null,
    hasMedia: row.hasMedia === true, text: row.text || null, sentAt: new Date(row.sentAt).toISOString(), observedAt: new Date(row.observedAt).toISOString(),
    projectionReason: row.projectionReason || null, projectionAttempts: Number(row.projectionAttempts || 0), projectedAt: row.projectedAt ? new Date(row.projectedAt).toISOString() : null,
    creatorId: row.creatorId || null, creator: row.creatorId ? reviewCreatorSummary(creatorById.get(String(row.creatorId))) : null,
    customOrderId: row.customOrderId || null, customOrder: row.customOrderId ? reviewOrderSummary(currentOrderById.get(String(row.customOrderId))) : null,
    candidateOrders: row.creatorId ? (candidatesByCreator.get(String(row.creatorId)) || []) : [],
  }));
  return { ok: true, items, count: count == null ? items.length : Number(count || 0), canResolve: canResolve === true, serverNow: now.toISOString() };
}

async function searchTelegramInboundReviewCandidates({ agencyId, member, eventId: inputEventId, query = "", limit = 30, db = null } = {}) {
  const client = db || require("../prisma");
  await requireInboundReviewView({ agencyId, member, db: client });
  const eventId = clean(inputEventId, 180);
  if (!eventId) throw fail("TELEGRAM_INBOUND_REVIEW_EVENT_REQUIRED", "eventId is required");
  const row = await client.telegramInboundEvent.findFirst({ where: { id: eventId, agencyId } });
  if (!row) throw fail("TELEGRAM_INBOUND_REVIEW_NOT_FOUND", "Telegram inbound review event was not found", 404);
  if (row.submissionId) return { ok: true, eventId, creatorId: row.creatorId || null, items: [], state: "APPLIED" };
  if (String(row.projectionState) !== "REVIEW_REQUIRED") throw fail("TELEGRAM_INBOUND_REVIEW_STATE_CONFLICT", "Telegram inbound event is no longer awaiting management review", 409);

  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  if (row.creatorId) await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  else if (!scope?.broad) throw fail("TELEGRAM_INBOUND_REVIEW_SCOPE_UNRESOLVED", "Unresolved creator provenance can only be reviewed by a member with broad creator scope", 403);

  // Candidate discovery is read-only and never establishes provenance. Re-evaluate the current
  // provider proof so a stale row.creatorId cannot make the UI offer an order that ASSIGN would
  // correctly reject inside its Serializable transaction.
  const proven = await resolveCreator({
    agencyId, accountId: row.accountId, senderTelegramUserId: row.senderTelegramUserId,
    replyToMessageId: row.replyToMessageId, db: client,
  });
  if (!proven.proven || proven.conflict || !proven.creator?.id) {
    return { ok: true, eventId, creatorId: null, items: [], state: "REVIEW_REQUIRED", proofState: proven.conflict ? "CONFLICT" : "UNRESOLVED" };
  }
  const creatorId = String(proven.creator.id);
  if (row.creatorId && String(row.creatorId) !== creatorId) {
    return { ok: true, eventId, creatorId, items: [], state: "REVIEW_REQUIRED", proofState: "ROW_CREATOR_CONFLICT" };
  }
  await requireCreatorAccess({ agencyId, member, creatorId, db: client });

  const rawQuery = clean(query, 200);
  const normalizedQuery = rawQuery.replace(/^#+/, "").trim();
  const take = Math.max(1, Math.min(50, Math.floor(Number(limit) || 30)));
  const where = { agencyId, creatorId, type: "CONTENT", status: "PENDING" };
  if (normalizedQuery) {
    where.OR = [
      { id: normalizedQuery },
      { scenario: { contains: normalizedQuery, mode: "insensitive" } },
    ];
  }
  const rows = await client.customOrder.findMany({
    where,
    select: { id: true, creatorId: true, scenario: true, type: true, status: true, dueAt: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take,
  });
  return { ok: true, eventId, creatorId, items: (rows || []).map(reviewOrderSummary), state: "REVIEW_REQUIRED", proofState: "PROVEN" };
}

async function resolveTelegramInboundReview({ agencyId, member, eventId: inputEventId, resolution, reason, customOrderId = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  await requireInboundReviewWrite({ agencyId, member, db: client });
  const eventId = clean(inputEventId, 180);
  if (!eventId) throw fail("TELEGRAM_INBOUND_REVIEW_EVENT_REQUIRED", "eventId is required");
  const mode = reviewResolution(resolution);
  const justification = reviewReason(reason);
  let row = await client.telegramInboundEvent.findFirst({ where: { id: eventId, agencyId } });
  if (!row) throw fail("TELEGRAM_INBOUND_REVIEW_NOT_FOUND", "Telegram inbound review event was not found", 404);
  if (row.submissionId) {
    row = await convergeLinkedSubmissionState({ row, now, db: client });
    return { ok: true, idempotent: true, state: "APPLIED", eventId: row.id, submissionId: row.submissionId || null, projectionReason: row.projectionReason || null };
  }
  if (String(row.projectionState) !== "REVIEW_REQUIRED") throw fail("TELEGRAM_INBOUND_REVIEW_STATE_CONFLICT", "Telegram inbound event is no longer awaiting management review", 409);

  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  if (row.creatorId) await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  else if (!scope?.broad) throw fail("TELEGRAM_INBOUND_REVIEW_SCOPE_UNRESOLVED", "Unresolved creator provenance can only be reviewed by a member with broad creator scope", 403);

  const commitHumanReviewState = async ({ data, action }) => {
    const previousReason = row.projectionReason || null;
    const commit = async (tx) => {
      const freshStart = await tx.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId } });
      if (!freshStart) throw fail("TELEGRAM_INBOUND_REVIEW_NOT_FOUND", "Telegram inbound review event was not found", 404);
      if (freshStart.submissionId) {
        return { linked: true, row: await convergeLinkedSubmissionState({ row: freshStart, now, db: tx }) };
      }
      if (String(freshStart.projectionState) !== "REVIEW_REQUIRED") throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed concurrently; refresh the queue", 409);
      const revision = freshStart.updatedAt ? new Date(freshStart.updatedAt) : null;
      // Human review is authoritative only while no stronger submission fact exists. State change
      // and mandatory reason/audit are one transaction: a crash can commit neither without the other.
      const where = { id: freshStart.id, agencyId, projectionState: "REVIEW_REQUIRED", submissionId: null, ...(revision && Number.isFinite(revision.getTime()) ? { updatedAt: revision } : {}) };
      const changed = await tx.telegramInboundEvent.updateMany({ where, data });
      if (Number(changed?.count || 0) !== 1) {
        const raced = await tx.telegramInboundEvent.findFirst({ where: { id: freshStart.id, agencyId } });
        if (raced?.submissionId) return { linked: true, row: await convergeLinkedSubmissionState({ row: raced, now, db: tx }) };
        throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed concurrently; refresh the queue", 409);
      }
      const fresh = await tx.telegramInboundEvent.findFirst({ where: { id: freshStart.id, agencyId } });
      await audit({
        agencyId, actorUserId: member.userId || null, action, targetType: "TelegramInboundEvent", targetId: eventId,
        metadata: { creatorId: fresh?.creatorId || null, customOrderId: fresh?.customOrderId || null, previousReason, reason: justification }, db: tx, required: true,
      });
      return { linked: false, row: fresh };
    };
    return runInboundReviewTransaction(client, commit);
  };

  if (mode === "SKIP") {
    const changed = await commitHumanReviewState({
      data: { projectionState: "SKIPPED", projectionReason: `MANUAL_SKIP:${justification}`.slice(0, 500), projectedAt: now },
      action: "custom_order.telegram_inbound_review_skip",
    });
    row = changed.row;
    if (changed.linked) return { ok: true, idempotent: true, state: "APPLIED", eventId, submissionId: row?.submissionId || null, projectionReason: row?.projectionReason || null };
    return { ok: true, idempotent: false, state: "SKIPPED", eventId, submissionId: null, projectionReason: row?.projectionReason || null };
  }

  if (mode === "RETRY_AFTER_REPAIR") {
    const changed = await commitHumanReviewState({
      data: { projectionState: "PENDING", projectionReason: null, projectedAt: null },
      action: "custom_order.telegram_inbound_review_retry",
    });
    row = changed.row;
    if (changed.linked) return { ok: true, idempotent: true, state: "APPLIED", eventId, submissionId: row?.submissionId || null, projectionReason: row?.projectionReason || null };
    // Projection is backend-owned after the audited transition. If the process dies here, the
    // durable PENDING row is picked up by retryPendingInboundProjections/job-scheduler.
    const result = await projectTelegramInboundEvent({ eventId, actorUserId: member.userId || null, now, db: client });
    return { ok: true, idempotent: false, state: result.state, eventId, submissionId: result.submission?.id || null, projectionReason: result.reason || null };
  }

  const targetId = clean(customOrderId, 180);
  if (!targetId) throw fail("TELEGRAM_INBOUND_REVIEW_ORDER_REQUIRED", "customOrderId is required for ASSIGN_TO_CONTENT_ORDER");

  const assign = async (tx) => {
    const fresh = await tx.telegramInboundEvent.findFirst({ where: { id: eventId, agencyId } });
    if (!fresh || String(fresh.projectionState) !== "REVIEW_REQUIRED" || fresh.submissionId) throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed concurrently; refresh the queue", 409);
    const target = await tx.customOrder.findFirst({ where: { id: targetId, agencyId } });
    if (!target) throw fail("TELEGRAM_INBOUND_REVIEW_ORDER_NOT_FOUND", "Target CustomOrder was not found", 404);
    if (String(target.type || "") !== "CONTENT" || String(target.status || "") !== "PENDING") throw fail("TELEGRAM_INBOUND_REVIEW_ORDER_INVALID", "Target must be a pending CONTENT CustomOrder", 409);
    await requireCreatorAccess({ agencyId, member, creatorId: target.creatorId, db: tx });
    const proven = await resolveCreator({ agencyId, accountId: fresh.accountId, senderTelegramUserId: fresh.senderTelegramUserId, replyToMessageId: fresh.replyToMessageId, db: tx });
    if (!proven.proven || proven.conflict || !proven.creator?.id || String(proven.creator.id) !== String(target.creatorId)) {
      throw fail("TELEGRAM_INBOUND_REVIEW_CREATOR_UNPROVEN", "Target order creator is not uniquely proven by the Telegram provider observation; repair identity first", 409);
    }
    if (fresh.creatorId && String(fresh.creatorId) !== String(target.creatorId)) throw fail("TELEGRAM_INBOUND_REVIEW_CREATOR_CONFLICT", "Review event is already bound to another proven creator", 409);

    const revision = fresh.updatedAt ? new Date(fresh.updatedAt) : null;
    const prepared = await tx.telegramInboundEvent.updateMany({
      where: { id: eventId, agencyId, projectionState: "REVIEW_REQUIRED", submissionId: null, ...(revision && Number.isFinite(revision.getTime()) ? { updatedAt: revision } : {}) },
      data: { creatorId: String(target.creatorId), customOrderId: null, projectionReason: "MANUAL_ASSIGN_PREPARED", projectedAt: null },
    });
    if (Number(prepared?.count || 0) !== 1) throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed while preparing assignment", 409);
    const projected = await createCustomContentSubmissionFromInboundEvent({ eventId, actorUserId: member.userId || null, now, db: tx });
    if (!projected?.submission?.id) throw fail("TELEGRAM_INBOUND_REVIEW_SUBMISSION_REQUIRED", "The inbound event could not be materialized into a Custom submission", 409);
    const assigned = await assignCustomContentSubmission({ agencyId, member, submissionId: projected.submission.id, customOrderId: targetId, now, db: tx });
    const finalSubmissionId = assigned?.submission?.id || projected.submission.id;
    const completed = await tx.telegramInboundEvent.updateMany({
      where: { id: eventId, agencyId, projectionState: "REVIEW_REQUIRED", submissionId: finalSubmissionId },
      data: { creatorId: String(target.creatorId), customOrderId: targetId, projectionState: "APPLIED", projectionReason: `MANUAL_ASSIGN:${justification}`.slice(0, 500), projectedAt: now },
    });
    if (Number(completed?.count || 0) !== 1) throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed while finalizing assignment", 409);
    await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.telegram_inbound_review_assign", targetType: "TelegramInboundEvent", targetId: eventId, metadata: { creatorId: String(target.creatorId), customOrderId: targetId, submissionId: finalSubmissionId, previousReason: fresh.projectionReason || null, reason: justification }, db: tx, required: true });
    return { submissionId: finalSubmissionId };
  };
  const assigned = await runInboundReviewTransaction(client, assign);
  return { ok: true, idempotent: false, state: "APPLIED", eventId, submissionId: assigned.submissionId, projectionReason: `MANUAL_ASSIGN:${justification}`.slice(0, 500) };
}

async function retryPendingInboundProjections({ agencyId, accountId = null, actorUserId = null, now = new Date(), limit = 50, db = null } = {}) {
  const client = db || require("../prisma");
  const take = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const scope = { ...(agencyId ? { agencyId } : {}), ...(accountId ? { accountId: clean(accountId, 180) } : {}) };

  // submissionId is a stronger durable fact than any stale projection enum. Converge these rows
  // backend-side even if no manager opens the queue and no ordinary retryable projector runs.
  const linkedRows = await client.telegramInboundEvent.findMany({
    where: { ...scope, submissionId: { not: null }, projectionState: { not: "APPLIED" } },
    orderBy: [{ observedAt: "asc" }, { id: "asc" }], take,
  });
  let applied = 0; let skipped = 0; let pending = 0; let reviewRequired = 0;
  for (const linked of linkedRows) {
    const fresh = await convergeLinkedSubmissionState({ row: linked, now, db: client });
    if (String(fresh?.projectionState) === "APPLIED") applied += 1;
  }

  const remaining = Math.max(0, take - linkedRows.length);
  const rows = remaining > 0 ? await client.telegramInboundEvent.findMany({
    where: {
      ...scope,
      submissionId: null,
      OR: [
        { projectionState: "FAILED_RETRYABLE" },
        // PENDING + no reason is the crash window between durable ACK and the first projector.
        // CREATOR_UNRESOLVED is event-driven by a later provider receipt and must not hot-loop.
        { projectionState: "PENDING", projectionReason: null },
      ],
    },
    orderBy: [{ observedAt: "asc" }, { id: "asc" }], take: remaining,
  }) : [];
  for (const row of rows) {
    const result = await projectTelegramInboundEvent({ eventId: row.id, actorUserId, now, db: client });
    if (result.state === "APPLIED") applied += 1;
    else if (result.state === "SKIPPED") skipped += 1;
    else if (result.state === "REVIEW_REQUIRED") reviewRequired += 1;
    else pending += 1;
  }
  return { ok: true, scanned: linkedRows.length + rows.length, convergedLinked: linkedRows.length, applied, skipped, pending, reviewRequired };
}

async function reconcilePendingInboundForConfirmedDelivery({ agencyId, accountId, senderTelegramUserId = null, replyToMessageId = null, actorUserId = null, now = new Date(), limit = 200, db = null } = {}) {
  const client = db || require("../prisma");
  const normalizedAccountId = clean(accountId, 180);
  const sender = clean(senderTelegramUserId, 40);
  const replyId = positiveInt(replyToMessageId, "replyToMessageId", true);
  if (!agencyId || !normalizedAccountId || (!/^\d{1,20}$/.test(sender) && !replyId)) return { ok: true, reconciled: 0, submissions: 0 };
  const candidateOr = [];
  if (/^\d{1,20}$/.test(sender)) candidateOr.push({ senderTelegramUserId: sender });
  if (replyId) candidateOr.push({ replyToMessageId: replyId });
  const take = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
  const rows = await client.telegramInboundEvent.findMany({
    where: { agencyId, accountId: normalizedAccountId, submissionId: null, ...(candidateOr.length === 1 ? candidateOr[0] : { OR: candidateOr }) },
    orderBy: [{ sentAt: "asc" }, { messageId: "asc" }], take,
  });
  let reconciled = 0; let submissions = 0; const creatorIds = new Set();
  for (const row of rows) {
    const result = await projectTelegramInboundEvent({ eventId: row.id, actorUserId, now, db: client });
    const fresh = await client.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId } });
    if (fresh?.creatorId) creatorIds.add(String(fresh.creatorId));
    if (result?.submission) submissions += 1;
    if (!["PENDING", "FAILED_RETRYABLE"].includes(String(result?.state))) reconciled += 1;
  }
  if (reconciled > 0) await audit({ agencyId, actorUserId, action: "custom_order.telegram_inbound_reconcile_after_delivery_receipt", targetType: "TelegramDeliveryReceipt", targetId: `${normalizedAccountId}:${sender || replyId || "unknown"}`, metadata: { creatorIds: Array.from(creatorIds), reconciled, submissions, replyToMessageId: replyId }, db: client });
  return { ok: true, creatorId: creatorIds.size === 1 ? Array.from(creatorIds)[0] : null, reconciled, submissions };
}

async function reconcilePendingInboundForRecipient({ agencyId, accountId, senderTelegramUserId, actorUserId = null, now = new Date(), limit = 200, db = null } = {}) {
  return reconcilePendingInboundForConfirmedDelivery({ agencyId, accountId, senderTelegramUserId, actorUserId, now, limit, db });
}

async function ingestTelegramInboundEvent({ agencyId, member, accountId, deviceId, claimToken, senderTelegramUserId, messageId, replyToMessageId = null, groupedId = null, hasMedia = false, text = null, sentAt: sentAtInput = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const normalizedAccountId = clean(accountId, 180); const sender = clean(senderTelegramUserId, 40);
  if (!normalizedAccountId || !/^\d{1,20}$/.test(sender)) throw fail("TELEGRAM_INBOUND_SCOPE_INVALID", "Telegram account and sender identity are required");
  const inboundMessageId = positiveInt(messageId, "messageId"); const replyId = positiveInt(replyToMessageId, "replyToMessageId", true); const observedAt = sentAt(sentAtInput, now);
  await assertTelegramInboundRuntimeLease({ agencyId, member, accountId: normalizedAccountId, deviceId, claimToken, now, db: client });

  // Correlation can seed the row, but the acceptance boundary is the durable provider event itself.
  // Any business projection after create/find is backend-owned and can never make Desktop retain the observation.
  let creatorId = null; let customOrderId = null;
  try {
    const resolution = await resolveCreator({ agencyId, accountId: normalizedAccountId, senderTelegramUserId: sender, replyToMessageId: replyId, db: client });
    creatorId = resolution.proven && resolution.creator ? String(resolution.creator.id) : null;
    customOrderId = creatorId ? (resolution.customOrderId || await correlateOrder({ agencyId, accountId: normalizedAccountId, creatorId, replyToMessageId: replyId, db: client })) : null;
  } catch { creatorId = null; customOrderId = null; }

  const id = eventId({ agencyId, accountId: normalizedAccountId, senderTelegramUserId: sender, messageId: inboundMessageId });
  let row = await client.telegramInboundEvent.findFirst({ where: { id } });
  if (!row) {
    try {
      row = await client.telegramInboundEvent.create({ data: {
        id, agencyId, accountId: normalizedAccountId, creatorId, customOrderId, senderTelegramUserId: sender, messageId: inboundMessageId,
        replyToMessageId: replyId, groupedId: clean(groupedId, 180) || null, hasMedia: hasMedia === true, text: clean(text, 4000) || null,
        sentAt: observedAt, observedAt: now, projectionState: "PENDING", projectionReason: null, projectedAt: null,
      } });
    } catch (error) {
      if (String(error?.code || "") !== "P2002") throw error;
      row = await client.telegramInboundEvent.findFirst({ where: { id } });
    }
  }
  if (!row) throw fail("TELEGRAM_INBOUND_PERSIST_FAILED", "Telegram inbound event could not be persisted", 500);
  const deduped = Boolean(row.createdAt && new Date(row.createdAt).getTime() < new Date(now).getTime());

  // From this point the provider observation is durably accepted. Do not keep the Desktop
  // outbox hostage to business projection latency/failure. The in-process fast path is only an
  // accelerator: PENDING/FAILED_RETRYABLE rows are durably retried by backend-owned work.
  const accepted = {
    id: row.id, creatorId: row.creatorId || null, customOrderId: row.customOrderId || null,
    messageId: String(row.messageId), replyToMessageId: row.replyToMessageId == null ? null : String(row.replyToMessageId),
    groupedId: row.groupedId || null, hasMedia: row.hasMedia === true, sentAt: new Date(row.sentAt).toISOString(),
    submissionId: row.submissionId || null, projectionState: row.projectionState || "PENDING", projectionReason: row.projectionReason || null,
  };
  setImmediate(() => {
    void projectTelegramInboundEvent({ eventId: row.id, actorUserId: member?.userId || null, now, db: client }).catch(() => undefined);
    void audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_inbound_ingest", targetType: "TelegramInboundEvent", targetId: row.id, metadata: { accountId: normalizedAccountId, creatorId: row.creatorId || null, customOrderId: row.customOrderId || null, messageId: inboundMessageId, replyToMessageId: replyId, hasMedia: row.hasMedia === true, submissionId: row.submissionId || null, projectionState: row.projectionState || "PENDING", projectionReason: row.projectionReason || null }, db: client }).catch(() => undefined);
  });
  return { ok: true, accepted: true, deduped, event: accepted };
}

module.exports = {
  ingestTelegramInboundEvent,
  reconcilePendingInboundForRecipient,
  reconcilePendingInboundForConfirmedDelivery,
  retryPendingInboundProjections,
  projectTelegramInboundEvent,
  listTelegramInboundReviewQueue,
  searchTelegramInboundReviewCandidates,
  resolveTelegramInboundReview,
  updateFreshProjection,
};
