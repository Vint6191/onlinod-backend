"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { syncFinalizedSubmissionAssignment } = require("./custom-content-library-service");
const { ACTIVE, SALVAGE, submissionAllowsNewPipelineWork, ensureSubmissionExecutionProfile, hasCurrentVaultSettlement, customAssetMatchesPipelineProjection, invalidateVaultSettlementData, assertNewRelayWorkAllowed, reportSubmissionExecutionAttempt, lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle, withSubmissionPipelineLock, historicalRelayRecipientsForSubmissions } = require("./custom-content-pipeline-authority-service");
const { canUsePermission } = require("./team-access-control");
const { confirmedRelayResult } = require("./custom-relay-result-proof-service");
const { providerMessageEventId, resolveTelegramCustomThread, targetAllowedByThreadContext } = require("./custom-telegram-thread-authority-service");
const { lockActiveTelegramAccountReference } = require("./telegram-account-reference-authority-service");
const { fenceCustomModelObligationTransition, supersedePrecommitInitialReferences } = require("./custom-model-obligation-authority-service");
const { adjudicateHumanModelResponseOverride } = require("./custom-model-instruction-override-authority-service");
const { reprojectCustomReminderSchedule } = require("./custom-order-reminders");

const MAX_TELEGRAM_MESSAGES = 50;
const MAX_COMMENT = 4_000;
const MAX_OF_MEDIA_IDS = 200;
const MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647;
const MAX_UPLOAD_WORK = 12;
const RUNTIME_LEASE_QUERY_CHUNK = 250;
const REVIEW_WAITING = "WAITING_REVIEW";
const REVIEW_REVISION = "REVISION_REQUESTED";
const REVIEW_APPROVED = "APPROVED";

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function identifier(value, field, { optional = false, max = 180 } = {}) {
  const text = String(value == null ? "" : value).trim();
  if (!text && optional) return null;
  if (!text) throw fail(`CUSTOM_SUBMISSION_${field.toUpperCase()}_REQUIRED`, `${field} is required`);
  if (text.length > max) throw fail(`CUSTOM_SUBMISSION_${field.toUpperCase()}_TOO_LONG`, `${field} is too long`);
  return text;
}

function commentText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  if (text.length > MAX_COMMENT) throw fail("CUSTOM_SUBMISSION_COMMENT_TOO_LONG", `comment is too long (max ${MAX_COMMENT} characters)`);
  return text;
}

function telegramUserId(value, field = "telegramUserId") {
  const text = identifier(value, field, { max: 40 });
  if (!/^\d{1,20}$/.test(text)) throw fail("CUSTOM_SUBMISSION_TELEGRAM_SOURCE_USER_INVALID", `${field} must be a positive Telegram user id`);
  const numeric = BigInt(text);
  if (numeric <= 0n || numeric > 9223372036854775807n) throw fail("CUSTOM_SUBMISSION_TELEGRAM_SOURCE_USER_INVALID", `${field} must be a positive Telegram user id`);
  return numeric.toString(10);
}

function telegramMessageIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGES_REQUIRED", "telegramMessageIds must contain at least one message id");
  }
  if (value.length > MAX_TELEGRAM_MESSAGES) {
    throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGES_TOO_MANY", `telegramMessageIds supports at most ${MAX_TELEGRAM_MESSAGES} ids`);
  }
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const number = Number(raw);
    if (!Number.isInteger(number) || number <= 0 || number > MAX_TELEGRAM_MESSAGE_ID) {
      throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_INVALID", "telegramMessageIds must contain positive Telegram message ids");
    }
    if (seen.has(number)) continue;
    seen.add(number);
    result.push(number);
  }
  if (!result.length) throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGES_REQUIRED", "telegramMessageIds must contain at least one message id");
  return result;
}

function ofMediaIds(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of value.slice(0, MAX_OF_MEDIA_IDS)) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function ofMediaId(value) {
  const text = String(value == null ? "" : value).trim();
  if (!/^[1-9]\d{0,39}$/.test(text)) {
    throw fail("CUSTOM_SUBMISSION_OF_MEDIA_ID_INVALID", "ofMediaId must be a positive OnlyFans media id");
  }
  return text;
}

function runtimeLeaseInputs(value) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const accountId = String(item?.accountId || "").trim();
    const claimToken = String(item?.claimToken || "").trim();
    if (!accountId || !claimToken || seen.has(accountId)) continue;
    seen.add(accountId);
    result.push({ accountId, claimToken });
  }
  return result;
}

function uploadWorkLimit(value) {
  return Math.max(1, Math.min(MAX_UPLOAD_WORK, Math.floor(Number(value) || 1)));
}

function vaultUploadRecipient(value) {
  const text = String(value == null ? "" : value).trim().replace(/^@+/, "");
  return /^(?:[A-Za-z0-9_]{3,64}|[1-9]\d{0,39})$/.test(text) ? text : "";
}

function nextUploadIndex(row) {
  const telegramIds = Array.isArray(row?.telegramMessageIds) ? row.telegramMessageIds : [];
  const mediaIds = ofMediaIds(row?.ofMediaIds);
  if (mediaIds.length > telegramIds.length) return null;
  return mediaIds.length < telegramIds.length ? mediaIds.length : null;
}

function receivedAt(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return new Date(now);
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw fail("CUSTOM_SUBMISSION_RECEIVED_AT_INVALID", "receivedAt must be a valid date-time");
  return date;
}

