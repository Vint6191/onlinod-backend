"use strict";

const { audit } = require("./audit-service");
const { assertTelegramInboundRuntimeLease } = require("./telegram-execution-runtime");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { resolveTelegramAccountId } = require("./custom-order-reminders");
const { createCustomContentSubmissionFromInboundEvent, assignCustomContentSubmission } = require("./custom-content-submissions-service");
const { providerMessageEventId, resolveTelegramCustomThread, targetAllowedByThreadContext } = require("./custom-telegram-thread-authority-service");

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 4000) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }
function positiveInt(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw fail("TELEGRAM_INBOUND_MESSAGE_ID_INVALID", `${field} must be a positive Telegram message id`); return n;
}
function sentAt(value, now) { const d = new Date(String(value || "")); if (!Number.isFinite(d.getTime())) return new Date(now); return d; }
function eventId(input) { return providerMessageEventId(input); }

async function resolveThreadContext({ agencyId, accountId, senderTelegramUserId, replyToMessageId = null, eventSentAt = null, db }) {
  return resolveTelegramCustomThread({ agencyId, accountId, senderTelegramUserId, replyToMessageId, eventSentAt, db });
}

function threadResolutionProjection(context) {
  const type = String(context?.type || "NO_ACTIVE_THREAD");
  if (type === "DIRECT_REPLY" || type === "UNIQUE_ACTIVE_THREAD") {
    return {
      creatorId: context.thread?.creatorId ? String(context.thread.creatorId) : null,
      customOrderId: context.thread?.customOrderId ? String(context.thread.customOrderId) : null,
      threadAnchorIntentId: context.thread?.anchorIntentId ? String(context.thread.anchorIntentId) : null,
      threadResolutionType: type,
      conflict: false,
    };
  }
  return { creatorId: null, customOrderId: null, threadAnchorIntentId: null, threadResolutionType: type, conflict: Boolean(context?.conflict) };
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
async function authorizeTelegramInboundException({ agencyId, member, row, write = false, db }) {
  if (write) await requireInboundReviewWrite({ agencyId, member, db });
  else await requireInboundReviewView({ agencyId, member, db });
  const scope = await allowedCreatorScope({ agencyId, member, db });
  const context = await resolveThreadContext({
    agencyId, accountId: row.accountId, senderTelegramUserId: row.senderTelegramUserId, replyToMessageId: row.replyToMessageId, eventSentAt: row.sentAt, db,
  });
  const creatorIds = Array.from(new Set((context.creatorIds || []).map(String).filter(Boolean)));
  if (scope?.broad) return { scope, context, creatorIds };
  const allowed = new Set((scope?.creatorIds || []).map(String));
  if (!creatorIds.length || creatorIds.some((id) => !allowed.has(id))) {
    throw fail("TELEGRAM_INBOUND_REVIEW_SCOPE_UNRESOLVED", "Current Telegram thread context is outside this member's creator scope", 403);
  }
  return { scope, context, creatorIds };
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
    const context = await resolveThreadContext({
      agencyId: row.agencyId,
      accountId: row.accountId,
      senderTelegramUserId: row.senderTelegramUserId,
      replyToMessageId: row.replyToMessageId,
      eventSentAt: row.sentAt,
      db: client,
    });
    const resolved = threadResolutionProjection(context);
    const reviewReasonByType = {
      AMBIGUOUS_ACTIVE_THREADS: "ACTIVE_THREAD_AMBIGUOUS",
      DIRECT_REPLY_CONFLICT: "DIRECT_REPLY_IDENTITY_CONFLICT",
      DIRECT_REPLY_RECIPIENT_CONFLICT: "DIRECT_REPLY_RECIPIENT_CONFLICT",
      DIRECT_REPLY_UNRESOLVED: "DIRECT_REPLY_UNRESOLVED",
      NO_ACTIVE_THREAD: "NO_ACTIVE_THREAD",
    };

    if (!resolved.creatorId || !resolved.customOrderId) {
      await client.telegramInboundEvent.updateMany({
        where: { id: row.id, agencyId: row.agencyId, submissionId: null },
        data: {
          creatorId: null,
          customOrderId: null,
          threadResolutionType: resolved.threadResolutionType,
          threadAnchorIntentId: null,
        },
      });
      row = await client.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId: row.agencyId } }) || row;
      if (row.hasMedia !== true) {
        row = await setProjectionState({ row, state: "SKIPPED", reason: "NO_MEDIA", projectedAt: now, db: client });
        return durableProjectionResult(row, { state: "SKIPPED", reason: "NO_MEDIA" });
      }
      const reason = reviewReasonByType[resolved.threadResolutionType] || "THREAD_UNRESOLVED";
      const repairable = ["NO_ACTIVE_THREAD", "DIRECT_REPLY_UNRESOLVED"].includes(String(resolved.threadResolutionType || ""));
      if (repairable) {
        // Absence of a thread is not a human adjudication yet: a later provider-confirmed TASK
        // or late direct-reply receipt can establish the missing proof. Keep it durable and
        // event-driven (the normal retry sweep deliberately does not hot-loop reasoned PENDING).
        row = await setProjectionState({ row, state: "PENDING", reason: "CREATOR_UNRESOLVED", projectedAt: null, db: client });
        return durableProjectionResult(row, { state: "PENDING", reason: "CREATOR_UNRESOLVED" });
      }
      row = await setProjectionState({ row, state: "REVIEW_REQUIRED", reason, projectedAt: now, db: client });
      return durableProjectionResult(row, { state: "REVIEW_REQUIRED", reason });
    }

    if (!row.submissionId && (
      String(row.creatorId || "") !== resolved.creatorId
      || String(row.customOrderId || "") !== resolved.customOrderId
      || String(row.threadResolutionType || "") !== resolved.threadResolutionType
      || String(row.threadAnchorIntentId || "") !== String(resolved.threadAnchorIntentId || "")
    )) {
      await client.telegramInboundEvent.updateMany({
        where: { id: row.id, agencyId: row.agencyId, submissionId: null },
        data: {
          creatorId: resolved.creatorId,
          customOrderId: resolved.customOrderId,
          threadResolutionType: resolved.threadResolutionType,
          threadAnchorIntentId: resolved.threadAnchorIntentId || null,
          resolutionAuthority: resolved.threadResolutionType === "DIRECT_REPLY" ? "PROVIDER_DIRECT_REPLY" : "PROVIDER_ACTIVE_THREAD",
        },
      });
      row = await client.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId: row.agencyId } }) || row;
    }

    await updateFreshProjection({
      agencyId: row.agencyId,
      creatorId: resolved.creatorId,
      orderId: resolved.customOrderId,
      messageId: Number(row.messageId),
      observedAt: new Date(row.sentAt),
      db: client,
    });
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
      if (PROJECTION_REVIEW_CODES.has(code) || code === "CUSTOM_SUBMISSION_THREAD_NOT_ACTIVE") {
        row = await setProjectionState({ row, state: "REVIEW_REQUIRED", reason: code, projectedAt: now, db: client });
        return durableProjectionResult(row, { state: "REVIEW_REQUIRED", reason: code });
      }
      row = await setProjectionState({ row, state: "FAILED_RETRYABLE", reason: code, projectedAt: null, db: client });
      return durableProjectionResult(row, { state: "FAILED_RETRYABLE", reason: code });
    }

    const submissionId = projected?.submission?.id || null;
    const state = submissionId ? "APPLIED" : "SKIPPED";
    const reason = submissionId ? null : (projected?.reason || "NO_SUBMISSION_REQUIRED");
    row = await setProjectionState({ row, state, reason, projectedAt: now, db: client });
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
  const take = boundedLimit(limit);
  // Exception visibility is derived from CURRENT thread context, not the stale creatorId projection
  // stored when the event first failed. Read the exception set and authorize each row against a
  // fresh resolver result; capacity of this correctness queue is audited separately.
  const rows = await client.telegramInboundEvent.findMany({
    where: { agencyId, projectionState: "REVIEW_REQUIRED" },
    orderBy: [{ projectedAt: "asc" }, { observedAt: "asc" }, { id: "asc" }],
  });
  const visible = [];
  for (const row of rows || []) {
    try {
      const auth = await authorizeTelegramInboundException({ agencyId, member, row, write: false, db: client });
      visible.push({ row, auth });
    } catch (error) {
      if (Number(error?.status) === 403) continue;
      throw error;
    }
  }
  const selected = visible.slice(0, take);
  const creatorIds = Array.from(new Set(selected.flatMap(({ auth }) => auth.creatorIds || [])));
  const creators = creatorIds.length && client.creatorAccount?.findMany
    ? await client.creatorAccount.findMany({ where: { agencyId, id: { in: creatorIds } }, select: { id: true, displayName: true, username: true, avatarUrl: true, deletedAt: true } })
    : [];
  const creatorById = new Map((creators || []).map((row) => [String(row.id), row]));
  const candidatesByCreator = creatorIds.length && client.customOrder?.findMany
    ? await loadReviewCandidateOrders({ agencyId, creatorIds, db: client })
    : new Map();
  const canResolve = await canUsePermission({ member, key: "content.review_customs", db: client });

  const items = selected.map(({ row, auth }) => {
    const context = auth.context || { type: "NO_ACTIVE_THREAD", threads: [] };
    const candidateOrders = [];
    const seen = new Set();
    for (const creatorId of auth.creatorIds || []) {
      for (const order of candidatesByCreator.get(String(creatorId)) || []) {
        if (seen.has(order.customOrderId)) continue;
        if (context.type !== "NO_ACTIVE_THREAD" && !targetAllowedByThreadContext(context, { id: order.customOrderId })) continue;
        seen.add(order.customOrderId); candidateOrders.push(order);
      }
    }
    const threadCreatorId = context.thread?.creatorId || (auth.creatorIds.length === 1 ? auth.creatorIds[0] : null);
    return {
      eventId: String(row.id), accountId: String(row.accountId), senderTelegramUserId: String(row.senderTelegramUserId),
      messageId: String(row.messageId), replyToMessageId: row.replyToMessageId == null ? null : String(row.replyToMessageId), groupedId: row.groupedId || null,
      hasMedia: row.hasMedia === true, text: row.text || null, sentAt: new Date(row.sentAt).toISOString(), observedAt: new Date(row.observedAt).toISOString(),
      projectionReason: row.projectionReason || null, projectionAttempts: Number(row.projectionAttempts || 0), projectedAt: row.projectedAt ? new Date(row.projectedAt).toISOString() : null,
      creatorId: threadCreatorId || null, creator: threadCreatorId ? reviewCreatorSummary(creatorById.get(String(threadCreatorId))) : null,
      customOrderId: context.thread?.customOrderId || null,
      customOrder: context.thread?.customOrderId ? reviewOrderSummary({ id: context.thread.customOrderId, creatorId: context.thread.creatorId, type: context.thread.customOrderType, status: context.thread.customOrderStatus }) : null,
      threadContext: {
        type: String(context.type || "NO_ACTIVE_THREAD"),
        creatorIds: auth.creatorIds || [],
        customOrderIds: Array.isArray(context.customOrderIds) ? context.customOrderIds.map(String) : [],
        threads: (context.threads || []).map((thread) => ({
          anchorIntentId: thread.anchorIntentId || null, creatorId: thread.creatorId, customOrderId: thread.customOrderId,
          customOrderType: thread.customOrderType || null, customOrderStatus: thread.customOrderStatus || null,
          confirmationAuthority: thread.confirmationAuthority || null,
        })),
      },
      candidateOrders,
    };
  });
  return { ok: true, items, count: visible.length, canResolve: canResolve === true, serverNow: now.toISOString() };
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

  const auth = await authorizeTelegramInboundException({ agencyId, member, row, write: false, db: client });
  const context = auth.context;
  const rawQuery = clean(query, 200);
  const normalizedQuery = rawQuery.replace(/^#+/, "").trim();
  const take = Math.max(1, Math.min(50, Math.floor(Number(limit) || 30)));
  const where = { agencyId, type: "CONTENT", status: "PENDING" };
  if (context.type !== "NO_ACTIVE_THREAD" && auth.creatorIds.length) where.creatorId = { in: auth.creatorIds };
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
  const filtered = (rows || []).filter((target) => context.type === "NO_ACTIVE_THREAD" || targetAllowedByThreadContext(context, target));
  return {
    ok: true,
    eventId,
    creatorId: context.thread?.creatorId || (auth.creatorIds.length === 1 ? auth.creatorIds[0] : null),
    items: filtered.map(reviewOrderSummary),
    state: "REVIEW_REQUIRED",
    proofState: context.type,
    threadContext: { type: context.type, creatorIds: auth.creatorIds, customOrderIds: context.customOrderIds || [] },
  };
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
  await authorizeTelegramInboundException({ agencyId, member, row, write: true, db: client });

  const commitHumanReviewState = async ({ data, action }) => {
    const previousReason = row.projectionReason || null;
    const commit = async (tx) => {
      const freshStart = await tx.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId } });
      if (!freshStart) throw fail("TELEGRAM_INBOUND_REVIEW_NOT_FOUND", "Telegram inbound review event was not found", 404);
      if (freshStart.submissionId) return { linked: true, row: await convergeLinkedSubmissionState({ row: freshStart, now, db: tx }) };
      if (String(freshStart.projectionState) !== "REVIEW_REQUIRED") throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed concurrently; refresh the queue", 409);
      await authorizeTelegramInboundException({ agencyId, member, row: freshStart, write: true, db: tx });
      const revision = freshStart.updatedAt ? new Date(freshStart.updatedAt) : null;
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
      data: { projectionState: "SKIPPED", projectionReason: `MANUAL_SKIP:${justification}`.slice(0, 500), projectedAt: now, resolutionAuthority: "MANUAL_REVIEW_OVERRIDE" },
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
    const result = await projectTelegramInboundEvent({ eventId, actorUserId: member.userId || null, now, db: client });
    return { ok: true, idempotent: false, state: result.state, eventId, submissionId: result.submission?.id || null, projectionReason: result.reason || null };
  }

  const targetId = clean(customOrderId, 180);
  if (!targetId) throw fail("TELEGRAM_INBOUND_REVIEW_ORDER_REQUIRED", "customOrderId is required for ASSIGN_TO_CONTENT_ORDER");
  const assign = async (tx) => {
    const fresh = await tx.telegramInboundEvent.findFirst({ where: { id: eventId, agencyId } });
    if (!fresh || String(fresh.projectionState) !== "REVIEW_REQUIRED" || fresh.submissionId) throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed concurrently; refresh the queue", 409);
    const auth = await authorizeTelegramInboundException({ agencyId, member, row: fresh, write: true, db: tx });
    const target = await tx.customOrder.findFirst({ where: { id: targetId, agencyId } });
    if (!target) throw fail("TELEGRAM_INBOUND_REVIEW_ORDER_NOT_FOUND", "Target CustomOrder was not found", 404);
    if (String(target.type || "") !== "CONTENT" || String(target.status || "") !== "PENDING") throw fail("TELEGRAM_INBOUND_REVIEW_ORDER_INVALID", "Target must be a pending CONTENT CustomOrder", 409);
    await requireCreatorAccess({ agencyId, member, creatorId: target.creatorId, db: tx });

    const context = auth.context;
    const explicitUnprovenOverride = ["NO_ACTIVE_THREAD", "DIRECT_REPLY_UNRESOLVED"].includes(String(context.type || "")) && auth.scope?.broad;
    if (!explicitUnprovenOverride && !targetAllowedByThreadContext(context, target)) {
      throw fail("TELEGRAM_INBOUND_REVIEW_THREAD_CONFLICT", "Target CustomOrder is not a current candidate of this Telegram thread context", 409);
    }

    const revision = fresh.updatedAt ? new Date(fresh.updatedAt) : null;
    const matchedThread = (context.threads || []).find((thread) => String(thread.customOrderId) === targetId) || null;
    const prepared = await tx.telegramInboundEvent.updateMany({
      where: { id: eventId, agencyId, projectionState: "REVIEW_REQUIRED", submissionId: null, ...(revision && Number.isFinite(revision.getTime()) ? { updatedAt: revision } : {}) },
      data: {
        creatorId: String(target.creatorId), customOrderId: null,
        threadResolutionType: explicitUnprovenOverride ? "MANUAL_OVERRIDE" : String(context.type || "MANUAL_OVERRIDE"),
        threadAnchorIntentId: matchedThread?.anchorIntentId || null,
        resolutionAuthority: "MANUAL_REVIEW_OVERRIDE", projectionReason: "MANUAL_ASSIGN_PREPARED", projectedAt: null,
      },
    });
    if (Number(prepared?.count || 0) !== 1) throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed while preparing assignment", 409);
    const projected = await createCustomContentSubmissionFromInboundEvent({ eventId, actorUserId: member.userId || null, now, db: tx });
    if (!projected?.submission?.id) throw fail("TELEGRAM_INBOUND_REVIEW_SUBMISSION_REQUIRED", "The inbound event could not be materialized into a Custom submission", 409);
    const assigned = await assignCustomContentSubmission({ agencyId, member, submissionId: projected.submission.id, customOrderId: targetId, now, db: tx });
    const finalSubmissionId = assigned?.submission?.id || projected.submission.id;
    const completed = await tx.telegramInboundEvent.updateMany({
      where: { id: eventId, agencyId, projectionState: "REVIEW_REQUIRED", submissionId: finalSubmissionId },
      data: { creatorId: String(target.creatorId), customOrderId: targetId, projectionState: "APPLIED", projectionReason: `MANUAL_ASSIGN:${justification}`.slice(0, 500), projectedAt: now, resolutionAuthority: "MANUAL_REVIEW_OVERRIDE" },
    });
    if (Number(completed?.count || 0) !== 1) throw fail("TELEGRAM_INBOUND_REVIEW_RACE", "Telegram inbound review changed while finalizing assignment", 409);
    await audit({
      agencyId, actorUserId: member.userId || null, action: "custom_order.telegram_inbound_review_assign", targetType: "TelegramInboundEvent", targetId: eventId,
      metadata: { creatorId: String(target.creatorId), customOrderId: targetId, submissionId: finalSubmissionId, previousReason: fresh.projectionReason || null, reason: justification, threadResolutionType: context.type, manualOverride: explicitUnprovenOverride }, db: tx, required: true,
    });
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
  const pageSize = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
  let cursorId = null; let reconciled = 0; let submissions = 0; let scanned = 0;
  const creatorIds = new Set();
  for (;;) {
    const where = {
      agencyId,
      accountId: normalizedAccountId,
      submissionId: null,
      projectionState: { in: ["PENDING", "FAILED_RETRYABLE"] },
      ...(candidateOr.length === 1 ? candidateOr[0] : { OR: candidateOr }),
      ...(cursorId ? { id: { gt: cursorId } } : {}),
    };
    const rows = await client.telegramInboundEvent.findMany({ where, orderBy: [{ id: "asc" }], take: pageSize });
    if (!rows?.length) break;
    for (const row of rows) {
      cursorId = String(row.id); scanned += 1;
      const result = await projectTelegramInboundEvent({ eventId: row.id, actorUserId, now, db: client });
      const fresh = await client.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId } });
      if (fresh?.creatorId) creatorIds.add(String(fresh.creatorId));
      if (result?.submission) submissions += 1;
      if (!["PENDING", "FAILED_RETRYABLE"].includes(String(result?.state))) reconciled += 1;
    }
    if (rows.length < pageSize) break;
  }
  if (reconciled > 0) await audit({
    agencyId, actorUserId, action: "custom_order.telegram_inbound_reconcile_after_delivery_receipt", targetType: "TelegramDeliveryReceipt",
    targetId: `${normalizedAccountId}:${sender || replyId || "unknown"}`,
    metadata: { creatorIds: Array.from(creatorIds), reconciled, submissions, scanned, replyToMessageId: replyId }, db: client,
  });
  return { ok: true, creatorId: creatorIds.size === 1 ? Array.from(creatorIds)[0] : null, reconciled, submissions, scanned };
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
  let creatorId = null; let customOrderId = null; let threadResolutionType = null; let threadAnchorIntentId = null; let resolutionAuthority = null;
  try {
    const context = await resolveThreadContext({ agencyId, accountId: normalizedAccountId, senderTelegramUserId: sender, replyToMessageId: replyId, eventSentAt: observedAt, db: client });
    const resolved = threadResolutionProjection(context);
    creatorId = resolved.creatorId;
    customOrderId = resolved.customOrderId;
    threadResolutionType = resolved.threadResolutionType;
    threadAnchorIntentId = resolved.threadAnchorIntentId;
    resolutionAuthority = resolved.creatorId ? (resolved.threadResolutionType === "DIRECT_REPLY" ? "PROVIDER_DIRECT_REPLY" : "PROVIDER_ACTIVE_THREAD") : null;
  } catch { creatorId = null; customOrderId = null; threadResolutionType = null; threadAnchorIntentId = null; resolutionAuthority = null; }

  const id = eventId({ agencyId, accountId: normalizedAccountId, senderTelegramUserId: sender, messageId: inboundMessageId });
  let row = await client.telegramInboundEvent.findFirst({ where: { id } });
  if (!row) {
    try {
      row = await client.telegramInboundEvent.create({ data: {
        id, agencyId, accountId: normalizedAccountId, creatorId, customOrderId, senderTelegramUserId: sender, messageId: inboundMessageId,
        replyToMessageId: replyId, groupedId: clean(groupedId, 180) || null, hasMedia: hasMedia === true, text: clean(text, 4000) || null,
        sentAt: observedAt, observedAt: now, projectionState: "PENDING", projectionReason: null, projectedAt: null,
        intakeAuthority: "PROVIDER_OBSERVATION", threadResolutionType, threadAnchorIntentId, resolutionAuthority,
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