function sameMessageIds(a, b) {
  const left = Array.from(new Set((Array.isArray(a) ? a : []).map(Number))).sort((x, y) => x - y);
  const right = Array.from(new Set((Array.isArray(b) ? b : []).map(Number))).sort((x, y) => x - y);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertManualImportTargetMatches(existing, requestedCustomOrderId) {
  const existingOrderId = existing?.customOrderId == null ? null : String(existing.customOrderId);
  const requestedOrderId = requestedCustomOrderId == null ? null : String(requestedCustomOrderId);
  if (existingOrderId === requestedOrderId) return;
  throw fail(
    "CUSTOM_SUBMISSION_MANUAL_IMPORT_TARGET_CONFLICT",
    "These Telegram messages already belong to a submission with a different CustomOrder assignment; use the dedicated reassignment workflow",
    409,
  );
}

function deterministicSubmissionId(agencyId, sourceAccountId, sourceUserId, messageIds) {
  const canonical = Array.from(new Set(messageIds.map(Number))).sort((a, b) => a - b).join(",");
  const digest = crypto.createHash("sha256").update(`${agencyId}\n${sourceAccountId}\n${sourceUserId}\n${canonical}`).digest("hex");
  return `cs_${digest}`;
}

function serializeSubmission(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    creatorId: String(row.creatorId),
    customOrderId: row.customOrderId == null ? null : String(row.customOrderId),
    telegramMessageIds: Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds.map(String) : [],
    telegramInboundEventIds: Array.isArray(row.telegramInboundEventIds) ? row.telegramInboundEventIds.map(String) : [],
    telegramSourceKey: row.telegramSourceKey || null,
    telegramSourceAccountId: row.telegramSourceAccountId == null ? null : String(row.telegramSourceAccountId),
    telegramSourceUserId: row.telegramSourceUserId == null ? null : String(row.telegramSourceUserId),
    intakeAuthority: row.sourceAuthority || (row.telegramSourceKey && Array.isArray(row.telegramInboundEventIds) && row.telegramInboundEventIds.length > 0
      ? "PROVEN_TELEGRAM_INBOUND"
      : "MANUAL_IMPORT"),
    sourceThreadIntentId: row.sourceThreadIntentId || null,
    sourceResolutionEventId: row.sourceResolutionEventId || null,
    ofMediaIds: ofMediaIds(row.ofMediaIds),
    comment: row.comment || null,
    executionVaultFolderId: row.executionVaultFolderId || null,
    executionRelayRecipient: row.executionRelayRecipient || null,
    executionProfileRevision: Math.max(0, Number(row.executionProfileRevision || 0)),
    executionPinnedAt: row.executionPinnedAt ? new Date(row.executionPinnedAt).toISOString() : null,
    pipelineDisposition: String(row.pipelineDisposition || ACTIVE),
    pipelineDispositionReason: row.pipelineDispositionReason || null,
    pipelineDispositionChangedAt: row.pipelineDispositionChangedAt ? new Date(row.pipelineDispositionChangedAt).toISOString() : null,
    pipelineBlockedCode: row.pipelineBlockedCode || null,
    pipelineBlockedAt: row.pipelineBlockedAt ? new Date(row.pipelineBlockedAt).toISOString() : null,
    pipelineLastAttemptAt: row.pipelineLastAttemptAt ? new Date(row.pipelineLastAttemptAt).toISOString() : null,
    pipelineNextAttemptAt: row.pipelineNextAttemptAt ? new Date(row.pipelineNextAttemptAt).toISOString() : null,
    reviewStatus: String(row.reviewStatus || "WAITING_REVIEW"),
    reviewComment: row.reviewComment || null,
    reviewedByMemberId: row.reviewedByMemberId == null ? null : String(row.reviewedByMemberId),
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
    receivedAt: new Date(row.receivedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function validateContentOrder({ agencyId, creatorId, customOrderId, db }) {
  if (!customOrderId) return null;
  const row = await db.customOrder.findFirst({
    where: { id: customOrderId, agencyId, creatorId },
    select: { id: true, type: true, status: true, fanDeliveredAt: true, contentBoundAt: true, updatedAt: true },
  });
  if (!row) throw fail("CUSTOM_SUBMISSION_ORDER_NOT_FOUND", "Custom order was not found for this creator", 404);
  if (String(row.type || "CONTENT").toUpperCase() !== "CONTENT") {
    throw fail("CUSTOM_SUBMISSION_ORDER_TYPE_INVALID", "Only CONTENT custom orders can have content submissions", 409);
  }
  if (String(row.status || "PENDING").toUpperCase() !== "PENDING" || row.fanDeliveredAt) {
    throw fail("CUSTOM_SUBMISSION_ORDER_CLOSED", "Completed, delivered, missed or cancelled custom orders cannot receive new content submissions", 409);
  }
  return row;
}

async function bindContentOrderForSubmission({ agencyId, creatorId, customOrderId, now = new Date(), db }) {
  if (!customOrderId) return null;
  const order = await validateContentOrder({ agencyId, creatorId, customOrderId, db });
  if (order.contentBoundAt) return order;
  const revision = order.updatedAt ? new Date(order.updatedAt) : null;
  if (!revision || !Number.isFinite(revision.getTime())) {
    throw fail("CUSTOM_SUBMISSION_ORDER_BIND_CONFLICT", "Custom order revision is unavailable while binding the CONTENT lifecycle", 409);
  }
  const requestedBoundAt = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const boundAt = Number.isFinite(requestedBoundAt.getTime()) ? requestedBoundAt : new Date();
  const fenceAt = new Date(Math.max(boundAt.getTime(), revision.getTime() + 1));
  const changed = await db.customOrder.updateMany({
    where: {
      id: order.id,
      agencyId,
      creatorId,
      type: "CONTENT",
      status: "PENDING",
      contentBoundAt: null,
      updatedAt: order.updatedAt,
    },
    // updatedAt is explicit because it is the cross-service CAS fence. Do not depend on
    // Prisma @updatedAt implementation details for the type-edit vs submission-bind race.
    data: { contentBoundAt: boundAt, updatedAt: fenceAt },
  });
  if (Number(changed?.count || 0) !== 1) {
    const fresh = await validateContentOrder({ agencyId, creatorId, customOrderId, db });
    if (fresh.contentBoundAt) return fresh;
    throw fail("CUSTOM_SUBMISSION_ORDER_BIND_CONFLICT", "Custom order changed while the CONTENT submission lifecycle was being bound; retry from fresh state", 409);
  }
  return { ...order, contentBoundAt: boundAt, updatedAt: fenceAt };
}

async function runSubmissionTransaction(client, work) {
  return typeof client?.$transaction === "function" ? client.$transaction(work) : work(client);
}

async function validateSubmissionLifecycleTarget({ agencyId, creatorId, customOrderId, excludeSubmissionId = null, revisionSourceIntentId = null, revisionSentAt = null, humanOverridePrecheck = false, db }) {
  if (!customOrderId) return;
  const exclude = excludeSubmissionId ? { id: { not: excludeSubmissionId } } : {};
  const approved = await db.customContentSubmission.findFirst({
    where: { agencyId, creatorId, customOrderId, reviewStatus: REVIEW_APPROVED, ...exclude },
    select: { id: true },
  });
  if (approved) {
    throw fail("CUSTOM_SUBMISSION_ORDER_ALREADY_APPROVED", "This custom order already has an approved content submission", 409);
  }
  const latest = await db.customContentSubmission.findFirst({
    where: { agencyId, creatorId, customOrderId, ...exclude },
    select: { id: true, reviewStatus: true },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  if (!latest) return;
  if (String(latest.reviewStatus || REVIEW_WAITING) !== REVIEW_REVISION) {
    throw fail("CUSTOM_SUBMISSION_ORDER_BUSY", "This custom order already has an active content submission awaiting manager review", 409);
  }
  // Human recovery paths may pass the structural lifecycle precheck without automatic revision
  // causality, but they MUST call adjudicateHumanModelResponseOverride() inside the final write
  // transaction before binding the response. This flag is precheck-only and has no commit authority.
  if (humanOverridePrecheck) return;
  const revisionIntent = db.telegramDeliveryIntent?.findFirst ? await db.telegramDeliveryIntent.findFirst({
    where: { agencyId, customOrderId, customSubmissionId: latest.id, kind: "REVISION_REQUEST", state: "CONFIRMED" },
    select: { id: true, remoteSentAt: true, confirmedAt: true },
    orderBy: [{ confirmedAt: "desc" }, { createdAt: "desc" }],
  }) : null;
  if (!revisionIntent) {
    throw fail("CUSTOM_SUBMISSION_REVISION_DISPATCH_UNCONFIRMED", "The manager revision instruction is not provider-confirmed yet; incoming media requires review/correlation instead of automatic next-version assignment", 409);
  }
  if (revisionSourceIntentId && String(revisionSourceIntentId) === String(revisionIntent.id)) return;
  const sent = revisionSentAt ? new Date(revisionSentAt) : null;
  const remoteSent = revisionIntent.remoteSentAt ? new Date(revisionIntent.remoteSentAt) : null;
  if (sent && remoteSent && Number.isFinite(sent.getTime()) && Number.isFinite(remoteSent.getTime()) && sent.getTime() >= remoteSent.getTime()) return;
  throw fail("CUSTOM_SUBMISSION_REVISION_CAUSALITY_UNPROVEN", "Incoming media is not causally after the confirmed revision instruction; manager review is required", 409);
}

async function createCustomContentSubmission({ agencyId, member, input = {}, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const creatorId = identifier(input.creatorId, "creatorId", { max: 100 });
  const customOrderId = identifier(input.customOrderId, "customOrderId", { optional: true, max: 180 });
  const messageIds = telegramMessageIds(input.telegramMessageIds);
  const comment = commentText(input.comment);
  const manualImportReason = commentText(input.manualImportReason);
  const sourceAccountId = identifier(input.telegramAccountId, "telegramAccountId", { max: 180 });
  const sourceUserId = telegramUserId(input.telegramUserId, "telegramUserId");
  if (!manualImportReason) throw fail("CUSTOM_SUBMISSION_MANUAL_IMPORT_REASON_REQUIRED", "manualImportReason is required for explicit raw Telegram import");
  if (!(await canUsePermission({ member, key: "content.review_customs", db: client }))) {
    throw fail("CUSTOM_SUBMISSION_MANUAL_IMPORT_FORBIDDEN", "content.review_customs permission is required for explicit raw Telegram import", 403);
  }
  await requireCreatorAccess({ agencyId, member, creatorId, db: client });
  if (!customOrderId) throw fail("CUSTOM_SUBMISSION_MANUAL_IMPORT_ORDER_REQUIRED", "customOrderId is required for audited historical Telegram import");
  const observedAt = receivedAt(input.receivedAt, now);
  const submissionId = deterministicSubmissionId(agencyId, sourceAccountId, sourceUserId, messageIds);

  if (typeof client?.$transaction !== "function") {
    throw fail("CUSTOM_SUBMISSION_MANUAL_IMPORT_TRANSACTION_REQUIRED", "Manual Telegram import requires transactional provider-source ownership", 500);
  }

  try {
    const result = await client.$transaction(async (tx) => {
      // NEW provider-backed work is fenced by the parent Agency lifecycle first.
      // Global provider-reference lock order is Agency -> CreatorAccount -> TelegramAccount.
      await lockAgencyPipelineLifecycle({ db: tx, agencyId });
      // Provider-message ownership is adjudicated before the target lifecycle. Exact retries must
      // remain idempotent even after their first submission is WAITING_REVIEW, and a partial
      // provider overlap must report the source conflict rather than an unrelated order-busy state.
      const existingExact = await tx.customContentSubmission.findFirst({ where: { id: submissionId, agencyId } });
      if (existingExact) {
        assertManualImportTargetMatches(existingExact, customOrderId);
        return { deduped: true, row: existingExact };
      }
      // Legacy rows created before the provider-source ledger cutover are checked globally,
      // deliberately without creatorId. One provider message may have only one business owner.
      const overlapping = await tx.customContentSubmission.findFirst({
        where: { agencyId, telegramSourceAccountId: sourceAccountId, telegramSourceUserId: sourceUserId, telegramMessageIds: { hasSome: messageIds } },
        orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      });
      if (overlapping) {
        if (sameMessageIds(overlapping.telegramMessageIds, messageIds)) {
          assertManualImportTargetMatches(overlapping, customOrderId);
          return { deduped: true, row: overlapping };
        }
        throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_CONFLICT", "One or more Telegram provider messages already belong to another submission", 409);
      }

      // NEW historical provider work shares the same lifecycle order as outbound planning and
      // creator Telegram rebinding: Agency -> CreatorAccount -> TelegramAccount. The Creator lock
      // prevents retirement from committing between target validation and provider ownership; the
      // account lock prevents ACTIVE -> RETIRING from racing the new historical account reference.
      await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId });
      await lockActiveTelegramAccountReference({
        agencyId,
        accountId: sourceAccountId,
        db: tx,
        notFoundCode: "CUSTOM_SUBMISSION_TELEGRAM_SOURCE_ACCOUNT_NOT_FOUND",
        retiringCode: "CUSTOM_SUBMISSION_TELEGRAM_SOURCE_ACCOUNT_RETIRING",
        unavailableCode: "CUSTOM_SUBMISSION_TELEGRAM_SOURCE_ACCOUNT_FENCE_UNAVAILABLE",
        notFoundMessage: "Telegram source account was not found in this agency",
        retiringMessage: "Telegram source account is retiring and cannot accept new historical source work",
      });

      const target = await validateContentOrder({ agencyId, creatorId, customOrderId, db: tx });
      await validateSubmissionLifecycleTarget({ agencyId, creatorId, customOrderId, humanOverridePrecheck: true, db: tx });

      // Re-evaluate the CURRENT active-thread context inside the same transaction that claims
      // provider messages. A unique/ambiguous active thread may constrain a historical import;
      // NO_ACTIVE_THREAD remains an explicit manager override rather than invented provider proof.
      const context = await resolveTelegramCustomThread({
        agencyId, accountId: sourceAccountId, senderTelegramUserId: sourceUserId, replyToMessageId: null, eventSentAt: observedAt, db: tx,
      });
      if (context.type === "UNIQUE_ACTIVE_THREAD" && !targetAllowedByThreadContext(context, target)) {
        throw fail("CUSTOM_SUBMISSION_MANUAL_IMPORT_THREAD_CONFLICT", "Telegram source currently belongs to another active Custom thread", 409);
      }
      if (context.type === "AMBIGUOUS_ACTIVE_THREADS" && !targetAllowedByThreadContext(context, target)) {
        throw fail("CUSTOM_SUBMISSION_MANUAL_IMPORT_THREAD_CONFLICT", "Target CustomOrder is not one of the active Telegram threads for this sender", 409);
      }

      const sourceEvents = [];
      for (const messageId of messageIds) {
        const id = providerMessageEventId({ agencyId, accountId: sourceAccountId, senderTelegramUserId: sourceUserId, messageId });
        let event = await tx.telegramInboundEvent.findFirst({ where: { id } });
        if (event && !event.submissionId) {
          // An already-ingested provider observation belongs to the canonical inbound exception
          // lifecycle. Manual historical import is recovery for observations that were never
          // ingested, not a second human resolver for REVIEW_REQUIRED/PENDING source rows.
          throw fail("CUSTOM_SUBMISSION_PROVIDER_EVENT_EXISTS", "This Telegram provider message is already in the inbound exception workflow; resolve that event instead of using manual historical import", 409);
        }
        if (!event) {
          try {
            event = await tx.telegramInboundEvent.create({ data: {
              id, agencyId, accountId: sourceAccountId, creatorId, customOrderId, submissionId: null,
              senderTelegramUserId: sourceUserId, messageId, replyToMessageId: null, groupedId: null,
              hasMedia: true, text: comment || null, sentAt: observedAt, observedAt: now,
              projectionState: "PENDING", projectionReason: null, projectedAt: null,
              intakeAuthority: "MANUAL_HISTORICAL_OBSERVATION",
              threadResolutionType: String(context.type || "NO_ACTIVE_THREAD"),
              threadAnchorIntentId: (context.threads || []).find((thread) => String(thread.customOrderId) === customOrderId)?.anchorIntentId || null,
              resolutionAuthority: "MANUAL_HISTORICAL_IMPORT",
            } });
          } catch (error) {
            if (String(error?.code || "") !== "P2002") throw error;
            event = await tx.telegramInboundEvent.findFirst({ where: { id } });
          }
        }
        if (!event) throw fail("CUSTOM_SUBMISSION_PROVIDER_SOURCE_PERSIST_FAILED", "Telegram provider source could not be persisted", 500);
        if (event.submissionId && String(event.submissionId) !== submissionId) {
          throw fail("CUSTOM_SUBMISSION_PROVIDER_SOURCE_OWNED", "A Telegram provider message already belongs to another submission", 409);
        }
        sourceEvents.push(event);
      }

      let row = await tx.customContentSubmission.findFirst({ where: { id: submissionId, agencyId } });
      if (row) {
        assertManualImportTargetMatches(row, customOrderId);
      } else {
        await bindContentOrderForSubmission({ agencyId, creatorId, customOrderId, now, db: tx });
        await validateSubmissionLifecycleTarget({ agencyId, creatorId, customOrderId, humanOverridePrecheck: true, db: tx });
        await adjudicateHumanModelResponseOverride({
          agencyId, creatorId, customOrderId, actorUserId: member.userId || null,
          context: "MANUAL_HISTORICAL_IMPORT", now, db: tx,
        });
        await supersedePrecommitInitialReferences({ agencyId, orderId: customOrderId, now, reason: "MANUAL_HISTORICAL_RESPONSE_ACCEPTED", db: tx });
        row = await tx.customContentSubmission.create({ data: {
          id: submissionId, agencyId, creatorId, customOrderId,
          telegramMessageIds: messageIds,
          telegramInboundEventIds: sourceEvents.map((event) => String(event.id)),
          telegramSourceAccountId: sourceAccountId,
          telegramSourceUserId: sourceUserId,
          telegramSourceKey: `provider:${agencyId}:${sourceAccountId}:${sourceUserId}:${messageIds.slice().sort((a,b)=>a-b).join(",")}`,
          sourceAuthority: "MANUAL_HISTORICAL_IMPORT",
          sourceThreadIntentId: (context.threads || []).find((thread) => String(thread.customOrderId) === customOrderId)?.anchorIntentId || null,
          sourceResolutionEventId: sourceEvents[0]?.id || null,
          ofMediaIds: [], comment, receivedAt: observedAt,
        } });
      }

      for (const event of sourceEvents) {
        const changed = await tx.telegramInboundEvent.updateMany({
          where: { id: event.id, agencyId, OR: [{ submissionId: null }, { submissionId: row.id }] },
          data: {
            creatorId, customOrderId, submissionId: row.id, projectionState: "APPLIED",
            projectionReason: `MANUAL_HISTORICAL_IMPORT:${manualImportReason}`.slice(0, 500), projectedAt: now,
            resolutionAuthority: "MANUAL_HISTORICAL_IMPORT",
          },
        });
        if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_SUBMISSION_PROVIDER_SOURCE_RACE", "Telegram provider source ownership changed concurrently", 409);
      }

      if (!overlapping && !row.createdAt) row.createdAt = now;
      await audit({
        agencyId,
        actorUserId: member.userId || null,
        action: "custom_content_submission.manual_historical_import",
        targetType: "CustomContentSubmission",
        targetId: row.id,
        metadata: {
          creatorId, customOrderId, telegramSourceAccountId: sourceAccountId, telegramSourceUserId: sourceUserId,
          telegramMessageIds: messageIds, manualImportReason, threadResolutionType: context.type,
        },
        db: tx,
        required: true,
      });
      return { deduped: false, row };
    }, { isolationLevel: "Serializable" });
    await reprojectModelObligationScheduleIfAvailable({ agencyId, orderId: result.row?.customOrderId, now, db: client });
    return { ok: true, deduped: result.deduped === true, submission: serializeSubmission(result.row) };
  } catch (error) {
    if (String(error?.code || "") === "P2034") throw fail("CUSTOM_SUBMISSION_MANUAL_IMPORT_RACE", "Telegram provider source changed concurrently; retry from fresh state", 409);
    throw error;
  }
}

async function withSubmissionSourceLock({ db, agencyId, submissionId, work }) {
  return withSubmissionPipelineLock({ db, agencyId, submissionId, work });
}

async function hasRelayExecutionForSubmission({ agencyId, creatorId, submissionId, db }) {
  if (!db.automationDelivery?.findFirst) return false;
  const row = await db.automationDelivery.findFirst({
    where: {
      agencyId,
      creatorId,
      actionType: "CUSTOM_RELAY_SEND",
      idempotencyKey: { startsWith: `custom-relay:${String(submissionId)}:` },
    },
    select: { id: true },
  });
  return Boolean(row?.id);
}

async function createCustomContentSubmissionFromInboundEvent({ eventId, actorUserId = null, now = new Date(), db = null, _sourceLockHeld = false } = {}) {
  const client = db || require("../prisma");
  const normalizedEventId = identifier(eventId, "telegramInboundEventId", { max: 180 });
  const event = await client.telegramInboundEvent.findFirst({ where: { id: normalizedEventId } });
  if (!event) throw fail("CUSTOM_SUBMISSION_INBOUND_EVENT_NOT_FOUND", "Telegram inbound event was not found", 404);
  if (event.submissionId) {
    const existing = await client.customContentSubmission.findFirst({ where: { id: event.submissionId, agencyId: event.agencyId } });
    return { ok: true, deduped: true, submission: serializeSubmission(existing), sourceEventId: event.id };
  }
  if (!event.creatorId || event.hasMedia !== true) return { ok: true, deduped: true, submission: null, sourceEventId: event.id, reason: event.creatorId ? "NO_MEDIA" : "CREATOR_UNRESOLVED" };

  const groupedId = String(event.groupedId || "").trim();
  let sourceKey = groupedId
    ? `telegram:${event.agencyId}:${event.accountId}:${event.senderTelegramUserId}:group:${groupedId}`
    : `telegram:${event.agencyId}:${event.accountId}:${event.senderTelegramUserId}:message:${event.messageId}`;
  let forceUnassigned = false;
  let existing = await client.customContentSubmission.findFirst({ where: { telegramSourceKey: sourceKey } });
  if (existing && !_sourceLockHeld && typeof client.$transaction === "function" && typeof client.$queryRawUnsafe === "function") {
    return withSubmissionSourceLock({
      db: client, agencyId: event.agencyId, submissionId: existing.id,
      work: (tx) => createCustomContentSubmissionFromInboundEvent({ eventId: event.id, actorUserId, now, db: tx, _sourceLockHeld: true }),
    });
  }
  if (existing && existing.telegramSourceAccountId && String(existing.telegramSourceAccountId) !== String(event.accountId)) {
    throw fail("CUSTOM_SUBMISSION_SOURCE_ACCOUNT_CONFLICT", "Telegram album source account changed", 409);
  }
  if (existing && existing.telegramSourceUserId && String(existing.telegramSourceUserId) !== String(event.senderTelegramUserId)) {
    throw fail("CUSTOM_SUBMISSION_SOURCE_USER_CONFLICT", "Telegram album source sender changed", 409);
  }
  if (existing && !sameMessageIds(existing.telegramMessageIds, [event.messageId])) {
    const existingOrder = existing.customOrderId
      ? await client.customOrder.findFirst({
          where: { id: existing.customOrderId, agencyId: event.agencyId, creatorId: existing.creatorId },
          select: { id: true, type: true, status: true, fanDeliveredAt: true },
        })
      : null;
    if (!submissionAllowsNewPipelineWork(existing, existingOrder)) {
      // A late provider member must never re-open or mutate an adjudicated/terminal pipeline.
      // Preserve the provider fact as a new deterministic UNASSIGNED submission so confirmed
      // SALVAGE can converge independently and ARCHIVED/ABANDONED history stays immutable.
      sourceKey = `telegram:${event.agencyId}:${event.accountId}:${event.senderTelegramUserId}:message:${event.messageId}`;
      forceUnassigned = true;
      existing = await client.customContentSubmission.findFirst({ where: { telegramSourceKey: sourceKey } });
    }
  }
  if (existing && !sameMessageIds(existing.telegramMessageIds, [event.messageId])) {
    const projected = ofMediaIds(existing.ofMediaIds);
    const creatorConflict = String(existing.creatorId || "") !== String(event.creatorId || "");
    const orderConflict = Boolean(existing.customOrderId && event.customOrderId && String(existing.customOrderId) !== String(event.customOrderId));
    const relaySourceFrozen = projected.length > 0 || await hasRelayExecutionForSubmission({ agencyId: event.agencyId, creatorId: existing.creatorId, submissionId: existing.id, db: client });
    if (relaySourceFrozen || creatorConflict || orderConflict) {
      // A very late album member may never reorder a submission whose OF relay already began.
      // Likewise, provider grouping cannot override contradictory proven creator/order provenance.
      // Split the conflicting event into its own deterministic source unit; for an order conflict
      // keep it UNASSIGNED so a manager resolves the business target explicitly instead of silently
      // annexing media proven for order B into submission A.
      sourceKey = `telegram:${event.agencyId}:${event.accountId}:${event.senderTelegramUserId}:message:${event.messageId}`;
      forceUnassigned = orderConflict || relaySourceFrozen;
      existing = await client.customContentSubmission.findFirst({ where: { telegramSourceKey: sourceKey } });
    }
  }

  if (existing) {
    const eventIds = Array.from(new Set([...(Array.isArray(existing.telegramInboundEventIds) ? existing.telegramInboundEventIds.map(String) : []), String(event.id)]));
    const sourceEvents = await client.telegramInboundEvent.findMany({ where: { id: { in: eventIds } }, orderBy: [{ sentAt: "asc" }, { messageId: "asc" }] });
    const messageIds = sourceEvents.map((item) => Number(item.messageId));
    const sortedEventIds = sourceEvents.map((item) => String(item.id));
    if (ofMediaIds(existing.ofMediaIds).length > 0 && !sameMessageIds(existing.telegramMessageIds, messageIds)) {
      throw fail("CUSTOM_SUBMISSION_SOURCE_FROZEN", "Telegram album changed after OnlyFans relay projection started", 409);
    }
    const changed = await client.customContentSubmission.updateMany({ where: { id: existing.id, agencyId: event.agencyId, updatedAt: existing.updatedAt }, data: { telegramMessageIds: messageIds, telegramInboundEventIds: sortedEventIds, telegramSourceAccountId: existing.telegramSourceAccountId || String(event.accountId), telegramSourceUserId: existing.telegramSourceUserId || String(event.senderTelegramUserId), sourceAuthority: existing.sourceAuthority || event.resolutionAuthority || (String(event.threadResolutionType || "") === "DIRECT_REPLY" ? "PROVIDER_DIRECT_REPLY" : "PROVIDER_ACTIVE_THREAD"), sourceThreadIntentId: existing.sourceThreadIntentId || event.threadAnchorIntentId || null, sourceResolutionEventId: existing.sourceResolutionEventId || String(event.id), receivedAt: sourceEvents[0]?.sentAt || existing.receivedAt } });
    if (Number(changed?.count || 0) !== 1) return createCustomContentSubmissionFromInboundEvent({ eventId: event.id, actorUserId, now, db: client, _sourceLockHeld });
    await client.telegramInboundEvent.updateMany({ where: { id: event.id, submissionId: null }, data: { submissionId: existing.id } });
    const updated = await client.customContentSubmission.findFirst({ where: { id: existing.id, agencyId: event.agencyId } });
    await reprojectModelObligationScheduleIfAvailable({ agencyId: event.agencyId, orderId: updated?.customOrderId, now, db: client });
    return { ok: true, deduped: false, submission: serializeSubmission(updated), sourceEventId: event.id };
  }

  let customOrderId = forceUnassigned ? null : (event.customOrderId || null);
  if (customOrderId) {
    try {
      await validateContentOrder({ agencyId: event.agencyId, creatorId: event.creatorId, customOrderId, db: client });
      await validateSubmissionLifecycleTarget({ agencyId: event.agencyId, creatorId: event.creatorId, customOrderId, revisionSourceIntentId: event.threadAnchorIntentId || null, revisionSentAt: event.sentAt || now, db: client });
    } catch (error) {
      if (!["CUSTOM_SUBMISSION_ORDER_BUSY", "CUSTOM_SUBMISSION_ORDER_ALREADY_APPROVED", "CUSTOM_SUBMISSION_ORDER_CLOSED"].includes(String(error?.code || ""))) throw error;
      customOrderId = null;
    }
  }
  const submissionId = `cs_${crypto.createHash("sha256").update(`${event.agencyId}\n${sourceKey}`).digest("hex")}`;
  let row;
  try {
    row = await runSubmissionTransaction(client, async (tx) => {
      await lockAgencyPipelineLifecycle({ db: tx, agencyId: event.agencyId });
      await lockCreatorPipelineLifecycle({ db: tx, agencyId: event.agencyId, creatorId: event.creatorId });
      if (customOrderId && String(event.resolutionAuthority || "") === "PROVIDER_ACTIVE_THREAD") {
        const currentThread = await resolveTelegramCustomThread({
          agencyId: event.agencyId, accountId: event.accountId, senderTelegramUserId: event.senderTelegramUserId, replyToMessageId: null, eventSentAt: event.sentAt, db: tx,
        });
        if (currentThread.type !== "UNIQUE_ACTIVE_THREAD" || !targetAllowedByThreadContext(currentThread, { id: customOrderId })) {
          throw fail("CUSTOM_SUBMISSION_THREAD_NOT_ACTIVE", "The non-Reply Telegram thread is no longer uniquely active for this CustomOrder", 409);
        }
      }
      if (customOrderId) {
        await bindContentOrderForSubmission({ agencyId: event.agencyId, creatorId: event.creatorId, customOrderId, now, db: tx });
        await validateSubmissionLifecycleTarget({ agencyId: event.agencyId, creatorId: event.creatorId, customOrderId, revisionSourceIntentId: event.threadAnchorIntentId || null, revisionSentAt: event.sentAt || now, db: tx });
        await fenceCustomModelObligationTransition({ agencyId: event.agencyId, orderId: customOrderId, now, db: tx });
        await supersedePrecommitInitialReferences({ agencyId: event.agencyId, orderId: customOrderId, now, reason: "PROVIDER_RESPONSE_ACCEPTED", db: tx });
      }
      return tx.customContentSubmission.create({ data: {
        id: submissionId,
        agencyId: event.agencyId,
        creatorId: event.creatorId,
        customOrderId,
        telegramMessageIds: [Number(event.messageId)],
        telegramInboundEventIds: [String(event.id)],
        telegramSourceKey: sourceKey,
        telegramSourceAccountId: String(event.accountId),
        telegramSourceUserId: String(event.senderTelegramUserId),
        sourceAuthority: event.resolutionAuthority || (String(event.threadResolutionType || "") === "DIRECT_REPLY" ? "PROVIDER_DIRECT_REPLY" : "PROVIDER_ACTIVE_THREAD"),
        sourceThreadIntentId: event.threadAnchorIntentId || null,
        sourceResolutionEventId: String(event.id),
        ofMediaIds: [],
        comment: commentText(event.text),
        receivedAt: event.sentAt || now,
      } });
    });
  } catch (error) {
    if (String(error?.code || "") !== "P2002") throw error;
    const raced = await client.customContentSubmission.findFirst({ where: { telegramSourceKey: sourceKey } });
    if (!raced) throw error;
    // A concurrent member of the same Telegram album may have won the sourceKey create.
    // Re-enter the canonical merge while this event is still unassigned so its message/event
    // identity is annexed with freshness ordering instead of being silently marked consumed.
    return createCustomContentSubmissionFromInboundEvent({ eventId: event.id, actorUserId, now, db: client, _sourceLockHeld });
  }
  const assigned = await client.telegramInboundEvent.updateMany({ where: { id: event.id, submissionId: null }, data: { submissionId: row.id } });
  if (Number(assigned?.count || 0) !== 1) {
    const freshEvent = await client.telegramInboundEvent.findFirst({ where: { id: event.id } });
    if (freshEvent?.submissionId && freshEvent.submissionId !== row.id) throw fail("CUSTOM_SUBMISSION_INBOUND_EVENT_REUSED", "Telegram inbound event already belongs to another submission", 409);
  }
  await audit({ agencyId: event.agencyId, actorUserId, action: "custom_content_submission.create_from_telegram_inbound", targetType: "CustomContentSubmission", targetId: row.id, metadata: { creatorId: row.creatorId, customOrderId: row.customOrderId || null, telegramInboundEventId: event.id, telegramMessageId: Number(event.messageId), sourceKey }, db: client });
  await reprojectModelObligationScheduleIfAvailable({ agencyId: event.agencyId, orderId: row.customOrderId, now, db: client });
  return { ok: true, deduped: false, submission: serializeSubmission(row), sourceEventId: event.id };
}

async function reprojectModelObligationScheduleIfAvailable({ agencyId, orderId, now, db }) {
  if (!orderId || !db?.workspaceSetting?.findUnique || !db?.telegramDeliveryIntent?.findFirst) return;
  await reprojectCustomReminderSchedule({ agencyId, orderId, now, db });
}

async function listCustomContentSubmissions({ agencyId, member, creatorId, customOrderId = undefined, unassigned = false, limit = 100, offset = 0, db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedCreatorId = identifier(creatorId, "creatorId", { max: 100 });
  await requireCreatorAccess({ agencyId, member, creatorId: normalizedCreatorId, db: client });
  const normalizedOrderId = customOrderId === undefined ? undefined : identifier(customOrderId, "customOrderId", { optional: true, max: 180 });
  if (normalizedOrderId) await validateContentOrder({ agencyId, creatorId: normalizedCreatorId, customOrderId: normalizedOrderId, db: client });
  const take = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const where = {
    agencyId,
    creatorId: normalizedCreatorId,
    ...(unassigned === true ? { customOrderId: null } : normalizedOrderId !== undefined ? { customOrderId: normalizedOrderId } : {}),
  };
  const [rows, count] = await Promise.all([
    client.customContentSubmission.findMany({ where, orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }], take, skip }),
    client.customContentSubmission.count({ where }),
  ]);
  return { ok: true, items: rows.map(serializeSubmission), count, nextOffset: skip + rows.length, hasMore: skip + rows.length < count };
}

async function assignCustomContentSubmission({ agencyId, member, submissionId, customOrderId, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedSubmissionId = identifier(submissionId, "submissionId", { max: 180 });
  const row = await client.customContentSubmission.findFirst({ where: { id: normalizedSubmissionId, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  if (String(row.pipelineDisposition || ACTIVE) !== ACTIVE) {
    throw fail("CUSTOM_SUBMISSION_PIPELINE_NOT_ACTIVE", "Resolved or salvaged content cannot be assigned to an active Custom order", 409);
  }
  const normalizedOrderId = identifier(customOrderId, "customOrderId", { optional: true, max: 180 });
  await validateContentOrder({ agencyId, creatorId: row.creatorId, customOrderId: normalizedOrderId, db: client });
  if ((row.customOrderId || null) === normalizedOrderId) {
    return { ok: true, unchanged: true, submission: serializeSubmission(row) };
  }
  if (String(row.reviewStatus || REVIEW_WAITING) !== REVIEW_WAITING) {
    throw fail("CUSTOM_SUBMISSION_REVIEW_LOCKED", "Reviewed submissions cannot be reassigned", 409);
  }
  await validateSubmissionLifecycleTarget({ agencyId, creatorId: row.creatorId, customOrderId: normalizedOrderId, excludeSubmissionId: row.id, humanOverridePrecheck: true, db: client });
  let updated;
  try {
    updated = await runSubmissionTransaction(client, async (tx) => {
      await lockAgencyPipelineLifecycle({ db: tx, agencyId });
      await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId: row.creatorId });
      if (normalizedOrderId) {
        await bindContentOrderForSubmission({ agencyId, creatorId: row.creatorId, customOrderId: normalizedOrderId, now, db: tx });
        await validateSubmissionLifecycleTarget({ agencyId, creatorId: row.creatorId, customOrderId: normalizedOrderId, excludeSubmissionId: row.id, humanOverridePrecheck: true, db: tx });
      }
      if (row.customOrderId) await fenceCustomModelObligationTransition({ agencyId, orderId: row.customOrderId, now, db: tx });
      if (normalizedOrderId) {
        await adjudicateHumanModelResponseOverride({
          agencyId, creatorId: row.creatorId, customOrderId: normalizedOrderId, excludeSubmissionId: row.id,
          actorUserId: member.userId || null, context: "MANUAL_SUBMISSION_ASSIGNMENT",
          now: new Date(new Date(now).getTime() + 1), db: tx,
        });
        await supersedePrecommitInitialReferences({ agencyId, orderId: normalizedOrderId, now: new Date(new Date(now).getTime() + 2), reason: "MANUAL_RESPONSE_ASSIGNMENT_ACCEPTED", db: tx });
      }
      const changed = await tx.customContentSubmission.updateMany({
        where: { id: row.id, agencyId, pipelineDisposition: ACTIVE, reviewStatus: REVIEW_WAITING, customOrderId: row.customOrderId, updatedAt: row.updatedAt },
        data: { customOrderId: normalizedOrderId },
      });
      if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_SUBMISSION_ASSIGNMENT_STALE", "Submission assignment changed while this manager action was being applied", 409);
      const fresh = await tx.customContentSubmission.findFirst({ where: { id: row.id, agencyId } });
      if (!fresh) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission disappeared during reassignment", 404);
      return fresh;
    });
  } catch (error) {
    if (error?.code === "P2002") throw fail("CUSTOM_SUBMISSION_ORDER_BUSY", "Another content submission is already awaiting manager review for this custom order", 409);
    throw error;
  }
  await audit({
    agencyId,
    actorUserId: member.userId || null,
    action: "custom_content_submission.assign",
    targetType: "CustomContentSubmission",
    targetId: row.id,
    metadata: { creatorId: row.creatorId, fromCustomOrderId: row.customOrderId || null, toCustomOrderId: normalizedOrderId },
    db: client,
  });
  await reprojectModelObligationScheduleIfAvailable({ agencyId, orderId: row.customOrderId, now, db: client });
  await reprojectModelObligationScheduleIfAvailable({ agencyId, orderId: normalizedOrderId, now, db: client });
  if (Array.isArray(updated.telegramMessageIds) && updated.telegramMessageIds.length > 0
      && ofMediaIds(updated.ofMediaIds).length === updated.telegramMessageIds.length) {
    // Best-effort immediate provenance refresh for already-finalized submissions.
    // If it cannot run now, pendingFinalizeRows notices the mismatch and the
    // existing Desktop execution loop heals it without losing the assignment.
    await syncFinalizedSubmissionAssignment({ agencyId, member, submissionId: updated.id, now, db: client }).catch(() => undefined);
  }
  return { ok: true, unchanged: false, submission: serializeSubmission(updated) };
}

async function pendingRelayProjectionRows({ agencyId, scope, limit, now = new Date(), db }) {
  const take = Math.max(1, Math.min(200, Math.floor(Number(limit) || 1)));
  const scopedIds = scope?.broad ? [] : Array.from(new Set((scope?.creatorIds || []).map(String).filter(Boolean)));
  if (!scope?.broad && !scopedIds.length) return [];

  if (typeof db.$queryRawUnsafe === "function") {
    const params = [agencyId];
    let scopeSql = "";
    if (scopedIds.length) {
      const placeholders = scopedIds.map((id) => { params.push(id); return `$${params.length}`; }).join(",");
      scopeSql = ` AND submission."creatorId" IN (${placeholders})`;
    }
    params.push(now);
    const nowParam = `$${params.length}`;
    return db.$queryRawUnsafe(
      `SELECT submission.*
       FROM "CustomContentSubmission" AS submission
       JOIN "CreatorAccount" AS creator
         ON creator."id" = submission."creatorId"
        AND creator."agencyId" = submission."agencyId"
        AND creator."deletedAt" IS NULL
       JOIN "AutomationDelivery" AS relay
         ON relay."agencyId" = submission."agencyId"
        AND relay."creatorId" = submission."creatorId"
        AND relay."actionType" = 'CUSTOM_RELAY_SEND'
        AND relay."status" = 'COMPLETED'
        AND relay."idempotencyKey" = ('custom-relay:' || submission."id" || ':' || cardinality(submission."ofMediaIds")::text)
       WHERE submission."agencyId" = $1
         ${scopeSql}
         AND (submission."pipelineNextAttemptAt" IS NULL OR submission."pipelineNextAttemptAt" <= ${nowParam})
         AND cardinality(submission."ofMediaIds") < cardinality(submission."telegramMessageIds")
       ORDER BY submission."pipelineLastAttemptAt" ASC NULLS FIRST, submission."receivedAt" ASC, submission."createdAt" ASC, submission."id" ASC
       LIMIT ${take}`,
      ...params,
    );
  }

  // Test/fallback path: cursor to exhaustion. LIMIT is applied only after the
  // exact next-index COMPLETED relay proof is found, so poisoned historical rows
  // cannot hide a later recoverable projection.
  const items = [];
  let cursor = null;
  while (items.length < take) {
    const rows = await db.customContentSubmission.findMany({
      where: {
        agencyId,
        AND: [{ OR: [{ pipelineNextAttemptAt: null }, { pipelineNextAttemptAt: { lte: now } }] }],
        ...(scope?.broad ? {} : { creatorId: { in: scopedIds } }),
      },
      orderBy: [{ pipelineLastAttemptAt: { sort: "asc", nulls: "first" } }, { receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const current = ofMediaIds(row.ofMediaIds);
      const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : [];
      if (current.length >= telegramIds.length) continue;
      const proof = await db.automationDelivery.findFirst({
        where: {
          agencyId,
          creatorId: row.creatorId,
          actionType: "CUSTOM_RELAY_SEND",
          status: "COMPLETED",
          idempotencyKey: `custom-relay:${row.id}:${current.length}`,
        },
        select: { id: true },
      });
      if (!proof) continue;
      items.push(row);
      if (items.length >= take) break;
    }
    if (rows.length < 200) break;
  }
  return items;
}

async function recoverConfirmedRelayProjectionForSubmission({ agencyId, submissionId, db }) {
  return withSubmissionSourceLock({ db, agencyId, submissionId, work: async (lockedClient) => {
    let row = await lockedClient.customContentSubmission.findFirst({ where: { id: submissionId, agencyId } });
    if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
    let current = ofMediaIds(row.ofMediaIds);
    const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : [];
    let recovered = 0;

    while (current.length < telegramIds.length) {
      const index = current.length;
      let proof;
      try {
        proof = await confirmedRelayResult({
          agencyId,
          creatorId: row.creatorId,
          submissionId: row.id,
          expectedIndex: index,
          expectedTelegramSourceAccountId: row.telegramSourceAccountId,
          expectedTelegramSourceUserId: row.telegramSourceUserId,
          expectedTelegramMessageId: telegramIds[index],
          db: lockedClient,
        });
      } catch (error) {
        // Absence of the exact next proof means the contiguous provider-confirmed
        // prefix ends here. Any other proof error is a real provenance conflict
        // and must remain visible instead of being silently skipped.
        if (String(error?.code || "") === "CUSTOM_SUBMISSION_RELAY_PROOF_REQUIRED") break;
        throw error;
      }
      if (current.includes(proof.mediaId)) {
        throw fail("CUSTOM_SUBMISSION_MEDIA_ID_DUPLICATE", "Confirmed relay result reuses an OnlyFans media id already projected into this submission", 409);
      }
      const next = [...current, proof.mediaId];
      const changed = await lockedClient.customContentSubmission.updateMany({
        where: { id: row.id, agencyId, updatedAt: row.updatedAt },
        data: { ofMediaIds: next, ...invalidateVaultSettlementData() },
      });
      if (Number(changed?.count || 0) !== 1) {
        const raced = await lockedClient.customContentSubmission.findFirst({ where: { id: row.id, agencyId } });
        const racedIds = ofMediaIds(raced?.ofMediaIds);
        if (raced && racedIds[index] === proof.mediaId) {
          row = raced;
          current = racedIds;
          continue;
        }
        throw fail("CUSTOM_SUBMISSION_MEDIA_COMMIT_CONFLICT", "Submission changed while a confirmed relay result was being recovered", 409);
      }
      row = await lockedClient.customContentSubmission.findFirst({ where: { id: row.id, agencyId } });
      if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission disappeared during relay projection recovery", 404);
      current = ofMediaIds(row.ofMediaIds);
      recovered += 1;
    }
    return { row, recovered };
  } });
}

async function discoverBlockedPipelineRows({ agencyId, scope, limit, currentRecipient = "", now = new Date(), db }) {
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 1)));
  const scopedIds = scope?.broad ? [] : Array.from(new Set((scope?.creatorIds || []).map(String).filter(Boolean)));
  if (!scope?.broad && !scopedIds.length) return [];

  // Diagnostic discovery is correctness-paged too. In particular, an unpinned
  // rolling-cutover submission may have a durable historical relay recipient
  // even when the current Workspace default is empty. Conversely, contradictory
  // historical recipients are an explicit BLOCKED state and must not be mistaken
  // for executable capacity merely because a current default happens to exist.
  const blocked = [];
  let cursor = null;
  while (blocked.length < take) {
    const rows = await db.customContentSubmission.findMany({
      where: {
        agencyId,
        pipelineDisposition: { in: [ACTIVE, SALVAGE] },
        AND: [{ OR: [{ pipelineNextAttemptAt: null }, { pipelineNextAttemptAt: { lte: now } }] }],
        ...(scope?.broad ? {} : { creatorId: { in: scopedIds } }),
      },
      orderBy: [{ pipelineLastAttemptAt: { sort: "asc", nulls: "first" } }, { receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    const historical = await historicalRelayRecipientsForSubmissions({
      db,
      agencyId,
      submissions: rows.filter((row) => !row.executionPinnedAt),
    });
    const { creatorById, liveOrderIds } = await loadPipelinePageContext({ db, agencyId, rows });
    for (const row of rows) {
      const dispositionValue = String(row.pipelineDisposition || ACTIVE);
      let live = dispositionValue === SALVAGE || !row.customOrderId;
      if (!live && row.customOrderId) {
        live = liveOrderIds === null
          ? Boolean(await db.customOrder.findFirst({ where: { id: row.customOrderId, agencyId, creatorId: row.creatorId, type: "CONTENT", status: "PENDING", fanDeliveredAt: null }, select: { id: true } }))
          : liveOrderIds.has(String(row.customOrderId));
      }
      if (!live) continue;
      const creator = creatorById.get(String(row.creatorId));
      if (!creator) continue;
      const current = ofMediaIds(row.ofMediaIds);
      const telegram = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : [];
      const activeIncomplete = dispositionValue === ACTIVE && current.length < telegram.length;
      const historicalEntry = !row.executionPinnedAt ? historical.get(String(row.id)) : null;
      const availableRecipient = String(row.executionRelayRecipient || historicalEntry?.recipient || currentRecipient || "").trim();
      let code = null;
      if (activeIncomplete && (!String(row.telegramSourceAccountId || "").trim() || !/^\d{1,20}$/.test(String(row.telegramSourceUserId || "").trim()))) code = "CUSTOM_SUBMISSION_SOURCE_IDENTITY_REQUIRED";
      else if ((dispositionValue === ACTIVE || current.length > 0) && !String(row.executionVaultFolderId || creator.customsVaultFolderId || "").trim()) code = "CUSTOM_SUBMISSION_VAULT_RELAY_REQUIRED";
      else if (activeIncomplete && historicalEntry?.error) code = String(historicalEntry.error.code || "CUSTOM_SUBMISSION_EXECUTION_PROFILE_LEGACY_BINDING_CONFLICT");
      else if (activeIncomplete && !availableRecipient) code = "CUSTOM_SUBMISSION_VAULT_RECIPIENT_REQUIRED";
      if (code) blocked.push({ row, code });
      if (blocked.length >= take) break;
    }
    if (rows.length < 200) break;
  }
  return blocked;
}

async function loadPipelinePageContext({ db, agencyId, rows }) {
  const creatorIds = Array.from(new Set((rows || []).map((row) => String(row.creatorId || "")).filter(Boolean)));
  const orderIds = Array.from(new Set((rows || []).map((row) => String(row.customOrderId || "")).filter(Boolean)));
  const [creators, liveOrders] = await Promise.all([
    creatorIds.length ? db.creatorAccount.findMany({
      where: { agencyId, id: { in: creatorIds }, deletedAt: null },
      select: { id: true, customsVaultFolderId: true },
      take: creatorIds.length,
    }) : Promise.resolve([]),
    orderIds.length && db.customOrder?.findMany ? db.customOrder.findMany({
      where: { agencyId, id: { in: orderIds }, type: "CONTENT", status: "PENDING", fanDeliveredAt: null },
      select: { id: true },
      take: orderIds.length,
    }) : Promise.resolve(null),
  ]);
  const creatorById = new Map((creators || []).map((creator) => [String(creator.id), creator]));
  const liveOrderIds = liveOrders === null ? null : new Set((liveOrders || []).map((order) => String(order.id)));
  return { creatorById, liveOrderIds };
}

function comparePipelineWorkRows(left, right) {
  const leftAttempt = left?.pipelineLastAttemptAt == null ? null : new Date(left.pipelineLastAttemptAt).getTime();
  const rightAttempt = right?.pipelineLastAttemptAt == null ? null : new Date(right.pipelineLastAttemptAt).getTime();
  if (leftAttempt === null && rightAttempt !== null) return -1;
  if (leftAttempt !== null && rightAttempt === null) return 1;
  if (leftAttempt !== null && rightAttempt !== null && leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
  const received = new Date(left.receivedAt || left.createdAt || 0).getTime() - new Date(right.receivedAt || right.createdAt || 0).getTime();
  if (received !== 0) return received;
  const created = new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
  return created !== 0 ? created : String(left.id).localeCompare(String(right.id));
}

async function pendingUploadRowsChunk({ agencyId, sourceAccountIds, creatorIds = null, limit, currentRecipient = "", now = new Date(), db }) {
  const take = Math.max(1, Math.min(200, Math.floor(Number(limit) || 1)));
  if (!sourceAccountIds.length || (Array.isArray(creatorIds) && !creatorIds.length)) return [];

  // Cursor to exhaustion and apply every correctness predicate before LIMIT.
  // This intentionally includes rolling-cutover historical recipient authority:
  // current Workspace configuration is only a default for truly unpinned work.
  const items = [];
  let cursor = null;
  while (items.length < take) {
    const rows = await db.customContentSubmission.findMany({
      where: {
        agencyId,
        pipelineDisposition: ACTIVE,
        AND: [{ OR: [{ pipelineNextAttemptAt: null }, { pipelineNextAttemptAt: { lte: now } }] }],
        telegramSourceAccountId: { in: sourceAccountIds },
        ...(Array.isArray(creatorIds) ? { creatorId: { in: creatorIds } } : {}),
      },
      orderBy: [{ pipelineLastAttemptAt: { sort: "asc", nulls: "first" } }, { receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    const historical = await historicalRelayRecipientsForSubmissions({
      db,
      agencyId,
      submissions: rows.filter((row) => !row.executionPinnedAt),
    });
    const { creatorById, liveOrderIds } = await loadPipelinePageContext({ db, agencyId, rows });
    for (const row of rows) {
      if (nextUploadIndex(row) === null) continue;
      if (!/^\d{1,20}$/.test(String(row.telegramSourceUserId || "").trim())) continue;
      const creator = creatorById.get(String(row.creatorId));
      if (!creator || (!row.executionVaultFolderId && !creator.customsVaultFolderId)) continue;
      const historicalEntry = !row.executionPinnedAt ? historical.get(String(row.id)) : null;
      if (historicalEntry?.error) continue;
      const availableRecipient = String(row.executionRelayRecipient || historicalEntry?.recipient || currentRecipient || "").trim();
      if (!availableRecipient) continue;
      if (row.customOrderId) {
        const orderLive = liveOrderIds === null
          ? Boolean(await db.customOrder.findFirst({ where: { id: row.customOrderId, agencyId, creatorId: row.creatorId, type: "CONTENT", status: "PENDING", fanDeliveredAt: null }, select: { id: true } }))
          : liveOrderIds.has(String(row.customOrderId));
        if (!orderLive) continue;
      }
      items.push(row);
      if (items.length >= take) break;
    }
    if (rows.length < 200) break;
  }
  return items;
}

async function pendingUploadRows({ agencyId, sourceAccountIds, scope, limit, currentRecipient = "", now = new Date(), db }) {
  const accountIds = Array.from(new Set((Array.isArray(sourceAccountIds) ? sourceAccountIds : []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!accountIds.length) return [];
  const scopedIds = scope?.broad ? null : Array.from(new Set((scope?.creatorIds || []).map(String).filter(Boolean)));
  if (!scope?.broad && !scopedIds.length) return [];
  const take = Math.max(1, Math.min(200, Math.floor(Number(limit) || 1)));
  const accountChunks = [];
  for (let offset = 0; offset < accountIds.length; offset += RUNTIME_LEASE_QUERY_CHUNK) accountChunks.push(accountIds.slice(offset, offset + RUNTIME_LEASE_QUERY_CHUNK));
  const creatorChunks = scopedIds === null ? [null] : [];
  if (scopedIds !== null) {
    for (let offset = 0; offset < scopedIds.length; offset += RUNTIME_LEASE_QUERY_CHUNK) creatorChunks.push(scopedIds.slice(offset, offset + RUNTIME_LEASE_QUERY_CHUNK));
  }
  const merged = [];
  for (const accountChunk of accountChunks) {
    for (const creatorChunk of creatorChunks) {
      merged.push(...await pendingUploadRowsChunk({
        agencyId,
        sourceAccountIds: accountChunk,
        creatorIds: creatorChunk,
        limit: take,
        currentRecipient,
        now,
        db,
      }));
    }
  }
  const seenIds = new Set();
  return merged
    .sort(comparePipelineWorkRows)
    .filter((row) => { const id = String(row.id); if (seenIds.has(id)) return false; seenIds.add(id); return true; })
    .slice(0, take);
}

async function pendingFinalizeRows({ agencyId, scope, limit, now = new Date(), db }) {
  const take = Math.max(1, Math.min(200, Math.floor(Number(limit) || 1)));
  const scopedIds = scope?.broad ? [] : Array.from(new Set((scope?.creatorIds || []).map(String).filter(Boolean)));
  if (!scope?.broad && !scopedIds.length) return [];
  if (typeof db.$queryRawUnsafe === "function") {
    const params = [agencyId];
    let scopeSql = "";
    if (scopedIds.length) {
      const placeholders = scopedIds.map((id) => { params.push(id); return `$${params.length}`; }).join(",");
      scopeSql = ` AND submission."creatorId" IN (${placeholders})`;
    }
    params.push(now);
    const nowParam = `$${params.length}`;
    return db.$queryRawUnsafe(
      `SELECT submission.*
       FROM "CustomContentSubmission" AS submission
       JOIN "CreatorAccount" AS creator ON creator."id" = submission."creatorId" AND creator."agencyId" = submission."agencyId"
       LEFT JOIN "CustomOrder" AS custom_order ON custom_order."id" = submission."customOrderId"
       WHERE submission."agencyId" = $1
         AND submission."pipelineDisposition" IN ('ACTIVE', 'SALVAGE')
         AND (submission."pipelineNextAttemptAt" IS NULL OR submission."pipelineNextAttemptAt" <= ${nowParam})
         AND creator."deletedAt" IS NULL
         ${scopeSql}
         AND cardinality(submission."ofMediaIds") > 0
         AND (
           (submission."pipelineDisposition" = 'ACTIVE' AND cardinality(submission."ofMediaIds") = cardinality(submission."telegramMessageIds"))
           OR submission."pipelineDisposition" = 'SALVAGE'
         )
         AND (submission."executionVaultFolderId" IS NOT NULL OR creator."customsVaultFolderId" IS NOT NULL)
         AND (submission."pipelineDisposition" = 'SALVAGE' OR submission."customOrderId" IS NULL OR (
           custom_order."type" = 'CONTENT' AND custom_order."status" = 'PENDING' AND custom_order."fanDeliveredAt" IS NULL
         ))
         AND (
           -- Migration/backfill + external-stage proof invariant: Library rows
           -- alone are not proof of pinned Vault settlement. Missing/stale
           -- receipt always returns the submission to move-only finalization.
           submission."executionPinnedAt" IS NULL
           OR submission."executionVaultFolderId" IS NULL
           OR submission."vaultSettlementConfirmedAt" IS NULL
           OR submission."vaultSettlementConfirmedByDeviceId" IS NULL
           OR submission."vaultSettlementFolderId" IS DISTINCT FROM submission."executionVaultFolderId"
           OR submission."vaultSettlementProfileRevision" IS DISTINCT FROM submission."executionProfileRevision"
           OR submission."vaultSettlementMediaFingerprint" IS NULL
           OR EXISTS (
             SELECT 1 FROM unnest(submission."ofMediaIds") AS media_id
             WHERE NOT EXISTS (
               SELECT 1 FROM "CreatorMediaAsset" AS asset
               WHERE asset."agencyId" = submission."agencyId"
                 AND asset."creatorId" = submission."creatorId"
                 AND asset."mediaId" = media_id
                 AND asset."source" = 'CUSTOM'
                 AND asset."customSubmissionId" = submission."id"
                 AND asset."customOrderId" IS NOT DISTINCT FROM submission."customOrderId"
                 AND asset."catalogActive" = TRUE
                 AND asset."sortingStatus" = 'SORTED'
                 AND submission."executionVaultFolderId" = ANY(asset."folderIds")
                 AND ((submission."customOrderId" IS NULL AND asset."customFullPriceCents" IS NULL)
                   OR (submission."customOrderId" IS NOT NULL AND asset."customFullPriceCents" = custom_order."priceCents"))
             )
           )
         )
       ORDER BY submission."pipelineLastAttemptAt" ASC NULLS FIRST, submission."receivedAt" ASC, submission."createdAt" ASC, submission."id" ASC
       LIMIT ${take}`,
      ...params,
    );
  }
  const items = [];
  let cursor = null;
  while (items.length < take) {
    const rows = await db.customContentSubmission.findMany({
      where: {
        agencyId,
        pipelineDisposition: { in: [ACTIVE, SALVAGE] },
        AND: [{ OR: [{ pipelineNextAttemptAt: null }, { pipelineNextAttemptAt: { lte: now } }] }],
        ...(scope?.broad ? {} : { creatorId: { in: scopedIds } }),
      },
      orderBy: [{ pipelineLastAttemptAt: { sort: "asc", nulls: "first" } }, { receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : [];
      const mediaIds = ofMediaIds(row.ofMediaIds);
      const salvage = String(row.pipelineDisposition || ACTIVE) === SALVAGE;
      if (!mediaIds.length || (!salvage && (!telegramIds.length || mediaIds.length !== telegramIds.length))) continue;
      const creator = await db.creatorAccount.findFirst({ where: { id: row.creatorId, agencyId, deletedAt: null }, select: { customsVaultFolderId: true } });
      if (!creator || (!row.executionVaultFolderId && !creator.customsVaultFolderId)) continue;
      let order = null;
      if (row.customOrderId) {
        order = await db.customOrder.findFirst({ where: { id: row.customOrderId, agencyId, creatorId: row.creatorId, ...(salvage ? {} : { type: "CONTENT", status: "PENDING", fanDeliveredAt: null }) }, select: { id: true, priceCents: true } });
        if (!order && !salvage) continue;
      }
      const assets = await db.creatorMediaAsset.findMany({ where: { agencyId, creatorId: row.creatorId, mediaId: { in: mediaIds }, source: "CUSTOM" }, take: mediaIds.length });
      const byMediaId = new Map(assets.map((asset) => [String(asset.mediaId), asset]));
      const priceCents = order ? Math.max(0, Math.round(Number(order.priceCents) || 0)) : null;
      const finalized = mediaIds.every((mediaId) => {
        const asset = byMediaId.get(mediaId);
        return customAssetMatchesPipelineProjection(row, asset, order);
      });
      const profileSettled = hasCurrentVaultSettlement(row);
      if (!profileSettled || !finalized) items.push(row);
      if (items.length >= take) break;
    }
    if (rows.length < 200) break;
  }
  return items;
}

/**
 * Return upload work only for Telegram accounts whose existing runtime lease is
 * currently owned by this Desktop. The submission row itself stays compact:
 * no extra claim/status/device fields are persisted for upload execution.
 */

async function reserveCustomContentSubmissionRelayWrite({ agencyId, member, deviceId, submissionId, expectedIndex, expectedTelegramMessageId, accessEpoch = null, now = new Date(), db = null, reserveWrite = null } = {}) {
  if (!agencyId || !member?.id || !member?.userId) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedDeviceId = identifier(deviceId, "deviceId", { max: 180 });
  const id = identifier(submissionId, "submissionId", { max: 180 });
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0) throw fail("CUSTOM_SUBMISSION_UPLOAD_INDEX_INVALID", "expectedIndex must be a non-negative integer", 400);
  const expectedSourceId = String(expectedTelegramMessageId == null ? "" : expectedTelegramMessageId).trim();
  if (!/^[1-9]\d{0,9}$/.test(expectedSourceId) || Number(expectedSourceId) > MAX_TELEGRAM_MESSAGE_ID) {
    throw fail("CUSTOM_SUBMISSION_UPLOAD_SOURCE_REQUIRED", "expectedTelegramMessageId must be the Telegram source id from the claimed upload work", 400);
  }

  return withSubmissionSourceLock({ db: client, agencyId, submissionId: id, work: async (lockedClient) => {
    let row = await assertNewRelayWorkAllowed({ db: lockedClient, agencyId, submissionId: id });
    await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: lockedClient });
    const nextIndex = nextUploadIndex(row);
    if (nextIndex === null) throw fail("CUSTOM_SUBMISSION_UPLOAD_ALREADY_COMPLETE", "Content submission already has all OnlyFans media ids", 409);
    if (nextIndex !== index) throw fail("CUSTOM_SUBMISSION_UPLOAD_WORK_STALE", `Expected upload index ${nextIndex}, not ${index}`, 409);
    const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds.map(String) : [];
    const telegramMessageId = String(telegramIds[index] || "").trim();
    if (!telegramMessageId) throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_MISSING", "Submission upload index has no Telegram source message", 409);
    if (telegramMessageId !== expectedSourceId) {
      throw fail("CUSTOM_SUBMISSION_UPLOAD_WORK_STALE", `Telegram source at upload index ${index} changed from ${expectedSourceId} to ${telegramMessageId}`, 409);
    }
    const telegramSourceAccountId = String(row.telegramSourceAccountId || "").trim();
    const telegramSourceUserId = String(row.telegramSourceUserId || "").trim();
    if (!telegramSourceAccountId || !/^\d{1,20}$/.test(telegramSourceUserId)) {
      throw fail("CUSTOM_SUBMISSION_SOURCE_IDENTITY_REQUIRED", "Submission has no pinned Telegram source account/user identity", 409);
    }
    const profile = await ensureSubmissionExecutionProfile({ db: lockedClient, agencyId, submission: row, now, requireRelayRecipient: true });
    row = profile.submission;
    const recipient = String(profile.relayRecipient || "");
    const vaultFolderId = String(profile.vaultFolderId || "");
    const idempotencyKey = `custom-relay:${id}:${index}`;
    const requestedFingerprint = crypto.createHash("sha256").update(JSON.stringify({
      version: 3, agencyId, creatorId: String(row.creatorId), submissionId: id, expectedIndex: index,
      telegramSourceAccountId, telegramSourceUserId, telegramMessageId, recipient, vaultFolderId,
      executionProfileRevision: Number(row.executionProfileRevision || 0),
    })).digest("hex");

    // Rolling-cutover compatibility is scoped to this one product authority.
    // A pre-cutover custom-relay row used fingerprint v2 (no folder/profile
    // fields) but already durably bound the same submission/index/source and
    // recipient. Reuse that row's immutable fingerprint after validating every
    // semantic binding; never weaken generic Audit17 idempotency matching.
    let payloadFingerprint = requestedFingerprint;
    const existingWrite = lockedClient.automationDelivery?.findUnique
      ? await lockedClient.automationDelivery.findUnique({ where: { idempotencyKey } })
      : lockedClient.automationDelivery?.findFirst
        ? await lockedClient.automationDelivery.findFirst({ where: { agencyId, creatorId: row.creatorId, actionType: "CUSTOM_RELAY_SEND", idempotencyKey } })
        : null;
    if (existingWrite) {
      const payload = existingWrite.payload && typeof existingWrite.payload === "object" && !Array.isArray(existingWrite.payload) ? existingWrite.payload : {};
      const existingRecipient = String(payload.recipient || "").trim().replace(/^@+/, "");
      const existingFolderId = String(payload.vaultFolderId || "").trim();
      const existingProfileRevision = payload.executionProfileRevision == null ? null : Number(payload.executionProfileRevision);
      const existingFingerprint = String(existingWrite.payloadFingerprint || "").trim();
      const exactBinding = String(existingWrite.agencyId || "") === String(agencyId)
        && String(existingWrite.creatorId || "") === String(row.creatorId)
        && String(existingWrite.actionType || "") === "CUSTOM_RELAY_SEND"
        && String(existingWrite.idempotencyKey || "") === idempotencyKey
        && String(payload.submissionId || "") === id
        && Number(payload.expectedIndex) === index
        && String(payload.telegramSourceAccountId || "") === telegramSourceAccountId
        && String(payload.telegramSourceUserId || "") === telegramSourceUserId
        && String(payload.telegramMessageId || "") === telegramMessageId
        && existingRecipient === recipient
        && (!existingFolderId || existingFolderId === vaultFolderId)
        && (existingProfileRevision == null || existingProfileRevision === Number(row.executionProfileRevision || 0));
      if (!exactBinding || !existingFingerprint) {
        throw fail("CUSTOM_SUBMISSION_RELAY_LEGACY_BINDING_CONFLICT", "Existing Custom relay write cannot be adopted safely by the pinned execution profile", 409);
      }
      payloadFingerprint = existingFingerprint;
    }
    const reserveProgrammaticWrite = typeof reserveWrite === "function"
      ? reserveWrite
      : require("./programmatic-of-write-authority-service").reserveProgrammaticWrite;
    const authority = await reserveProgrammaticWrite({
      agencyId,
      userId: String(member.userId),
      memberId: String(member.id),
      accessEpoch: Number.isInteger(Number(accessEpoch)) ? Number(accessEpoch) : Number(member.accessEpoch || 0),
      creatorId: String(row.creatorId),
      deviceId: normalizedDeviceId,
      kind: "CUSTOM_RELAY_SEND",
      idempotencyKey,
      payloadFingerprint,
      payload: { submissionId: id, expectedIndex: index, telegramSourceAccountId, telegramSourceUserId, telegramMessageId, recipient, vaultFolderId, executionProfileRevision: Number(row.executionProfileRevision || 0), reservedForCustomUploadAt: new Date(now).toISOString() },
      targetId: `${id}:${index}`,
      permissionKeyOverride: null,
      leaseMs: 10 * 60_000,
      maxAttempts: 20,
    });
    return { ...authority, relayRecipient: recipient, executionVaultFolderId: vaultFolderId, executionProfileRevision: Number(row.executionProfileRevision || 0), submissionId: id, expectedIndex: index, telegramSourceAccountId, telegramSourceUserId, telegramMessageId };
  } });
}


async function closeCustomContentSubmissionRelayWriteUnresolved({ agencyId, member, deviceId, submissionId, expectedIndex, writeId, leaseToken, leaseRevision, accessEpoch = null, reason = null, db = null } = {}) {
  if (!agencyId || !member?.id || !member?.userId) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedDeviceId = identifier(deviceId, "deviceId", { max: 180 });
  const id = identifier(submissionId, "submissionId", { max: 180 });
  const normalizedWriteId = identifier(writeId, "writeId", { max: 180 });
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0) throw fail("CUSTOM_SUBMISSION_UPLOAD_INDEX_INVALID", "expectedIndex must be a non-negative integer", 400);
  const row = await client.customContentSubmission.findFirst({ where: { id, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  if (!(await canUsePermission({ member, key: "content.review_customs", db: client }))) throw fail("CUSTOM_SUBMISSION_MANUAL_RESOLUTION_FORBIDDEN", "content.review_customs permission is required to resolve an ambiguous Custom relay write", 403);
  const { closeProgrammaticWriteUnresolved } = require("./programmatic-of-write-authority-service");
  return closeProgrammaticWriteUnresolved({
    agencyId,
    userId: String(member.userId),
    memberId: String(member.id),
    accessEpoch: Number.isInteger(Number(accessEpoch)) ? Number(accessEpoch) : Number(member.accessEpoch || 0),
    creatorId: String(row.creatorId),
    deviceId: normalizedDeviceId,
    writeId: normalizedWriteId,
    leaseToken: identifier(leaseToken, "leaseToken", { max: 500 }),
    leaseRevision: Number(leaseRevision),
    kind: "CUSTOM_RELAY_SEND",
    permissionKey: null,
    reason,
    expectedIdempotencyKey: `custom-relay:${id}:${index}`,
  });
}

async function resolveCustomContentSubmissionRelayWriteMatched({ agencyId, member, deviceId, submissionId, expectedIndex, writeId, mediaId, messageId = null, accessEpoch = null, db = null } = {}) {
  if (!agencyId || !member?.id || !member?.userId) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedDeviceId = identifier(deviceId, "deviceId", { max: 180 });
  const id = identifier(submissionId, "submissionId", { max: 180 });
  const normalizedWriteId = identifier(writeId, "writeId", { max: 180 });
  const normalizedMediaId = identifier(mediaId, "mediaId", { max: 180 });
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0) throw fail("CUSTOM_SUBMISSION_UPLOAD_INDEX_INVALID", "expectedIndex must be a non-negative integer", 400);
  const row = await client.customContentSubmission.findFirst({ where: { id, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  if (!(await canUsePermission({ member, key: "content.review_customs", db: client }))) throw fail("CUSTOM_SUBMISSION_MANUAL_RESOLUTION_FORBIDDEN", "content.review_customs permission is required to resolve an ambiguous Custom relay write", 403);
  const { resolveProgrammaticWriteUnresolvedMatched } = require("./programmatic-of-write-authority-service");
  return resolveProgrammaticWriteUnresolvedMatched({
    agencyId, userId: String(member.userId), memberId: String(member.id),
    accessEpoch: Number.isInteger(Number(accessEpoch)) ? Number(accessEpoch) : Number(member.accessEpoch || 0),
    creatorId: String(row.creatorId), deviceId: normalizedDeviceId, writeId: normalizedWriteId,
    kind: "CUSTOM_RELAY_SEND", permissionKey: null,
    result: { mediaId: normalizedMediaId, ...(messageId ? { messageId: identifier(messageId, "messageId", { max: 180 }) } : {}) },
    expectedIdempotencyKey: `custom-relay:${id}:${index}`,
  });
}

async function claimCustomContentSubmissionUploadWork({ agencyId, member, deviceId, leases, limit = 1, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedDeviceId = identifier(deviceId, "deviceId", { max: 180 });
  const requestedLeases = runtimeLeaseInputs(leases);
  const take = uploadWorkLimit(limit);
  const requestedByAccount = new Map(requestedLeases.map((row) => [row.accountId, row.claimToken]));

  const leaseIds = [...requestedByAccount.keys()];
  const leaseRowsPromise = (async () => {
    if (!leaseIds.length) return [];
    const rows = [];
    for (let offset = 0; offset < leaseIds.length; offset += RUNTIME_LEASE_QUERY_CHUNK) {
      const ids = leaseIds.slice(offset, offset + RUNTIME_LEASE_QUERY_CHUNK);
      rows.push(...await client.agencyTelegramMtprotoAccount.findMany({
        where: {
          agencyId,
          id: { in: ids },
          runtimeClaimedByDeviceId: normalizedDeviceId,
          runtimeClaimUntil: { gt: now },
        },
        select: {
          id: true,
          runtimeClaimToken: true,
          runtimeLeaseUserId: true,
          runtimeLeaseMemberId: true,
          runtimeLeaseAccessEpoch: true,
          runtimeLeaseCreatorId: true,
        },
        // Explicit chunk-size take is a transport/SQL parameter bound only.
        // Every requested lease is queried across all chunks before eligibility.
        take: ids.length,
      }));
    }
    return rows;
  })();

  const [scope, leasedRows, recipientRow] = await Promise.all([
    allowedCreatorScope({ agencyId, member, db: client }),
    leaseRowsPromise,
    client.workspaceSetting.findUnique({ where: { agencyId_key: { agencyId, key: "vaultUploadRecipient" } }, select: { value: true } }).catch(() => null),
  ]);

  const currentUserId = String(member.userId || "");
  const currentMemberId = String(member.id || "");
  const currentAccessEpoch = Number(member.accessEpoch);
  const scopedCreatorIds = new Set(scope.creatorIds || []);
  const validAccountIds = leasedRows
    .filter((row) => {
      const anchorCreatorId = String(row.runtimeLeaseCreatorId || "");
      return requestedByAccount.get(String(row.id)) === String(row.runtimeClaimToken || "")
        && String(row.runtimeLeaseUserId || "") === currentUserId
        && String(row.runtimeLeaseMemberId || "") === currentMemberId
        && Number.isInteger(currentAccessEpoch)
        && Number(row.runtimeLeaseAccessEpoch) === currentAccessEpoch
        && Boolean(anchorCreatorId)
        && (scope.broad || scopedCreatorIds.has(anchorCreatorId));
    })
    .map((row) => String(row.id));
  const currentRecipient = vaultUploadRecipient(recipientRow?.value);
  const recoveryBlockedItems = [];

  // Recover provider-confirmed external facts before asking what work remains.
  // This is deliberately independent of Telegram runtime leases and of the
  // current CustomOrder status: COMPLETED Audit17 relay rows are historical
  // proof, not permission to create a new external write. Cancellation may stop
  // the next relay, but it must never erase a relay that already succeeded.
  const projectionRows = await pendingRelayProjectionRows({ agencyId, scope, limit: take, now, db: client });
  for (const projectionRow of projectionRows) {
    try {
      await recoverConfirmedRelayProjectionForSubmission({ agencyId, submissionId: String(projectionRow.id), db: client });
    } catch (error) {
      if (String(error?.code || "").startsWith("CUSTOM_")) {
        const code = String(error.code || "CUSTOM_SUBMISSION_RELAY_PROJECTION_BLOCKED");
        recoveryBlockedItems.push({ submissionId: String(projectionRow.id), code, message: String(error.message || "Confirmed Custom relay projection is blocked") });
        await reportSubmissionExecutionAttempt({ db: client, agencyId, submissionId: String(projectionRow.id), success: false, code, now }).catch(() => undefined);
        continue;
      }
      throw error;
    }
  }

  // Diagnostic discovery is a separate lane from executable work. Structural
  // blockers that fail eligibility (missing pinned source identity/destination/
  // recipient) must still become durable operator-visible state, but they must
  // never consume the executable work LIMIT.
  const diagnosticRows = await discoverBlockedPipelineRows({ agencyId, scope, limit: take, currentRecipient, now, db: client });
  for (const blocked of diagnosticRows) {
    const entry = { submissionId: String(blocked.row.id), code: blocked.code, message: blocked.code };
    recoveryBlockedItems.push(entry);
    await reportSubmissionExecutionAttempt({ db: client, agencyId, submissionId: entry.submissionId, success: false, code: entry.code, now }).catch(() => undefined);
  }

  // Correctness eligibility is applied before LIMIT. Telegram-dependent upload
  // candidates are restricted to exact account-level leases owned by this Desktop,
  // while submission creators are independently fenced by current member scope.
  // runtimeLeaseCreatorId is the lease lifecycle/access anchor, not an exclusive
  // business binding between one MTProto account and one creator.
  const [uploadRows, finalizeRows] = await Promise.all([
    pendingUploadRows({ agencyId, sourceAccountIds: validAccountIds, scope, limit: take, currentRecipient, now, db: client }),
    pendingFinalizeRows({ agencyId, scope, limit: take, now, db: client }),
  ]);

  const candidates = [
    ...uploadRows.map((submission) => ({ kind: "UPLOAD_MEDIA", submission })),
    ...finalizeRows.map((submission) => ({ kind: "FINALIZE_LIBRARY", submission })),
  ].sort((left, right) => comparePipelineWorkRows(left.submission, right.submission));

  const creatorIds = Array.from(new Set(candidates.map((entry) => String(entry.submission.creatorId)).filter(Boolean)));
  const creators = creatorIds.length ? await client.creatorAccount.findMany({
    where: { agencyId, id: { in: creatorIds }, deletedAt: null },
    select: { id: true, username: true },
    take: creatorIds.length,
  }) : [];
  const creatorById = new Map(creators.map((creator) => [String(creator.id), creator]));
  const blockedItems = [...recoveryBlockedItems];
  const items = [];

  for (const candidate of candidates) {
    if (items.length >= take) break;
    let row = candidate.submission;
    const creator = creatorById.get(String(row.creatorId));
    if (!creator) continue;
    try {
      const profile = await ensureSubmissionExecutionProfile({
        db: client,
        agencyId,
        submission: row,
        now,
        requireRelayRecipient: candidate.kind === "UPLOAD_MEDIA",
      });
      row = profile.submission;
      if (candidate.kind === "UPLOAD_MEDIA") {
        const index = nextUploadIndex(row);
        if (index === null) continue;
        const messageId = Number(row.telegramMessageIds?.[index]);
        const sourceAccountId = String(row.telegramSourceAccountId || "").trim();
        const sourceUserId = String(row.telegramSourceUserId || "").trim();
        if (!sourceAccountId || !/^\d{1,20}$/.test(sourceUserId)) {
          blockedItems.push({ submissionId: String(row.id), code: "CUSTOM_SUBMISSION_SOURCE_IDENTITY_REQUIRED", message: "This submission has no pinned Telegram source account/user identity." });
          continue;
        }
        if (!validAccountIds.includes(sourceAccountId)) continue;
        items.push({
          kind: "UPLOAD_MEDIA",
          submission: serializeSubmission(row),
          creatorId: String(row.creatorId),
          accountId: sourceAccountId,
          telegramSourceUserId: sourceUserId,
          creatorUsername: creator.username || null,
          folderId: String(profile.vaultFolderId),
          recipient: String(profile.relayRecipient),
          executionProfileRevision: Number(row.executionProfileRevision || 0),
          expectedIndex: index,
          telegramMessageId: String(messageId),
        });
      } else {
        items.push({
          kind: "FINALIZE_LIBRARY",
          submission: serializeSubmission(row),
          creatorId: String(row.creatorId),
          accountId: String(row.telegramSourceAccountId || ""),
          creatorUsername: creator.username || null,
          folderId: String(profile.vaultFolderId),
          recipient: String(profile.relayRecipient || ""),
          executionProfileRevision: Number(row.executionProfileRevision || 0),
          expectedIndex: null,
          telegramMessageId: null,
        });
      }
    } catch (error) {
      if (String(error?.code || "").startsWith("CUSTOM_SUBMISSION_") || String(error?.code || "") === "CREATOR_NOT_FOUND") {
        const code = String(error.code || "CUSTOM_SUBMISSION_BLOCKED");
        blockedItems.push({ submissionId: String(row.id), code, message: String(error.message || "Custom submission is blocked") });
        await reportSubmissionExecutionAttempt({ db: client, agencyId, submissionId: String(row.id), success: false, code, now }).catch(() => undefined);
        continue;
      }
      throw error;
    }
  }

  return {
    ok: true,
    items,
    blocked: blockedItems[0] || null,
    blockedItems,
    serverNow: new Date(now).toISOString(),
  };
}

async function reportCustomContentSubmissionExecutionAttempt({
  agencyId, member, submissionId, success, code = null,
  workKind = null, expectedIndex = null, executionProfileRevision = null,
  now = new Date(), db = null,
} = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const id = identifier(submissionId, "submissionId", { max: 180 });
  const row = await client.customContentSubmission.findFirst({ where: { id, agencyId }, select: { id: true, creatorId: true } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  return reportSubmissionExecutionAttempt({
    db: client, agencyId, submissionId: id, success: success === true, code, now,
    expectedWorkKind: workKind, expectedIndex, expectedExecutionProfileRevision: executionProfileRevision,
  });
}

async function assertCustomSubmissionTelegramSourceAccess({ agencyId, member, submissionId, creatorId, accountId, messageIds, db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedSubmissionId = identifier(submissionId, "submissionId", { max: 180 });
  const normalizedCreatorId = identifier(creatorId, "creatorId", { max: 100 });
  const normalizedAccountId = identifier(accountId, "telegramAccountId", { max: 180 });
  await requireCreatorAccess({ agencyId, member, creatorId: normalizedCreatorId, db: client });
  const row = await client.customContentSubmission.findFirst({
    where: { id: normalizedSubmissionId, agencyId, creatorId: normalizedCreatorId },
    include: { customOrder: { select: { id: true, type: true, status: true, fanDeliveredAt: true, creatorId: true } } },
  });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  if (!submissionAllowsNewPipelineWork(row, row.customOrder)) {
    throw fail("CUSTOM_SUBMISSION_PIPELINE_TERMINAL", "Cancelled, completed, delivered, or salvaged Custom content cannot read new Telegram source media", 409);
  }
  if (String(row.telegramSourceAccountId || "") !== normalizedAccountId) {
    throw fail("CUSTOM_SUBMISSION_SOURCE_ACCOUNT_MISMATCH", "Telegram account does not match this submission source", 403);
  }
  const sourceUserId = telegramUserId(row.telegramSourceUserId, "telegramSourceUserId");
  const pendingIndex = nextUploadIndex(row);
  if (pendingIndex === null) throw fail("CUSTOM_SUBMISSION_SOURCE_READ_NOT_REQUIRED", "This submission has no pending Telegram source media", 409);
  const requestedIds = telegramMessageIds(messageIds).map(String);
  const pendingSourceIds = new Set((Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : []).slice(pendingIndex).map(String));
  if (requestedIds.some((messageId) => !pendingSourceIds.has(messageId))) {
    throw fail("CUSTOM_SUBMISSION_SOURCE_MESSAGE_MISMATCH", "Requested Telegram messages are not pending source messages of this submission", 403);
  }
  return { ok: true, submission: row, accountId: normalizedAccountId, telegramSourceUserId: sourceUserId, telegramMessageIds: requestedIds };
}

async function commitCustomContentSubmissionMedia({ agencyId, member, submissionId, expectedIndex, db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedSubmissionId = identifier(submissionId, "submissionId", { max: 180 });
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_TELEGRAM_MESSAGES) throw fail("CUSTOM_SUBMISSION_MEDIA_INDEX_INVALID", "expectedIndex must be a valid zero-based Telegram media index");
  const row = await client.customContentSubmission.findFirst({ where: { id: normalizedSubmissionId, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : [];
  const current = ofMediaIds(row.ofMediaIds);
  if (index >= telegramIds.length) throw fail("CUSTOM_SUBMISSION_MEDIA_INDEX_INVALID", "expectedIndex is outside this submission", 409);
  const proof = await confirmedRelayResult({
    agencyId, creatorId: row.creatorId, submissionId: row.id, expectedIndex: index,
    expectedTelegramSourceAccountId: row.telegramSourceAccountId,
    expectedTelegramSourceUserId: row.telegramSourceUserId,
    expectedTelegramMessageId: telegramIds[index], db: client,
  });
  const normalizedMediaId = proof.mediaId;
  if (index < current.length) {
    if (current[index] === normalizedMediaId) return { ok: true, idempotent: true, completed: current.length === telegramIds.length, proof: { writeId: proof.writeId }, submission: serializeSubmission(row) };
    throw fail("CUSTOM_SUBMISSION_MEDIA_COMMIT_CONFLICT", "Stored submission media disagrees with the confirmed CUSTOM_RELAY_SEND result", 409);
  }
  if (index !== current.length) throw fail("CUSTOM_SUBMISSION_MEDIA_COMMIT_OUT_OF_ORDER", "OnlyFans media ids must be projected in Telegram message order", 409);
  if (current.includes(normalizedMediaId)) throw fail("CUSTOM_SUBMISSION_MEDIA_ID_DUPLICATE", "Confirmed relay result reuses an OnlyFans media id already projected into this submission", 409);
  const next = [...current, normalizedMediaId];
  const changed = await client.customContentSubmission.updateMany({ where: { id: row.id, agencyId, updatedAt: row.updatedAt }, data: { ofMediaIds: next, ...invalidateVaultSettlementData() } });
  if (Number(changed?.count || 0) !== 1) {
    const raced = await client.customContentSubmission.findFirst({ where: { id: row.id, agencyId } }); const racedIds = ofMediaIds(raced?.ofMediaIds);
    if (raced && racedIds[index] === normalizedMediaId) return { ok: true, idempotent: true, completed: racedIds.length === telegramIds.length, proof: { writeId: proof.writeId }, submission: serializeSubmission(raced) };
    throw fail("CUSTOM_SUBMISSION_MEDIA_COMMIT_CONFLICT", "Submission changed while the proven relay result was being projected", 409);
  }
  const updated = await client.customContentSubmission.findFirst({ where: { id: row.id, agencyId } });
  if (!updated) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission disappeared after media projection", 404);
  const completed = ofMediaIds(updated.ofMediaIds).length === telegramIds.length;
  if (completed) await audit({ agencyId, actorUserId: member.userId || null, action: "custom_content_submission.of_upload_complete", targetType: "CustomContentSubmission", targetId: updated.id, metadata: { creatorId: updated.creatorId, customOrderId: updated.customOrderId || null, mediaCount: telegramIds.length, authority: "CUSTOM_RELAY_SEND_CONFIRMED" }, db: client });
  return { ok: true, idempotent: false, completed, proof: { writeId: proof.writeId }, submission: serializeSubmission(updated) };
}

module.exports = {
  MAX_TELEGRAM_MESSAGES,
  assignCustomContentSubmission,
  assertCustomSubmissionTelegramSourceAccess,
  claimCustomContentSubmissionUploadWork,
  commitCustomContentSubmissionMedia,
  createCustomContentSubmission,
  createCustomContentSubmissionFromInboundEvent,
  deterministicSubmissionId,
  listCustomContentSubmissions,
  nextUploadIndex,
  pendingFinalizeRows,
  recoverConfirmedRelayProjectionForSubmission,
  reportCustomContentSubmissionExecutionAttempt,
  reserveCustomContentSubmissionRelayWrite,
  closeCustomContentSubmissionRelayWriteUnresolved,
  resolveCustomContentSubmissionRelayWriteMatched,
  sameMessageIds,
  serializeSubmission,
  telegramMessageIds,
};
