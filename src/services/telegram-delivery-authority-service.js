"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { assertExecutionAccessFence } = require("./execution-access-fence-service");
const { assertTelegramRuntimeLease } = require("./telegram-execution-runtime");
const { reconcilePendingInboundForConfirmedDelivery } = require("./telegram-inbound-authority-service");
const { canUsePermission } = require("./team-access-control");
const { lockActiveTelegramAccountReference, isActiveTelegramAccount } = require("./telegram-account-reference-authority-service");
const {
  deriveCustomInitialInstruction,
  deriveCustomModelObligation,
  fenceCustomModelObligationTransition,
  reminderBindingFromObligation,
  confirmedInstruction,
} = require("./custom-model-obligation-authority-service");
const { resolveRevisionProviderBinding } = require("./custom-revision-provider-binding-authority-service");
const { deriveCustomCancellationInstruction, requireCancellationProviderAnchor } = require("./custom-cancellation-instruction-authority-service");
const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
const { runDbTransaction } = require("./db-transaction-service");
const {
  WORK_CLASS: PHASE2_WORK_CLASS,
  lockDomainWorkClaimForCommit,
  heartbeatDomainWorkClaim,
} = require("./domain-work-authority-service");
const { assertCustomManagementCreatorAccess, lockCurrentAgencyMember } = require("./custom-management-access-authority-service");
const { scanAllById } = require("./telegram-exact-authority-scan-service");
const {
  nextReminderForOrder,
  desiredReminderSchedule,
  readWorkspaceReminderPolicy,
  reprojectCustomReminderSchedule,
  reminderText,
  resolveTelegramAccountId,
  taskText,
} = require("./custom-order-reminders");

const DELIVERY_KINDS = Object.freeze(["TASK", "REFERENCE", "MANUAL_REMINDER", "AUTO_REMINDER", "CANCELLATION", "REVISION_REQUEST"]);
const DELIVERY_STATES = Object.freeze(["PLANNED", "CLAIMED", "COMMITTING", "CONFIRMED", "RECONCILE_REQUIRED", "CANCELLED", "FAILED_PRECOMMIT"]);
const KIND_SET = new Set(DELIVERY_KINDS);
const REMINDER_KINDS = new Set(["MANUAL_REMINDER", "AUTO_REMINDER"]);
const UNRESOLVED_REMINDER_STATES = ["COMMITTING", "RECONCILE_REQUIRED"];
const UNRESOLVED_REFERENCE_STATES = ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT"];
const CLAIM_MS = 2 * 60 * 1000;
const PRECOMMIT_PROVIDER_UNAVAILABLE_PREFIX = "PRECOMMIT_PROVIDER_UNAVAILABLE:";
const PROVIDER_BLOCK_RETRY_BASE_MS = 60 * 1000;
const PROVIDER_BLOCK_RETRY_MAX_MS = 60 * 60 * 1000;
function providerBindingRepairDelayMs(attempts) {
  const n = Math.max(1, Math.min(16, Math.floor(Number(attempts) || 1)));
  return Math.min(PROVIDER_BLOCK_RETRY_MAX_MS, PROVIDER_BLOCK_RETRY_BASE_MS * (2 ** (n - 1)));
}

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 500) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }
function isPrecommitProviderBlocked(row) { return Boolean(row && String(row.state || "") === "PLANNED" && row.commitStartedAt == null && clean(row.outcomeReason, 500).startsWith(PRECOMMIT_PROVIDER_UNAVAILABLE_PREFIX)); }
function uuid(value, field = "clientIntentId") {
  const text = clean(value, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw fail("TELEGRAM_DELIVERY_INTENT_ID_INVALID", `${field} must be a UUID`);
  return text.toLowerCase();
}
function positiveInt(value, field, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw fail("TELEGRAM_DELIVERY_MESSAGE_ID_INVALID", `${field} must be a positive integer`);
  return n;
}
function iso(value, field, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(d.getTime())) throw fail("TELEGRAM_DELIVERY_TIME_INVALID", `${field} must be a valid date-time`);
  return d;
}
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function tokenHash(value) { return sha256(`telegram-delivery-claim\0${String(value || "")}`); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function payloadFingerprint(payload) { return sha256(stableJson(payload)); }
function scopeWhere(scope) {
  if (scope?.broad) return {};
  const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : [];
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}
function actor(member) {
  const value = { userId: clean(member?.userId, 180), memberId: clean(member?.id, 180), accessEpoch: Number(member?.accessEpoch) };
  if (!value.userId || !value.memberId || !Number.isInteger(value.accessEpoch)) throw fail("TELEGRAM_DELIVERY_ACCESS_FENCE_REQUIRED", "Current member access fence is required", 409);
  return value;
}
function logicalKey({ agencyId, orderId, kind, identity = "one" }) {
  return `custom-telegram:${agencyId}:${orderId}:${kind}:${identity}`;
}
function cancellationText(order) {
  const label = String(order?.scenario || "").trim().replace(/\s+/g, " ").slice(0, 240);
  return `❌ Кастом отменён${label ? `: «${label}»` : ""}. Выполнять его больше не нужно.${order?.cancelReason ? `\nПричина: ${String(order.cancelReason).trim()}` : ""}`.slice(0, 4096);
}
function taskPayload(order) {
  const recipientTelegramContact = clean(order?.creator?.telegramContact, 160);
  const recipientTelegramUserId = clean(order?.creator?.telegramUserId, 40);
  return {
    text: taskText(order),
    replyToDeliveryId: null,
    replyToMessageId: null,
    recipientTelegramContact: recipientTelegramContact || null,
    recipientTelegramUserId: /^\d{1,20}$/.test(recipientTelegramUserId) ? recipientTelegramUserId : null,
  };
}
function publicIntent(row) {
  if (!row) return null;
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
  return {
    id: String(row.id), creatorId: String(row.creatorId), customOrderId: String(row.customOrderId), customSubmissionId: row.customSubmissionId == null ? null : String(row.customSubmissionId), accountId: String(row.accountId),
    kind: String(row.kind), logicalKey: String(row.logicalKey), clientIntentId: row.clientIntentId || null,
    referenceOrdinal: row.referenceOrdinal == null ? null : Number(row.referenceOrdinal), payloadFingerprint: String(row.payloadFingerprint), payload,
    state: String(row.state), claimRevision: Number(row.claimRevision || 0), claimUntil: row.claimUntil ? new Date(row.claimUntil).toISOString() : null,
    commitStartedAt: row.commitStartedAt ? new Date(row.commitStartedAt).toISOString() : null,
    remoteMessageId: row.remoteMessageId == null ? null : String(row.remoteMessageId), remoteRecipientTelegramUserId: row.remoteRecipientTelegramUserId || null, remoteSentAt: row.remoteSentAt ? new Date(row.remoteSentAt).toISOString() : null,
    outcomeReason: row.outcomeReason || null,
    providerBindingRepairAttempts: Math.max(0, Number(row.providerBindingRepairAttempts || 0)),
    providerBindingRetryAt: row.providerBindingRetryAt ? new Date(row.providerBindingRetryAt).toISOString() : null,
    confirmationAuthority: row.confirmationAuthority || null, confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
  };
}


async function loadOrder({ agencyId, orderId, db }) {
  const id = clean(orderId, 180);
  if (!id) throw fail("CUSTOM_ORDER_ID_REQUIRED", "orderId is required");
  const row = await db.customOrder.findFirst({
    where: { id, agencyId },
    include: { creator: { select: { id: true, displayName: true, username: true, telegramContact: true, telegramUserId: true, telegramAccountId: true, deletedAt: true, status: true } } },
  });
  if (!row) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order not found", 404);
  return row;
}

async function resolveAccountForOrder({ agencyId, order, db }) {
  const accountId = await resolveTelegramAccountId({ agencyId, creator: order.creator, db });
  if (!accountId) throw fail("CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", "No Telegram connection is assigned to this creator", 409);
  if (!clean(order.creator?.telegramContact, 160)) throw fail("CUSTOM_ORDER_TELEGRAM_CONTACT_REQUIRED", "Creator Telegram contact is required", 409);
  const account = await db.agencyTelegramMtprotoAccount.findFirst({ where: { id: String(accountId), agencyId }, select: { id: true, lifecycleState: true } });
  if (!isActiveTelegramAccount(account)) throw fail("CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING", "Telegram connection is retiring and cannot accept new Custom delivery work", 409);
  return String(accountId);
}

async function loadConfirmedTaskThread({ agencyId, orderId, db }) {
  const task = await db.telegramDeliveryIntent.findFirst({
    where: { agencyId, customOrderId: clean(orderId, 180), kind: "TASK", state: "CONFIRMED" },
    orderBy: [{ confirmedAt: "desc" }, { createdAt: "desc" }],
  });
  if (!task || task.remoteMessageId == null) throw fail("TELEGRAM_DELIVERY_TASK_THREAD_REQUIRED", "A confirmed Telegram TASK receipt is required before follow-up delivery", 409);
  const recipientTelegramUserId = clean(task.remoteRecipientTelegramUserId, 40);
  if (!/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN", "The confirmed Telegram TASK does not contain a proven recipient identity", 409);
  return {
    task,
    accountId: String(task.accountId),
    replyToMessageId: String(task.remoteMessageId),
    recipientTelegramUserId,
  };
}

async function resolveCancellationProviderBinding({ agencyId, order, db }) {
  const decision = await deriveCustomCancellationInstruction({ agencyId, order, db });
  return requireCancellationProviderAnchor(decision);
}

async function resolveReminderProviderBinding({ agencyId, order, db }) {
  if (String(order?.type || "CONTENT").toUpperCase() !== "CONTENT") {
    const task = await loadConfirmedTaskThread({ agencyId, orderId: order.id, db });
    return { ...task, obligation: null, cycleId: `TASK:${String(task.task.id)}`, replyToDeliveryId: String(task.task.id) };
  }
  const obligation = await deriveCustomModelObligation({ agencyId, order, db });
  const binding = reminderBindingFromObligation(obligation);
  if (!binding) {
    throw fail("CUSTOM_MODEL_OBLIGATION_NOT_WAITING_RESPONSE", "The model does not currently owe a Custom content response; reminder delivery is not allowed", 409);
  }
  return { ...binding, obligation, replyToDeliveryId: binding.intentId };
}

async function resolveInitialReferenceProviderBinding({ agencyId, order, db }) {
  const obligation = await deriveCustomModelObligation({ agencyId, order, db });
  if (String(obligation?.state || "") !== "INITIAL_WAITING_RESPONSE" || obligation?.modelOwesResponse !== true || String(obligation?.currentInstruction?.kind || "") !== "TASK") {
    throw fail("CUSTOM_MODEL_INITIAL_OBLIGATION_NOT_WAITING_RESPONSE", "The initial Custom model obligation is no longer waiting for a response; initial references are obsolete", 409);
  }
  const instruction = obligation.currentInstruction;
  return {
    accountId: String(instruction.accountId),
    replyToMessageId: String(instruction.remoteMessageId),
    recipientTelegramUserId: String(instruction.recipientTelegramUserId),
    replyToDeliveryId: String(instruction.intentId),
    cycleId: `TASK:${String(instruction.intentId)}`,
    obligation,
  };
}

async function resolveIntentProviderBinding({ agencyId, order, kind, customSubmissionId = null, db }) {
  const normalizedKind = String(kind);
  if (normalizedKind === "TASK") {
    return { accountId: await resolveAccountForOrder({ agencyId, order, db }), replyToMessageId: null, recipientTelegramUserId: null };
  }
  if (normalizedKind === "REFERENCE") return resolveInitialReferenceProviderBinding({ agencyId, order, db });
  if (normalizedKind === "REVISION_REQUEST") {
    if (!customSubmissionId) throw fail("TELEGRAM_REVISION_DECISION_REQUIRED", "Exact reviewed submission is required for revision provider binding", 409);
    const decision = await loadRevisionRequestDecision({ agencyId, customSubmissionId, customOrderId: order.id, db });
    return resolveRevisionProviderBinding({ agencyId, orderId: order.id, submission: decision.submission, db });
  }
  if (REMINDER_KINDS.has(normalizedKind)) return resolveReminderProviderBinding({ agencyId, order, db });
  if (normalizedKind === "CANCELLATION") return resolveCancellationProviderBinding({ agencyId, order, db });
  return loadConfirmedTaskThread({ agencyId, orderId: order.id, db });
}

async function createOrReadIntent({ agencyId, order, accountId, kind, identity, clientIntentId = null, referenceOrdinal = null, customSubmissionId = null, payload, now, db, reactivateCancelledTask = false, actorMember = null, _transactional = false }) {
  // New Telegram work and Telegram-account retirement contend on the same account row.
  // Running the canonical-intent reservation in one transaction lets the no-op ACTIVE
  // update below act as a row mutex: either planning wins and retirement sees the new
  // blocker, or retirement wins and planning cannot create a new intent afterwards.
  if (!_transactional && typeof db?.$transaction === "function") {
    return db.$transaction(
      (tx) => createOrReadIntent({ agencyId, order, accountId, kind, identity, clientIntentId, referenceOrdinal, customSubmissionId, payload, now, db: tx, reactivateCancelledTask, actorMember, _transactional: true }),
      { isolationLevel: "Serializable" },
    );
  }
  // Direct human planning is itself a creator-specific management write. Fence the
  // current membership before any existing-intent refresh or new reservation so a
  // scope/accessEpoch revoke cannot race a stale request into durable Telegram work.
  if (actorMember) {
    await lockAgencyPipelineLifecycle({ db, agencyId });
    await assertCustomManagementCreatorAccess({
      agencyId, actorMember, creatorId: order.creatorId, permissionKey: null, db,
    });
  }
  const key = logicalKey({ agencyId, orderId: order.id, kind, identity });
  const fingerprint = payloadFingerprint(payload);
  const findCanonicalExisting = async () => {
    const byKey = await db.telegramDeliveryIntent.findUnique({ where: { logicalKey: key } });
    if (byKey) return byKey;
    if (String(kind) === "REVISION_REQUEST" && customSubmissionId) {
      return db.telegramDeliveryIntent.findFirst({
        where: { agencyId, kind: "REVISION_REQUEST", customSubmissionId: String(customSubmissionId) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    }
    if (String(kind) !== "REFERENCE" || !Number.isInteger(Number(referenceOrdinal))) return null;
    // REFERENCE has exactly one business identity: order + ordinal. clientIntentId is correlation only.
    return db.telegramDeliveryIntent.findFirst({
      where: { agencyId, customOrderId: order.id, kind: "REFERENCE", referenceOrdinal: Number(referenceOrdinal) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  };
  const useExisting = async (existing) => {
    const exact = String(existing.payloadFingerprint) === fingerprint && String(existing.creatorId) === String(order.creatorId) && String(existing.accountId) === String(accountId)
      && (String(kind) !== "REVISION_REQUEST" || String(existing.customSubmissionId || "") === String(customSubmissionId || ""));
    if (exact) {
      if (isPrecommitProviderBlocked(existing)) {
        const changed = await db.telegramDeliveryIntent.updateMany({
          where: { id: existing.id, agencyId, state: "PLANNED", claimRevision: Number(existing.claimRevision || 0), commitStartedAt: null, outcomeReason: existing.outcomeReason },
          data: { outcomeReason: null, providerBindingRepairAttempts: 0, providerBindingRetryAt: null },
        });
        if (Number(changed?.count || 0) === 1) {
          const fresh = await findCanonicalExisting();
          return { row: fresh, created: false, refreshed: true };
        }
        const raced = await findCanonicalExisting();
        if (raced && !isPrecommitProviderBlocked(raced)) return { row: raced, created: false, refreshed: false };
      }
      return { row: existing, created: false, refreshed: false };
    }

    // Before a physical commit permit, provider/context-derived Telegram payload may be refreshed
    // on the SAME logical intent. This is required when the creator's Telegram account, task reply
    // target, reminder text, or current order projection changes after plan/claim but before begin().
    // A refresh always invalidates the old claim. After COMMITTING the row is immutable.
    // For REFERENCES the local file proof + ordinal are the business identity and may NEVER change.
    const precommitRefreshable = String(existing.kind) === String(kind)
      && String(existing.creatorId) === String(order.creatorId)
      && ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(existing.state))
      && existing.commitStartedAt == null;
    const referenceProofStable = String(kind) !== "REFERENCE" || (
      Number(existing.referenceOrdinal) === Number(referenceOrdinal)
      && payloadFingerprint(existing.payload?.reference || null) === payloadFingerprint(payload?.reference || null)
    );
    if (precommitRefreshable && referenceProofStable) {
      const nextRevision = Number(existing.claimRevision || 0) + 1;
      const changed = await db.telegramDeliveryIntent.updateMany({
        where: { id: existing.id, agencyId, state: String(existing.state), claimRevision: Number(existing.claimRevision || 0), commitStartedAt: null },
        data: {
          accountId: String(accountId), customSubmissionId: customSubmissionId ? String(customSubmissionId) : existing.customSubmissionId, payloadFingerprint: fingerprint, payload, state: "PLANNED",
          deviceId: null, userId: null, memberId: null, accessEpoch: null,
          claimTokenHash: null, claimUntil: null, claimRevision: nextRevision,
          outcomeReason: `PRECOMMIT_${String(kind)}_REFRESH`, providerBindingRepairAttempts: 0, providerBindingRetryAt: null,
        },
      });
      if (Number(changed?.count || 0) === 1) {
        const fresh = await db.telegramDeliveryIntent.findFirst({ where: { id: existing.id, agencyId } });
        return { row: fresh, created: false, refreshed: true };
      }
      const raced = await findCanonicalExisting();
      if (raced && String(raced.payloadFingerprint) === fingerprint && String(raced.accountId) === String(accountId)) return { row: raced, created: false, refreshed: false };
      throw fail("TELEGRAM_DELIVERY_INTENT_CONFLICT", "Telegram delivery crossed the commit boundary while its precommit provider binding was being refreshed", 409);
    }
    if (String(kind) === "REFERENCE" && Number(existing.referenceOrdinal) === Number(referenceOrdinal)) {
      throw fail("TELEGRAM_REFERENCE_SLOT_CONFLICT", "This reference ordinal is already bound to a different immutable artifact proof", 409);
    }
    throw fail("TELEGRAM_DELIVERY_INTENT_CONFLICT", "Logical Telegram delivery intent already exists with different immutable payload", 409);
  };

  const mayReactivateCancelledCancellation = (existing) => Boolean(
    existing
      && String(kind) === "CANCELLATION"
      && String(existing.kind) === "CANCELLATION"
      && String(existing.state) === "CANCELLED"
      && existing.commitStartedAt == null
      && String(order.status || "").toUpperCase() === "CANCELLED"
      && !order.telegramCancellationWaivedAt
  );
  const mayReactivateCancelledTask = (existing) => Boolean(
    reactivateCancelledTask === true
      && existing
      && String(kind) === "TASK"
      && String(existing.kind) === "TASK"
      && String(existing.state) === "CANCELLED"
      && existing.commitStartedAt == null
      && existing.remoteMessageId == null
      && existing.remoteSentAt == null
      && existing.confirmedAt == null
      && !clean(existing.confirmationAuthority, 120)
      && String(order.type || "CONTENT").toUpperCase() === "CONTENT"
      && String(order.status || "PENDING").toUpperCase() === "PENDING"
  );
  const mayReactivateCancelled = (existing) => mayReactivateCancelledCancellation(existing) || mayReactivateCancelledTask(existing);

  const existing = await findCanonicalExisting();
  if (existing && !mayReactivateCancelled(existing)) return useExisting(existing);

  // NEW outbound Custom work participates in the same parent/creator retirement
  // serialization as CustomOrder/submission/provider intake. The global lock order is
  // Agency -> CreatorAccount -> TelegramAccount. This is crucial for terminal-order
  // follow-ups such as CANCELLATION: the order itself no longer blocks retirement.
  await lockAgencyPipelineLifecycle({ db, agencyId });
  await lockCreatorPipelineLifecycle({ db, agencyId, creatorId: order.creatorId });

  // Re-read after lifecycle locks. Another transaction may have created the canonical
  // intent while we waited; preserve exactly-once identity before taking the account lock.
  const afterLifecycle = await findCanonicalExisting();
  if (afterLifecycle && !mayReactivateCancelled(afterLifecycle)) return useExisting(afterLifecycle);

  await lockActiveTelegramAccountReference({
    agencyId,
    accountId,
    db,
    notFoundCode: "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED",
    retiringCode: "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING",
    unavailableCode: "TELEGRAM_DELIVERY_ACCOUNT_FENCE_UNAVAILABLE",
    notFoundMessage: "Telegram connection assigned to this Custom order no longer exists",
    retiringMessage: "Telegram connection is retiring and cannot accept new Custom delivery work",
  });

  // A terminal PRECOMMIT cancellation row is not proof that the cancellation business intent
  // was satisfied. Historical/rolling versions could invalidate the row before the Custom later
  // became durably CANCELLED, leaving the unique logical key as a permanent tombstone. Re-open
  // only this one safe class under the full Agency -> Creator -> TelegramAccount lifecycle fence.
  // COMMITTING/CONFIRMED outcomes are never rewritten, and no other delivery kind is resurrected.
  const cancelledCanonical = await findCanonicalExisting();
  const reactivateCancellation = mayReactivateCancelledCancellation(cancelledCanonical);
  const reactivateTask = mayReactivateCancelledTask(cancelledCanonical);
  if (reactivateCancellation || reactivateTask) {
    const nextRevision = Number(cancelledCanonical.claimRevision || 0) + 1;
    const reactivationKind = reactivateCancellation ? "CANCELLATION" : "TASK";
    const changed = await db.telegramDeliveryIntent.updateMany({
      where: {
        id: cancelledCanonical.id, agencyId, kind: reactivationKind, state: "CANCELLED",
        claimRevision: Number(cancelledCanonical.claimRevision || 0), commitStartedAt: null,
        ...(reactivateTask ? { remoteMessageId: null, remoteSentAt: null, confirmedAt: null, confirmationAuthority: null } : {}),
      },
      data: {
        accountId: String(accountId), payloadFingerprint: fingerprint, payload, state: "PLANNED",
        deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, commitStartedAt: null,
        claimRevision: nextRevision,
        outcomeReason: reactivateCancellation
          ? "CANCELLATION_REACTIVATED_FOR_TERMINAL_ORDER"
          : "TASK_REACTIVATED_FOR_CURRENT_MODEL_OBLIGATION",
      },
    });
    if (Number(changed?.count || 0) === 1) {
      const fresh = await findCanonicalExisting();
      return { row: fresh, created: false, refreshed: true, reactivated: true };
    }
    const raced = await findCanonicalExisting();
    if (raced && !mayReactivateCancelled(raced)) return useExisting(raced);
    throw fail("TELEGRAM_DELIVERY_INTENT_RACE", "Cancelled Telegram intent could not be reactivated from current lifecycle state", 409);
  }

  try {
    const row = await db.telegramDeliveryIntent.create({ data: {
      agencyId, creatorId: order.creatorId, customOrderId: order.id, customSubmissionId: customSubmissionId ? String(customSubmissionId) : null, accountId, kind, logicalKey: key,
      clientIntentId, referenceOrdinal, payloadFingerprint: fingerprint, payload, state: "PLANNED", createdAt: now,
    } });
    return { row, created: true, refreshed: false };
  } catch (error) {
    if (String(error?.code || "") !== "P2002") throw error;
    // Bounded collision recovery. Never recursively retry a unique violation: resolve the one
    // canonical row (logical key or REFERENCE slot) and adjudicate idempotency/conflict once.
    const raced = await findCanonicalExisting();
    if (!raced) throw fail("TELEGRAM_DELIVERY_INTENT_RACE", "Telegram delivery identity collided but the canonical row could not be recovered", 409);
    return useExisting(raced);
  }
}

async function findUnresolvedReminder({ agencyId, orderId, excludeIntentId = null, db }) {
  return db.telegramDeliveryIntent.findFirst({
    where: {
      agencyId,
      customOrderId: String(orderId),
      kind: { in: Array.from(REMINDER_KINDS) },
      state: { in: UNRESOLVED_REMINDER_STATES },
      ...(excludeIntentId ? { id: { not: String(excludeIntentId) } } : {}),
    },
    orderBy: [{ commitStartedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}


function initialTaskDispatchIsCurrent(obligation, { intentId = null, allowMissing = false, allowCancelled = false, allowAnyInitialState = false } = {}) {
  const state = String(obligation?.state || "");
  if (allowMissing && state === "NO_INSTRUCTION") return true;
  if (allowAnyInitialState && ["INITIAL_DISPATCH_PENDING", "INITIAL_DELIVERY_UNKNOWN", "INITIAL_WAITING_RESPONSE", "INITIAL_CONFIRMED"].includes(state)) return true;
  if (state !== "INITIAL_DISPATCH_PENDING") return false;
  if (intentId && String(obligation?.instructionIntentId || "") !== String(intentId)) return false;
  const deliveryState = String(obligation?.deliveryState || "");
  if (["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(deliveryState)) return true;
  return allowCancelled && deliveryState === "CANCELLED";
}

async function assertInitialTaskDispatchCurrent({ agencyId, order, intentId = null, allowMissing = false, allowCancelled = false, allowAnyInitialState = false, db }) {
  const obligation = await deriveCustomInitialInstruction({ agencyId, order, db });
  if (!initialTaskDispatchIsCurrent(obligation, { intentId, allowMissing, allowCancelled, allowAnyInitialState })) {
    throw fail(
      "CUSTOM_MODEL_INITIAL_INSTRUCTION_NOT_REQUIRED",
      "The current Custom model obligation no longer requires an initial TASK instruction",
      409,
    );
  }
  return obligation;
}

async function planTelegramDeliveryIntent({ agencyId, member, orderId, kind, clientIntentId = null, reference = null, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("TELEGRAM_DELIVERY_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedKind = clean(kind, 40).toUpperCase();
  if (!KIND_SET.has(normalizedKind) || normalizedKind === "AUTO_REMINDER" || normalizedKind === "REVISION_REQUEST") throw fail("TELEGRAM_DELIVERY_KIND_INVALID", "Unsupported user-planned Telegram delivery kind");
  const order = await loadOrder({ agencyId, orderId, db: client });
  await requireCreatorAccess({ agencyId, member, creatorId: order.creatorId, db: client });
  const status = String(order.status || "PENDING").toUpperCase();
  let binding = null; let accountId = null;
  let identity = "one"; let normalizedClientIntentId = null; let referenceOrdinal = null; let payload; let reactivateCancelledTask = false;
  if (normalizedKind === "TASK") {
    if (status !== "PENDING") throw fail("CUSTOM_ORDER_TELEGRAM_TASK_STATE_INVALID", "A new Telegram task can only be delivered for a pending custom order", 409);
    const obligation = await assertInitialTaskDispatchCurrent({ agencyId, order, allowMissing: true, allowCancelled: true, allowAnyInitialState: true, db: client });
    reactivateCancelledTask = String(obligation?.deliveryState || "") === "CANCELLED";
    binding = await resolveIntentProviderBinding({ agencyId, order, kind: normalizedKind, db: client });
    accountId = String(binding.accountId);
    payload = taskPayload(order);
  } else if (normalizedKind === "CANCELLATION") {
    if (status !== "CANCELLED") throw fail("CUSTOM_ORDER_TELEGRAM_STATUS_INVALID", "Cancellation delivery requires a cancelled custom order", 409);
    try {
      binding = await resolveIntentProviderBinding({ agencyId, order, kind: normalizedKind, db: client });
    } catch (error) {
      if (String(error?.code || "") === "CUSTOM_CANCELLATION_MODEL_INSTRUCTION_NOT_DELIVERED") {
        return { ok: true, skipped: true, reason: "MODEL_INSTRUCTION_NOT_DELIVERED", intent: null };
      }
      throw error;
    }
    accountId = String(binding.accountId);
    payload = { text: cancellationText(order), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  } else if (normalizedKind === "MANUAL_REMINDER") {
    if (status !== "PENDING") throw fail("CUSTOM_ORDER_REMINDER_STATE_INVALID", "Only pending custom orders can be reminded", 409);
    const unresolvedReminder = await findUnresolvedReminder({ agencyId, orderId: order.id, db: client });
    if (unresolvedReminder) throw fail("CUSTOM_ORDER_REMINDER_OUTCOME_UNRESOLVED", "A previous reminder outcome is unresolved and must be reconciled before another reminder can be sent", 409);
    binding = await resolveIntentProviderBinding({ agencyId, order, kind: normalizedKind, db: client }); accountId = String(binding.accountId);
    normalizedClientIntentId = uuid(clientIntentId);
    identity = normalizedClientIntentId;
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
    const cycle = clean(binding.cycleId, 260) || `TASK:${clean(binding.replyToDeliveryId, 180)}`;
    const reminderKey = String(order.type || "CONTENT").toUpperCase() === "CONTENT" ? `CONTENT:${cycle}:MANUAL:${normalizedClientIntentId}` : `MANUAL:${normalizedClientIntentId}`;
    payload = { text: reminderText(order, order.creator, workspacePolicy, now), replyToDeliveryId: binding.replyToDeliveryId || null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId, reminderKey };
  } else {
    if (status !== "PENDING") throw fail("CUSTOM_ORDER_REFERENCE_STATE_INVALID", "References can only be delivered for a pending custom order", 409);
    binding = await resolveIntentProviderBinding({ agencyId, order, kind: normalizedKind, db: client }); accountId = String(binding.accountId);
    normalizedClientIntentId = uuid(clientIntentId);
    const ref = reference && typeof reference === "object" ? reference : {};
    referenceOrdinal = Math.max(0, Math.floor(Number(ref.ordinal) || 0));
    identity = `slot:${referenceOrdinal}`;
    const name = clean(ref.name, 500); const sha256Value = clean(ref.sha256, 64).toLowerCase(); const size = Number(ref.size);
    if (!name || !/^[0-9a-f]{64}$/.test(sha256Value) || !Number.isSafeInteger(size) || size < 0) throw fail("CUSTOM_ORDER_REFERENCE_PROOF_REQUIRED", "Reference name, size and sha256 are required");
    payload = { reference: { name, size, sha256: sha256Value }, replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  }
  const reserved = await createOrReadIntent({
    agencyId, order, accountId: String(accountId), kind: normalizedKind, identity, clientIntentId: normalizedClientIntentId, referenceOrdinal, payload, now, db: client,
    reactivateCancelledTask,
    actorMember: member,
  });
  if (reserved.created) await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.telegram_delivery_plan", targetType: "TelegramDeliveryIntent", targetId: reserved.row.id, metadata: { orderId: order.id, creatorId: order.creatorId, kind: normalizedKind }, db: client });
  return { ok: true, skipped: false, created: reserved.created, intent: publicIntent(reserved.row) };
}

async function ensureAutomaticReminderIntentForOrder({ agencyId, orderId = null, order: providedOrder = null, member = null, now = new Date(), db } = {}) {
  const scope = member?.id ? await allowedCreatorScope({ agencyId, member, db }) : { broad: true, creatorIds: [] };
  let order = providedOrder;
  if (!order) {
    const id = clean(orderId, 180);
    if (!id) throw fail("CUSTOM_REMINDER_ORDER_REQUIRED", "Custom order is required");
    order = await db.customOrder.findFirst({
      where: { agencyId, id, ...scopeWhere(scope), status: "PENDING" },
      include: { creator: { select: { id: true, displayName: true, username: true, telegramContact: true, telegramUserId: true, telegramAccountId: true } } },
    });
  } else if (!scope.broad && !scope.creatorIds.map(String).includes(String(order.creatorId))) {
    return { ok: true, planned: 0, stale: true, reason: "CREATOR_SCOPE_CHANGED" };
  }
  if (!order || String(order.status || "") !== "PENDING") return { ok: true, planned: 0, stale: true, reason: "ORDER_NOT_PENDING" };
  if (!order.nextReminderAt || new Date(order.nextReminderAt).getTime() > now.getTime()) return { ok: true, planned: 0, stale: true, reason: "REMINDER_NOT_DUE" };
  const unresolved = await findUnresolvedReminder({ agencyId, orderId: order.id, db });
  if (unresolved) return { ok: true, planned: 0, blocked: true, blockedCode: "CUSTOM_ORDER_REMINDER_OUTCOME_UNRESOLVED", unresolved: true };

  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
  let binding;
  try {
    binding = await resolveReminderProviderBinding({ agencyId, order, db });
  } catch (error) {
    const code = String(error?.code || "");
    if (["TELEGRAM_DELIVERY_TASK_THREAD_REQUIRED", "TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN", "CUSTOM_MODEL_OBLIGATION_NOT_WAITING_RESPONSE"].includes(code)) {
      await reprojectCustomReminderSchedule({ agencyId, orderId: order.id, now, db });
      return { ok: true, planned: 0, stale: true, reason: code };
    }
    if (["CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING"].includes(code)) {
      return { ok: true, planned: 0, blocked: true, blockedCode: code, accountId: order?.creator?.telegramAccountId ? String(order.creator.telegramAccountId) : null };
    }
    throw error;
  }

  const due = desiredReminderSchedule(order, workspacePolicy, now, { modelObligation: binding.obligation || null });
  const reminderKey = clean(due.key, 500);
  if (!reminderKey || (due.at && due.at.getTime() > now.getTime())) {
    await reprojectCustomReminderSchedule({ agencyId, orderId: order.id, now, db });
    return { ok: true, planned: 0, stale: true, reason: "REMINDER_IDENTITY_CHANGED" };
  }
  const payload = {
    text: reminderText(order, order.creator, workspacePolicy, now),
    replyToDeliveryId: binding.replyToDeliveryId || null,
    replyToMessageId: binding.replyToMessageId,
    recipientTelegramUserId: binding.recipientTelegramUserId,
    reminderKey,
  };
  try {
    const reserved = await createOrReadIntent({ agencyId, order, accountId: String(binding.accountId), kind: "AUTO_REMINDER", identity: sha256(reminderKey).slice(0, 32), payload, now, db });
    const reservedState = String(reserved?.row?.state || "");
    const executable = ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(reservedState) && reserved?.row?.commitStartedAt == null;
    return { ok: true, planned: executable ? 1 : 0, created: Boolean(reserved?.created), reminderKey, intent: reserved?.row || null };
  } catch (error) {
    const code = String(error?.code || "");
    if (["CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING"].includes(code)) {
      return { ok: true, planned: 0, blocked: true, blockedCode: code, accountId: order?.creator?.telegramAccountId ? String(order.creator.telegramAccountId) : null };
    }
    throw error;
  }
}

async function ensureAutomaticReminderIntents({ agencyId, member = null, limit = 25, now = new Date(), db }) {
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
  const scope = member?.id ? await allowedCreatorScope({ agencyId, member, db }) : { broad: true, creatorIds: [] };
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
  const report = { scanned: 0, planned: 0, currentBacklog: false };
  const candidateBudget = Math.min(500, Math.max(take + 1, take * 10));
  let rows = [];

  if (typeof db?.$queryRawUnsafe === "function") {
    const params = [String(agencyId), now];
    let scopeSql = "";
    if (!scope.broad) {
      params.push((scope.creatorIds || []).map(String));
      scopeSql = ` AND co."creatorId" = ANY($${params.length}::text[])`;
    }
    const ids = await db.$queryRawUnsafe(
      `SELECT co."id"
         FROM "CustomOrder" co
        WHERE co."agencyId"=$1
          AND co."status"='PENDING'
          AND co."nextReminderAt" IS NOT NULL
          AND co."nextReminderAt" <= $2
          ${scopeSql}
          AND EXISTS (
            SELECT 1 FROM "ProviderOperationalDebt" pod
             WHERE pod."agencyId"=co."agencyId"
               AND pod."customOrderId"=co."id"
               AND pod."debtClass"='CURRENT_PROVIDER_THREAD_CAPABILITY'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "TelegramDeliveryIntent" ti
             WHERE ti."agencyId"=co."agencyId"
               AND ti."customOrderId"=co."id"
               AND ti."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER')
               AND ti."state" IN ('PLANNED','CLAIMED','COMMITTING','RECONCILE_REQUIRED','FAILED_PRECOMMIT')
          )
        ORDER BY co."nextReminderAt" ASC, co."id" ASC
        LIMIT ${candidateBudget + 1}`,
      ...params,
    );
    report.currentBacklog = (ids || []).length > candidateBudget;
    const wanted = (ids || []).slice(0, candidateBudget).map((row) => String(row.id));
    if (wanted.length) {
      const loaded = await db.customOrder.findMany({
        where: { agencyId, id: { in: wanted } },
        include: { creator: { select: { id: true, displayName: true, username: true, telegramContact: true, telegramUserId: true, telegramAccountId: true } } },
      });
      const byId = new Map((loaded || []).map((row) => [String(row.id), row]));
      rows = wanted.map((id) => byId.get(id)).filter(Boolean);
    }
  } else {
    // Reduced unit-test doubles do not expose raw SQL. Keep their compatibility path bounded;
    // production always uses the indexed NOT-EXISTS workset above.
    const candidateTake = candidateBudget + 1;
    const candidates = await db.customOrder.findMany({
      where: { agencyId, ...scopeWhere(scope), status: "PENDING", nextReminderAt: { lte: now } },
      include: { creator: { select: { id: true, displayName: true, username: true, telegramContact: true, telegramUserId: true, telegramAccountId: true } } },
      orderBy: [{ nextReminderAt: "asc" }, { id: "asc" }],
      take: candidateTake,
    });
    for (const order of candidates || []) {
      if (rows.length > candidateBudget) break;
      const unresolved = await findUnresolvedReminder({ agencyId, orderId: order.id, db });
      if (!unresolved) rows.push(order);
    }
    report.currentBacklog = rows.length > candidateBudget || (candidates || []).length >= candidateTake;
    rows = rows.slice(0, candidateBudget);
  }

  for (const order of rows) {
    if (report.planned >= take) { report.currentBacklog = true; break; }
    report.scanned += 1;
    const result = await ensureAutomaticReminderIntentForOrder({ agencyId, order, member, now, db });
    report.planned += Number(result?.planned || 0);
    if (result?.blocked) report.currentBacklog = true;
  }
  return report;
}

async function terminalizeLegacyOrphanPrecommitIntent({ row, agencyId, now = new Date(), db }) {
  if (!row || !["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(row.state)) || row.commitStartedAt != null) return row;
  const changed = await db.telegramDeliveryIntent.updateMany({
    where: {
      id: row.id,
      agencyId,
      state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] },
      claimRevision: Number(row.claimRevision || 0),
      commitStartedAt: null,
    },
    data: {
      state: "CANCELLED",
      deviceId: null,
      userId: null,
      memberId: null,
      accessEpoch: null,
      claimTokenHash: null,
      claimUntil: null,
      claimRevision: Number(row.claimRevision || 0) + 1,
      outcomeReason: "LEGACY_ORPHAN_CUSTOM_ORDER_PRECOMMIT",
      updatedAt: now,
    },
  });
  if (Number(changed?.count || 0) !== 1) return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
}


function revisionDecisionFingerprint({ submissionId, customOrderId, reviewComment, reviewedAt } = {}) {
  const reviewed = reviewedAt ? new Date(reviewedAt) : null;
  if (!clean(submissionId, 180) || !clean(customOrderId, 180) || !clean(reviewComment, 4000) || !reviewed || !Number.isFinite(reviewed.getTime())) return null;
  return sha256(stableJson({ submissionId: clean(submissionId, 180), customOrderId: clean(customOrderId, 180), reviewComment: clean(reviewComment, 4000), reviewedAt: reviewed.toISOString() }));
}

function revisionRequestText({ revisionNumber = null, reviewComment } = {}) {
  const version = Number.isInteger(Number(revisionNumber)) && Number(revisionNumber) > 0 ? `\nВерсия: ${Number(revisionNumber)}` : "";
  return `♻️ Нужна доработка кастома${version}\n\nЧто исправить:\n«${clean(reviewComment, 3500)}»\n\nПришли исправленную версию ответом сюда.`.slice(0, 4096);
}

async function loadRevisionRequestDecision({ agencyId, customSubmissionId, customOrderId, db }) {
  const submission = await db.customContentSubmission.findFirst({
    where: { id: clean(customSubmissionId, 180), agencyId, customOrderId: clean(customOrderId, 180) },
    select: { id: true, creatorId: true, customOrderId: true, pipelineDisposition: true, reviewStatus: true, reviewComment: true, reviewedAt: true, receivedAt: true, createdAt: true, telegramSourceAccountId: true, telegramSourceUserId: true, telegramMessageIds: true },
  });
  if (!submission) throw fail("TELEGRAM_REVISION_SUBMISSION_NOT_FOUND", "Revision submission no longer exists", 409);
  if (String(submission.pipelineDisposition || "ACTIVE") !== "ACTIVE" || String(submission.reviewStatus || "") !== "REVISION_REQUESTED" || !submission.reviewComment || !submission.reviewedAt) {
    throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "Revision decision is no longer current", 409);
  }
  const latest = await db.customContentSubmission.findFirst({
    where: { agencyId, creatorId: submission.creatorId, customOrderId: submission.customOrderId },
    select: { id: true },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  if (!latest || String(latest.id) !== String(submission.id)) throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "A newer Custom submission already exists; this revision instruction is stale", 409);
  const fingerprint = revisionDecisionFingerprint({ submissionId: submission.id, customOrderId: submission.customOrderId, reviewComment: submission.reviewComment, reviewedAt: submission.reviewedAt });
  return { submission, fingerprint };
}

async function planRevisionRequestIntentForReviewedSubmission({ agencyId, member = null, submission, order, revisionNumber = null, now = new Date(), db }) {
  if (!submission?.id || !order?.id) throw fail("TELEGRAM_REVISION_DECISION_REQUIRED", "Exact reviewed submission and Custom order are required", 409);
  if (String(order.status || "") !== "PENDING" || String(order.type || "") !== "CONTENT" || order.fanDeliveredAt) throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "Revision request requires a pending CONTENT Custom", 409);
  const decision = await loadRevisionRequestDecision({ agencyId, customSubmissionId: submission.id, customOrderId: order.id, db });
  const binding = await resolveRevisionProviderBinding({ agencyId, orderId: order.id, submission: decision.submission, db });
  const payload = {
    text: revisionRequestText({ revisionNumber, reviewComment: decision.submission.reviewComment }),
    replyToDeliveryId: binding.replyToDeliveryId || null,
    replyToMessageId: binding.replyToMessageId,
    recipientTelegramUserId: binding.recipientTelegramUserId,
    customSubmissionId: String(decision.submission.id),
    reviewDecisionFingerprint: decision.fingerprint,
    reviewComment: String(decision.submission.reviewComment),
    reviewedAt: new Date(decision.submission.reviewedAt).toISOString(),
  };
  const reserved = await createOrReadIntent({
    agencyId, order, accountId: binding.accountId, kind: "REVISION_REQUEST", identity: `submission:${decision.submission.id}`,
    customSubmissionId: String(decision.submission.id), payload, now, db,
  });
  if (reserved.created) await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_content_submission.telegram_revision_plan", targetType: "TelegramDeliveryIntent", targetId: reserved.row.id, metadata: { orderId: order.id, creatorId: order.creatorId, submissionId: decision.submission.id }, db });
  return reserved.row;
}

async function refreshPrecommitIntentFromCurrentState({ row, agencyId, now = new Date(), db }) {
  if (!row || !["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(row.state)) || row.commitStartedAt != null) return row;
  let order;
  try {
    order = await loadOrder({ agencyId, orderId: row.customOrderId, db });
  } catch (error) {
    if (String(error?.code || "") === "CUSTOM_ORDER_NOT_FOUND") {
      // Historical hard-delete versions could leave TelegramDeliveryIntent without its
      // CustomOrder because the provider ledger intentionally has no FK.  A proven-precommit
      // orphan has no external outcome, so terminalize the same durable row instead of letting
      // one poisoned oldest intent abort every subsequent work-discovery request.
      return terminalizeLegacyOrphanPrecommitIntent({ row, agencyId, now, db });
    }
    throw error;
  }
  const kind = String(row.kind);
  const status = String(order.status || "PENDING").toUpperCase();

  // Business-state invalidation is a real cancellation of this precommit delivery.
  if ((kind === "CANCELLATION" && status !== "CANCELLED") || (kind !== "CANCELLATION" && status !== "PENDING")) {
    await db.telegramDeliveryIntent.updateMany({
      where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
      data: { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: "PRECOMMIT_BUSINESS_STATE_CHANGED" },
    });
    return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  }

  if (kind === "TASK") {
    try {
      await assertInitialTaskDispatchCurrent({ agencyId, order, intentId: row.id, db });
    } catch (error) {
      if (String(error?.code || "") === "CUSTOM_MODEL_INITIAL_INSTRUCTION_NOT_REQUIRED") {
        await db.telegramDeliveryIntent.updateMany({
          where: { id: row.id, agencyId, kind: "TASK", state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
          data: {
            state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null,
            claimTokenHash: null, claimUntil: null, claimRevision: Number(row.claimRevision || 0) + 1,
            outcomeReason: "INITIAL_MODEL_OBLIGATION_SATISFIED",
          },
        });
        return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
      }
      throw error;
    }
  }

  let binding; let accountId;
  try { binding = await resolveIntentProviderBinding({ agencyId, order, kind, customSubmissionId: row.customSubmissionId || null, db }); accountId = String(binding.accountId); }
  catch (error) {
    if (REMINDER_KINDS.has(kind) && String(error?.code || "") === "CUSTOM_MODEL_OBLIGATION_NOT_WAITING_RESPONSE") {
      await db.telegramDeliveryIntent.updateMany({
        where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
        data: { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, claimRevision: Number(row.claimRevision || 0) + 1, outcomeReason: "MODEL_OBLIGATION_SATISFIED" },
      });
      return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    }
    if (kind === "REFERENCE" && String(error?.code || "") === "CUSTOM_MODEL_INITIAL_OBLIGATION_NOT_WAITING_RESPONSE") {
      await db.telegramDeliveryIntent.updateMany({
        where: { id: row.id, agencyId, kind: "REFERENCE", state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
        data: { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, claimRevision: Number(row.claimRevision || 0) + 1, outcomeReason: "INITIAL_MODEL_OBLIGATION_SATISFIED" },
      });
      return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    }
    // Missing/reassigned provider binding is not a remote effect and must not destroy D1.
    // Keep it durable but do not expose the stale account to Desktop execution.
    const providerBindingRepairAttempts = Math.max(0, Math.floor(Number(row.providerBindingRepairAttempts) || 0)) + 1;
    const providerBindingRetryAt = new Date(now.getTime() + providerBindingRepairDelayMs(providerBindingRepairAttempts));
    await db.telegramDeliveryIntent.updateMany({
      where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
      data: {
        state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null,
        outcomeReason: `${PRECOMMIT_PROVIDER_UNAVAILABLE_PREFIX}${clean(error?.code || error?.message, 300)}`,
        providerBindingRepairAttempts, providerBindingRetryAt,
      },
    });
    return null;
  }

  let identity = "one"; let clientIntentId = row.clientIntentId || null; let referenceOrdinal = row.referenceOrdinal == null ? null : Number(row.referenceOrdinal); let customSubmissionId = row.customSubmissionId || null; let payload;
  if (kind === "TASK") {
    payload = taskPayload(order);
  } else if (kind === "CANCELLATION") {
    payload = { text: cancellationText(order), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  } else if (kind === "MANUAL_REMINDER") {
    if (!clientIntentId) return null;
    identity = String(clientIntentId);
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
    const cycle = clean(binding.cycleId, 260) || `TASK:${clean(binding.replyToDeliveryId, 180)}`;
    const contentReminder = String(order.type || "CONTENT").toUpperCase() === "CONTENT";
    const fallbackKey = contentReminder ? `CONTENT:${cycle}:MANUAL:${clientIntentId}` : `MANUAL:${clientIntentId}`;
    const plannedKey = clean(row.payload?.reminderKey, 500);
    const plannedReplyToDeliveryId = clean(row.payload?.replyToDeliveryId, 180);
    const currentReplyToDeliveryId = clean(binding.replyToDeliveryId, 180);
    if (contentReminder && (
      (plannedKey && plannedKey !== fallbackKey)
      || (!plannedKey && (!plannedReplyToDeliveryId || plannedReplyToDeliveryId !== currentReplyToDeliveryId))
    )) {
      await db.telegramDeliveryIntent.updateMany({
        where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
        data: {
          state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null,
          claimTokenHash: null, claimUntil: null, claimRevision: Number(row.claimRevision || 0) + 1,
          outcomeReason: "MODEL_OBLIGATION_CYCLE_CHANGED",
        },
      });
      return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    }
    const reminderKey = plannedKey || fallbackKey;
    payload = { text: reminderText(order, order.creator, workspacePolicy, now), replyToDeliveryId: binding.replyToDeliveryId || null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId, reminderKey };
  } else if (kind === "REFERENCE") {
    if (!clientIntentId || !row.payload?.reference || !Number.isInteger(Number(referenceOrdinal))) return null;
    identity = `slot:${Number(referenceOrdinal)}`;
    payload = { reference: row.payload.reference, replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  } else if (kind === "REVISION_REQUEST") {
    if (!row.customSubmissionId) return null;
    let decision;
    try { decision = await loadRevisionRequestDecision({ agencyId, customSubmissionId: row.customSubmissionId, customOrderId: order.id, db }); }
    catch (error) {
      if (String(error?.code || "") === "TELEGRAM_DELIVERY_CONTROL_CHANGED" || String(error?.code || "") === "TELEGRAM_REVISION_SUBMISSION_NOT_FOUND") {
        await db.telegramDeliveryIntent.updateMany({
          where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
          data: { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: "REVISION_DECISION_CHANGED" },
        });
        return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
      }
      throw error;
    }
    identity = `submission:${decision.submission.id}`;
    payload = {
      text: revisionRequestText({ revisionNumber: row.payload?.revisionNumber || null, reviewComment: decision.submission.reviewComment }),
      replyToDeliveryId: binding.replyToDeliveryId || null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId,
      customSubmissionId: String(decision.submission.id), reviewDecisionFingerprint: decision.fingerprint,
      reviewComment: String(decision.submission.reviewComment), reviewedAt: new Date(decision.submission.reviewedAt).toISOString(),
      ...(row.payload?.revisionNumber ? { revisionNumber: Number(row.payload.revisionNumber) } : {}),
    };
    customSubmissionId = String(decision.submission.id);
  } else if (kind === "AUTO_REMINDER") {
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
    const due = desiredReminderSchedule(order, workspacePolicy, now, { modelObligation: binding.obligation || null });
    const plannedKey = clean(row.payload?.reminderKey, 500);
    if (!plannedKey || due.key !== plannedKey || (due.at && due.at.getTime() > now.getTime())) {
      await db.telegramDeliveryIntent.updateMany({
        where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
        data: { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: "AUTO_REMINDER_POLICY_CHANGED" },
      });
      return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    }
    identity = sha256(plannedKey).slice(0, 32);
    payload = { text: reminderText(order, order.creator, workspacePolicy, now), replyToDeliveryId: binding.replyToDeliveryId || null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId, reminderKey: plannedKey };
  } else {
    return row;
  }

  const reserved = await createOrReadIntent({ agencyId, order, accountId: String(accountId), kind, identity, clientIntentId, referenceOrdinal, customSubmissionId, payload, now, db });
  return reserved.row;
}


function initialTaskNeedsConvergence(obligation) {
  const state = String(obligation?.state || "");
  if (state === "NO_INSTRUCTION") return true;
  return state === "INITIAL_DISPATCH_PENDING" && String(obligation?.deliveryState || "") === "CANCELLED";
}

async function ensureInitialTaskIntentForOrder({ agencyId, orderId, member = null, now = new Date(), db }) {
  const snapshot = await loadOrder({ agencyId, orderId, db });
  if (String(snapshot.status || "PENDING").toUpperCase() !== "PENDING" || !["CONTENT", "CALL", "PHYSICAL"].includes(String(snapshot.type || "CONTENT").toUpperCase())) {
    return { changed: false, reason: "ORDER_NOT_PENDING_SUPPORTED_CUSTOM", intent: null };
  }
  const before = await deriveCustomInitialInstruction({ agencyId, order: snapshot, db });
  if (!initialTaskNeedsConvergence(before)) return { changed: false, reason: before.state || "OBLIGATION_ALREADY_CONVERGED", intent: null };
  if (!clean(snapshot.creator?.telegramContact, 160)) return { changed: false, blocked: true, reason: "CUSTOM_ORDER_TELEGRAM_CONTACT_REQUIRED", intent: null };
  try {
    await resolveAccountForOrder({ agencyId, order: snapshot, db });
  } catch (error) {
    return { changed: false, blocked: true, reason: clean(error?.code, 120) || "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", intent: null };
  }

  const run = async (tx) => {
    // Keep the global lock order identical to every other Custom mutation:
    // Agency -> Creator -> CustomOrder causal fence -> Telegram account.
    await lockAgencyPipelineLifecycle({ db: tx, agencyId });
    await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId: snapshot.creatorId });
    const fence = await fenceCustomModelObligationTransition({ agencyId, orderId: snapshot.id, now, db: tx });
    if (fence.missing) return { changed: false, reason: "ORDER_MISSING", intent: null };
    const current = await loadOrder({ agencyId, orderId: snapshot.id, db: tx });
    const obligation = await deriveCustomInitialInstruction({ agencyId, order: current, db: tx });
    if (!initialTaskNeedsConvergence(obligation)) {
      return { changed: false, reason: obligation.state || "OBLIGATION_CHANGED", intent: null };
    }
    const previousIntentId = obligation.instructionIntentId ? String(obligation.instructionIntentId) : null;
    const previousState = String(obligation.deliveryState || "");
    const intent = await planTaskIntentForCommittedOrder({
      agencyId, member, order: current, now, db: tx,
      reactivateCancelled: previousState === "CANCELLED",
    });
    const changed = Boolean(intent) && (
      !previousIntentId
      || String(intent.id) !== previousIntentId
      || String(intent.state || "") !== previousState
    );
    return {
      changed,
      created: Boolean(intent && !previousIntentId),
      reactivated: Boolean(intent && previousIntentId && String(intent.id) === previousIntentId && previousState === "CANCELLED" && String(intent.state) === "PLANNED"),
      reason: intent ? "INITIAL_TASK_CONVERGED" : "INITIAL_TASK_PROVIDER_BINDING_UNAVAILABLE",
      intent,
    };
  };
  return typeof db?.$transaction === "function"
    ? db.$transaction(run, { isolationLevel: "Serializable" })
    : run(db);
}

async function repairPrecommitProviderBlockedIntents({ agencyId, member = null, limit = 25, now = new Date(), db }) {
  if (!db?.telegramDeliveryIntent?.findMany) return { attempted: 0, recovered: 0, stillBlocked: 0 };
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
  const scope = member?.id ? await allowedCreatorScope({ agencyId, member, db }) : { broad: true, creatorIds: [] };
  const legacyRetryBefore = new Date(now.getTime() - PROVIDER_BLOCK_RETRY_BASE_MS);
  const rows = await db.telegramDeliveryIntent.findMany({
    where: {
      agencyId, ...scopeWhere(scope), state: "PLANNED", commitStartedAt: null,
      outcomeReason: { startsWith: PRECOMMIT_PROVIDER_UNAVAILABLE_PREFIX },
      OR: [
        { providerBindingRetryAt: { lte: now } },
        { providerBindingRetryAt: null, updatedAt: { lte: legacyRetryBefore } },
      ],
    },
    orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take,
  });
  const report = { attempted: 0, recovered: 0, stillBlocked: 0 };
  for (const row of rows || []) {
    report.attempted += 1;
    const current = await refreshPrecommitIntentFromCurrentState({ row, agencyId, now, db });
    if (current && !isPrecommitProviderBlocked(current)) report.recovered += 1;
    else report.stillBlocked += 1;
  }
  return report;
}

async function listTelegramDeliveryWork({ agencyId, member, limit = 25, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("TELEGRAM_DELIVERY_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
  const staleCommitBefore = new Date(now.getTime() - CLAIM_MS);
  await client.telegramDeliveryIntent.updateMany({
    where: { agencyId, ...scopeWhere(scope), state: "COMMITTING", commitStartedAt: { lte: staleCommitBefore } },
    data: { state: "RECONCILE_REQUIRED", outcomeReason: "COMMIT_PROCESS_LOST" },
  });

  // R9/R6: work discovery is a locator, not an archaeological filter. Read at most the
  // caller's executable budget and revalidate every returned target at claim/begin time.
  // Stale precommit rows are repaired/cancelled here only inside that same finite budget;
  // we never keep paging through the tenant just to fill `limit`.
  const scanBudget = Math.min(200, Math.max(25, take * 4));
  const rows = await client.telegramDeliveryIntent.findMany({
    where: {
      agencyId, ...scopeWhere(scope), state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] },
      NOT: { state: "PLANNED", commitStartedAt: null, outcomeReason: { startsWith: PRECOMMIT_PROVIDER_UNAVAILABLE_PREFIX } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: scanBudget,
  });
  const items = [];
  let scannedRows = 0;
  for (const snapshot of rows || []) {
    scannedRows += 1;
    let current = snapshot;
    if (["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(snapshot.state)) && snapshot.commitStartedAt == null) {
      current = await refreshPrecommitIntentFromCurrentState({ row: snapshot, agencyId, now, db: client });
    }
    if (!current || String(current.state) === "CANCELLED") continue;
    items.push(publicIntent(current));
    if (items.length >= take) break;
  }
  return {
    ok: true,
    items,
    scannedRows,
    scanBudget,
    scanComplete: Number(rows?.length || 0) < scanBudget || scannedRows < scanBudget,
    serverNow: now.toISOString(),
  };
}

async function claimTelegramDeliveryIntent({ agencyId, member, intentId, deviceId, runtimeClaimToken, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const id = clean(intentId, 180); const normalizedDeviceId = clean(deviceId, 180);
  if (!id || !normalizedDeviceId) throw fail("TELEGRAM_DELIVERY_CLAIM_INPUT_INVALID", "intentId and deviceId are required");
  let row = await client.telegramDeliveryIntent.findFirst({ where: { id, agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  if (["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(row.state)) && row.commitStartedAt == null) {
    const refreshed = await refreshPrecommitIntentFromCurrentState({ row, agencyId, now, db: client });
    if (refreshed) row = refreshed;
    else {
      const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id, agencyId } });
      return { ok: true, claimed: false, busy: false, intent: publicIntent(fresh), claimToken: null };
    }
  }
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  await assertTelegramRuntimeLease({ agencyId, member, accountId: row.accountId, deviceId: normalizedDeviceId, claimToken: runtimeClaimToken, now, db: client });
  const fence = actor(member);
  await assertExecutionAccessFence({ db: client, agencyId, creatorId: row.creatorId, ...fence, lock: true });
  if (row.state === "CONFIRMED" || row.state === "RECONCILE_REQUIRED" || row.state === "COMMITTING" || row.state === "CANCELLED") return { ok: true, claimed: false, intent: publicIntent(row), claimToken: null };
  if (String(row.kind) === "REFERENCE" && Number.isInteger(Number(row.referenceOrdinal)) && Number(row.referenceOrdinal) > 0) {
    // Preserve reference ordering across crashes: a later file may be planned durably, but it cannot
    // receive a physical commit permit while an earlier reference is unresolved/not confirmed.
    const predecessor = await client.telegramDeliveryIntent.findFirst({
      where: { agencyId, customOrderId: row.customOrderId, kind: "REFERENCE", referenceOrdinal: { lt: Number(row.referenceOrdinal) }, state: { in: UNRESOLVED_REFERENCE_STATES } },
      orderBy: [{ referenceOrdinal: "asc" }, { createdAt: "asc" }],
    });
    if (predecessor) return { ok: true, claimed: false, busy: true, blockedByIntentId: String(predecessor.id), intent: publicIntent(row), claimToken: null };
  }
  if (REMINDER_KINDS.has(String(row.kind))) {
    const unresolvedReminder = await findUnresolvedReminder({ agencyId, orderId: row.customOrderId, excludeIntentId: row.id, db: client });
    if (unresolvedReminder) return { ok: true, claimed: false, busy: true, blockedByIntentId: String(unresolvedReminder.id), intent: publicIntent(row), claimToken: null };
  }
  const currentClaimAlive = row.state === "CLAIMED" && row.claimUntil && new Date(row.claimUntil).getTime() > now.getTime();
  if (currentClaimAlive && String(row.deviceId || "") !== normalizedDeviceId) return { ok: true, claimed: false, busy: true, intent: publicIntent(row), claimToken: null };
  const claimToken = crypto.randomUUID(); const claimUntil = new Date(now.getTime() + CLAIM_MS); const nextRevision = Number(row.claimRevision || 0) + 1;
  const changed = await client.telegramDeliveryIntent.updateMany({
    where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), ...(row.state === "CLAIMED" && row.claimUntil ? { claimUntil: row.claimUntil } : {}) },
    data: { state: "CLAIMED", deviceId: normalizedDeviceId, userId: fence.userId, memberId: fence.memberId, accessEpoch: fence.accessEpoch, claimTokenHash: tokenHash(claimToken), claimRevision: nextRevision, claimUntil, outcomeReason: null },
  });
  if (Number(changed?.count || 0) !== 1) {
    const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    return { ok: true, claimed: false, busy: fresh?.state === "CLAIMED", intent: publicIntent(fresh), claimToken: null };
  }
  const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  return { ok: true, claimed: true, intent: publicIntent(fresh), claimToken };
}

function verifyStoredClaim(row, { deviceId, claimToken }) {
  if (!row || row.state !== "CLAIMED" || !row.claimTokenHash || tokenHash(claimToken) !== String(row.claimTokenHash) || String(row.deviceId || "") !== clean(deviceId, 180)) {
    throw fail("TELEGRAM_DELIVERY_CLAIM_STALE", "Telegram delivery claim is no longer valid", 409);
  }
}
function verifyCommitClaim(row, { deviceId, claimToken }) {
  if (!row || !["COMMITTING", "RECONCILE_REQUIRED"].includes(String(row.state)) || !row.claimTokenHash || tokenHash(claimToken) !== String(row.claimTokenHash) || String(row.deviceId || "") !== clean(deviceId, 180)) {
    throw fail("TELEGRAM_DELIVERY_COMMIT_LEASE_STALE", "Telegram delivery commit lease is no longer valid", 409);
  }
}

async function currentBeginGuard({ row, member, agencyId, runtimeClaimToken, deviceId, now, db }) {
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db });
  const order = await loadOrder({ agencyId, orderId: row.customOrderId, db });
  if (String(row.kind) === "TASK") {
    try {
      await assertInitialTaskDispatchCurrent({ agencyId, order, intentId: row.id, db });
    } catch (error) {
      if (String(error?.code || "") === "CUSTOM_MODEL_INITIAL_INSTRUCTION_NOT_REQUIRED") {
        throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "The initial model obligation was satisfied before TASK commit", 409);
      }
      throw error;
    }
  }
  let binding;
  try {
    binding = await resolveIntentProviderBinding({ agencyId, order, kind: String(row.kind), customSubmissionId: row.customSubmissionId || null, db });
  } catch (error) {
    if (REMINDER_KINDS.has(String(row.kind)) && String(error?.code || "") === "CUSTOM_MODEL_OBLIGATION_NOT_WAITING_RESPONSE") {
      throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "The model obligation was satisfied or changed before reminder commit", 409);
    }
    if (String(row.kind) === "REFERENCE" && String(error?.code || "") === "CUSTOM_MODEL_INITIAL_OBLIGATION_NOT_WAITING_RESPONSE") {
      throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "The initial model obligation was satisfied before reference commit", 409);
    }
    throw error;
  }
  if (String(binding.accountId) !== String(row.accountId)) {
    throw fail("TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED", "Telegram provider thread changed before commit; refresh the existing delivery intent", 409);
  }
  if (String(row.kind) !== "TASK") {
    const expectedReply = clean(binding.replyToMessageId, 40);
    const expectedRecipient = clean(binding.recipientTelegramUserId, 40);
    if (clean(row.payload?.replyToMessageId, 40) !== expectedReply || clean(row.payload?.recipientTelegramUserId, 40) !== expectedRecipient) {
      throw fail("TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED", "Telegram provider thread changed before commit; refresh the existing delivery intent", 409);
    }
  }
  await assertTelegramRuntimeLease({ agencyId, member, accountId: row.accountId, deviceId, claimToken: runtimeClaimToken, now, db });
  await assertExecutionAccessFence({ db, agencyId, creatorId: row.creatorId, userId: row.userId, memberId: row.memberId, accessEpoch: row.accessEpoch, lock: true });
  const kind = String(row.kind);
  if (kind === "REVISION_REQUEST") {
    const decision = await loadRevisionRequestDecision({ agencyId, customSubmissionId: row.customSubmissionId, customOrderId: order.id, db });
    if (clean(row.payload?.reviewDecisionFingerprint, 128) !== decision.fingerprint
        || clean(row.payload?.reviewComment, 4000) !== clean(decision.submission.reviewComment, 4000)
        || clean(row.payload?.reviewedAt, 80) !== new Date(decision.submission.reviewedAt).toISOString()) {
      throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "Revision review decision changed before Telegram commit", 409);
    }
  }
  if (REMINDER_KINDS.has(kind)) {
    const unresolvedReminder = await findUnresolvedReminder({ agencyId, orderId: row.customOrderId, excludeIntentId: row.id, db });
    if (unresolvedReminder) throw fail("CUSTOM_ORDER_REMINDER_OUTCOME_UNRESOLVED", "A previous reminder outcome is unresolved and fences this reminder commit", 409);
  }
  if (kind === "TASK") {
    const currentTaskPayload = taskPayload(order);
    if (!/^\d{1,20}$/.test(clean(currentTaskPayload.recipientTelegramUserId, 40))) {
      throw fail("TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN", "Resolve the current Telegram contact before committing the TASK delivery", 409);
    }
    const currentFingerprint = payloadFingerprint(currentTaskPayload);
    if (currentFingerprint !== String(row.payloadFingerprint)) {
      throw fail("TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED", "Custom order or Telegram TASK recipient changed before commit; refresh the existing TASK intent", 409);
    }
  }
  if (kind === "CANCELLATION") {
    if (String(order.status) !== "CANCELLED") throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "Cancellation intent is no longer valid before commit", 409);
  } else {
    if (String(order.status) !== "PENDING") throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "Custom order is no longer pending before Telegram commit", 409);
  }
  if (kind === "AUTO_REMINDER") {
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
    const due = desiredReminderSchedule(order, workspacePolicy, now, { modelObligation: binding.obligation || null });
    const plannedKey = clean(row.payload?.reminderKey, 500);
    if (!plannedKey || due.key !== plannedKey || (due.at && due.at.getTime() > now.getTime())) throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "Current model obligation or reminder settings changed before Telegram commit", 409);
  }
  if (kind === "MANUAL_REMINDER" && String(order.type || "CONTENT").toUpperCase() === "CONTENT") {
    const clientIntentId = clean(row.clientIntentId, 180);
    const cycle = clean(binding.cycleId, 260) || `TASK:${clean(binding.replyToDeliveryId, 180)}`;
    const expectedKey = clientIntentId ? `CONTENT:${cycle}:MANUAL:${clientIntentId}` : null;
    const plannedKey = clean(row.payload?.reminderKey, 500);
    if (!expectedKey || plannedKey !== expectedKey) {
      throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "The manual reminder belongs to an obsolete Custom model-obligation cycle", 409);
    }
  }
  return order;
}

async function beginTelegramDeliveryIntent({ agencyId, member, intentId, deviceId, runtimeClaimToken, claimToken, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const initial = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!initial) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  if (["CONFIRMED", "RECONCILE_REQUIRED", "COMMITTING"].includes(String(initial.state))) return { ok: true, begun: false, intent: publicIntent(initial) };
  verifyStoredClaim(initial, { deviceId, claimToken });

  const beginPermit = async (tx) => {
    // Re-read inside the transaction. The TASK permit and the CustomOrder updatedAt fence must
    // become visible atomically, otherwise a business edit can pass its pre-check just before
    // COMMITTING and write a new model-visible revision after the external effect was permitted.
    const row = await tx.telegramDeliveryIntent.findFirst({ where: { id: initial.id, agencyId } });
    if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
    if (["CONFIRMED", "RECONCILE_REQUIRED", "COMMITTING"].includes(String(row.state))) return { ok: true, begun: false, intent: publicIntent(row) };
    verifyStoredClaim(row, { deviceId, claimToken });

    const order = await currentBeginGuard({ row, member, agencyId, runtimeClaimToken, deviceId, now, db: tx });
    const kind = String(row.kind);
    if (kind === "TASK" || kind === "REVISION_REQUEST" || REMINDER_KINDS.has(kind)) {
      const previousUpdatedAt = order?.updatedAt ? new Date(order.updatedAt) : null;
      if (!previousUpdatedAt || !Number.isFinite(previousUpdatedAt.getTime())) {
        throw fail("TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED", "Custom order revision is unavailable before Telegram external commit", 409);
      }
      const requestedFenceAt = new Date(now);
      const fenceAt = new Date(Math.max(
        Number.isFinite(requestedFenceAt.getTime()) ? requestedFenceAt.getTime() : Date.now(),
        previousUpdatedAt.getTime() + 1,
      ));
      const fenced = await tx.customOrder.updateMany({
        where: { id: order.id, agencyId, status: "PENDING", updatedAt: order.updatedAt },
        // updatedAt is deliberately used as a cross-entity CAS fence. TASK uses it to keep
        // model-visible business edits behind the provider commit boundary. Reminder kinds use
        // the same order revision as a per-CustomOrder commit-lane mutex: two distinct claimed
        // reminders that pass the unresolved pre-check concurrently cannot both receive permits.
        data: { updatedAt: fenceAt },
      });
      if (Number(fenced?.count || 0) !== 1) {
        throw fail("TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED", "Custom order changed while Telegram external commit was being fenced; refresh the existing intent", 409);
      }
    }

    const changed = await tx.telegramDeliveryIntent.updateMany({
      where: { id: row.id, agencyId, state: "CLAIMED", claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash },
      data: { state: "COMMITTING", commitStartedAt: now, claimUntil: null },
    });
    if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_BEGIN_RACE", "Telegram delivery changed before commit permit", 409);
    const fresh = await tx.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    return { ok: true, begun: true, intent: publicIntent(fresh) };
  };

  try {
    return typeof client.$transaction === "function" ? await client.$transaction(beginPermit) : await beginPermit(client);
  } catch (error) {
    // Any transaction writes were rolled back. Restore only the still-same precommit claim; an
    // already-COMMITTING concurrent winner is intentionally untouched by this conditional write.
    const reason = clean(error?.code || error?.message, 500) || "PRECOMMIT_GUARD_FAILED";
    const domainCancelled = String(error?.code || "") === "TELEGRAM_DELIVERY_CONTROL_CHANGED";
    await client.telegramDeliveryIntent.updateMany({
      where: { id: initial.id, agencyId, state: "CLAIMED", claimRevision: initial.claimRevision },
      data: domainCancelled
        ? { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: reason }
        : { state: "FAILED_PRECOMMIT", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: `FAILED_PRECOMMIT:${reason}` },
    }).catch(() => undefined);
    if (!domainCancelled && String(error?.code || "") === "TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED") {
      const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: initial.id, agencyId } }).catch(() => null);
      if (fresh) await refreshPrecommitIntentFromCurrentState({ row: fresh, agencyId, now, db: client }).catch(() => undefined);
    }
    throw error;
  }
}

async function appendConfirmedReferenceMessageId({ agencyId, orderId, remoteMessageId, db }) {
  const append = async (tx) => {
    // REFERENCE receipts may settle concurrently on different devices/intents.
    // Serialize the derived scalar-list projection on the exact CustomOrder row so
    // two confirmed provider facts can never overwrite one another's message id.
    if (typeof tx.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe(
        `SELECT "id" FROM "CustomOrder" WHERE "id" = $1 AND "agencyId" = $2 FOR UPDATE`,
        String(orderId),
        String(agencyId),
      );
    }
    const current = await tx.customOrder.findFirst({ where: { id: String(orderId), agencyId: String(agencyId) } });
    if (!current) return { missing: true, changed: false };
    const existing = Array.from(new Set((Array.isArray(current.telegramReferenceMessageIds) ? current.telegramReferenceMessageIds : [])
      .map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)));
    const messageId = Number(remoteMessageId);
    if (existing.includes(messageId)) return { missing: false, changed: false };
    await tx.customOrder.updateMany({
      where: { id: String(orderId), agencyId: String(agencyId) },
      data: { telegramReferenceMessageIds: [...existing, messageId] },
    });
    return { missing: false, changed: true };
  };
  return typeof db.$transaction === "function" ? db.$transaction(append) : append(db);
}

async function markConfirmedProjectionBlocked({ row, error, now = new Date(), db }) {
  if (!row?.id) return;
  const code = clean(error?.code, 120) || "TELEGRAM_CONFIRMED_PROJECTION_FAILED";
  await db.telegramDeliveryIntent.updateMany({
    where: { id: row.id, agencyId: row.agencyId, state: "CONFIRMED" },
    data: {
      projectionBlockedCode: code,
      projectionBlockedAt: row.projectionBlockedAt ? new Date(row.projectionBlockedAt) : now,
      projectionLastAttemptAt: now,
      projectionAttempts: Number(row.projectionAttempts || 0) + 1,
    },
  });
}

async function clearConfirmedProjectionBlocked({ row, db }) {
  if (!row?.id) return;
  if (!row.projectionBlockedCode && !row.projectionBlockedAt && !row.projectionLastAttemptAt && Number(row.projectionAttempts || 0) === 0) return;
  await db.telegramDeliveryIntent.updateMany({
    where: { id: row.id, agencyId: row.agencyId, state: "CONFIRMED" },
    data: { projectionBlockedCode: null, projectionBlockedAt: null, projectionLastAttemptAt: null, projectionAttempts: 0 },
  });
}

async function projectConfirmedIntentObserved({ row, now, db }) {
  try {
    await projectConfirmedIntent({ row, now, db });
    await clearConfirmedProjectionBlocked({ row, db });
  } catch (error) {
    await markConfirmedProjectionBlocked({ row, error, now, db }).catch(() => undefined);
    throw error;
  }
}

async function projectConfirmedIntent({ row, now, db }) {
  const kind = String(row.kind); const remoteMessageId = Number(row.remoteMessageId);
  const effectAtCandidate = row.remoteSentAt ? new Date(row.remoteSentAt) : (row.confirmedAt ? new Date(row.confirmedAt) : now);
  const effectAt = Number.isFinite(effectAtCandidate.getTime()) ? effectAtCandidate : now;
  const order = await db.customOrder.findFirst({ where: { id: row.customOrderId, agencyId: row.agencyId } });
  if (!order) return;
  if (String(order.creatorId) !== String(row.creatorId)) {
    throw fail(
      "TELEGRAM_DELIVERY_BUSINESS_TARGET_CONFLICT",
      "Confirmed Telegram provider receipt points at a CustomOrder owned by a different creator",
      409,
    );
  }
  if (kind === "TASK") {
    if (order.telegramTaskMessageId != null && Number(order.telegramTaskMessageId) !== remoteMessageId) throw fail("TELEGRAM_DELIVERY_TASK_PROJECTION_CONFLICT", "Custom order is already linked to a different Telegram task", 409);

    // First project only the provider fact. Do not carry status/reminder fields from the
    // snapshot read above: cancellation can commit between that read and this write.
    const linked = await db.customOrder.updateMany({
      where: { id: order.id, agencyId: row.agencyId, telegramTaskMessageId: null },
      data: { telegramTaskMessageId: remoteMessageId },
    });
    if (Number(linked?.count || 0) === 1) {
      await db.customOrder.updateMany({
        where: { id: order.id, agencyId: row.agencyId, deliveredAt: null },
        data: { deliveredAt: effectAt },
      });
    }

    let settledOrder = await db.customOrder.findFirst({ where: { id: order.id, agencyId: row.agencyId } });
    if (!settledOrder) return;
    if (settledOrder.telegramTaskMessageId != null && Number(settledOrder.telegramTaskMessageId) !== remoteMessageId) throw fail("TELEGRAM_DELIVERY_TASK_PROJECTION_CONFLICT", "Custom order is already linked to a different Telegram task", 409);

    // Reminder schedule is a separate convergent projection. It always re-reads the latest
    // CustomOrder revision and CURRENT policy, then CAS-writes nextReminderAt. This prevents a
    // late TASK receipt from stale-overwriting a concurrent settings/per-order reminder change.
    if (String(settledOrder.status) === "PENDING") {
      await reprojectCustomReminderSchedule({ agencyId: row.agencyId, orderId: settledOrder.id, now: effectAt, firstAnchorAt: effectAt, db });
      settledOrder = await db.customOrder.findFirst({ where: { id: order.id, agencyId: row.agencyId } }) || settledOrder;
    }

    // A task may settle after cancellation won the concurrent business-state race. The cancel
    // path could have observed telegramTaskMessageId=null and therefore planned nothing. Always
    // decide cancellation from the fresh post-receipt order, never from the stale pre-write row.
    if (String(settledOrder.status) === "CANCELLED" && !settledOrder.telegramCancellationWaivedAt) {
      await ensureCancellationIntentForCancelledOrder({
        agencyId: row.agencyId, order: settledOrder, actorUserId: row.userId || null,
        reason: "TASK_SETTLED_AFTER_CANCELLATION", now: effectAt, db,
      });
    }
  } else if (kind === "REVISION_REQUEST") {
    // The model's next obligation starts only at the provider-confirmed revision instruction.
    // Reprojecting here anchors the new reminder cycle to this exact receipt; REQUEST_REVISION
    // itself intentionally leaves nextReminderAt null while delivery is pending/unknown.
    if (String(order.status) === "PENDING") {
      await reprojectCustomReminderSchedule({ agencyId: row.agencyId, orderId: order.id, now: effectAt, firstAnchorAt: effectAt, db });
    } else if (String(order.status) === "CANCELLED" && !order.telegramCancellationWaivedAt) {
      await ensureCancellationIntentForCancelledOrder({
        agencyId: row.agencyId, order, actorUserId: row.userId || null,
        reason: "REVISION_SETTLED_AFTER_CANCELLATION", now: effectAt, db,
      });
    }
  } else if (kind === "REFERENCE") {
    await appendConfirmedReferenceMessageId({ agencyId: row.agencyId, orderId: order.id, remoteMessageId, db });
  } else if (kind === "MANUAL_REMINDER" || kind === "AUTO_REMINDER") {
    const reminderKey = clean(row.payload?.reminderKey, 500) || null;

    // Provider facts are monotonic by provider effect time and are committed independently from
    // the derived schedule. Use the same CustomOrder revision as a CAS fence so unrelated edits
    // cannot be overwritten; on conflict, re-read and either retry or observe a newer fact.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await db.customOrder.findFirst({ where: { id: order.id, agencyId: row.agencyId } });
      if (!current) break;
      const currentEffectAt = current.lastReminderAt ? new Date(current.lastReminderAt) : null;
      if (currentEffectAt && currentEffectAt.getTime() >= effectAt.getTime()) break;
      const revision = current.updatedAt ? new Date(current.updatedAt) : null;
      if (!revision || !Number.isFinite(revision.getTime())) throw fail("CUSTOM_REMINDER_PROVIDER_REVISION_REQUIRED", "CustomOrder.updatedAt is required to project reminder provider facts", 500);
      const fenceAt = new Date(Math.max(effectAt.getTime(), revision.getTime() + 1));
      const changed = await db.customOrder.updateMany({
        where: { id: current.id, agencyId: row.agencyId, updatedAt: revision, OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: effectAt } }] },
        data: { lastReminderAt: effectAt, lastReminderKey: reminderKey, updatedAt: fenceAt },
      });
      if (Number(changed?.count || 0) === 1) break;
      if (attempt === 4) throw fail("CUSTOM_REMINDER_PROVIDER_FACT_CONFLICT", "Reminder provider fact changed concurrently too many times", 409);
    }

    // nextReminderAt is derived only from the latest durable provider fact + current policy.
    await reprojectCustomReminderSchedule({ agencyId: row.agencyId, orderId: order.id, now: effectAt, db });
  }
}

async function reconcileInboundAfterConfirmedReceipt({ row, member, now, db }) {
  if (!row?.remoteRecipientTelegramUserId && !row?.remoteMessageId) return { ok: true, skipped: true };
  const providerReceipt = String(row.confirmationAuthority || "PROVIDER_RECEIPT") === "PROVIDER_RECEIPT";
  try {
    return await reconcilePendingInboundForConfirmedDelivery({
      agencyId: row.agencyId,
      accountId: row.accountId,
      // Manual reconciliation may settle business execution, but only an actual provider receipt
      // may become generic sender proof. Direct Reply can still be repaired by exact message id.
      senderTelegramUserId: providerReceipt ? (row.remoteRecipientTelegramUserId || null) : null,
      replyToMessageId: row.remoteMessageId || null,
      actorUserId: member?.userId || row.userId || null,
      now,
      limit: 50,
      db,
    });
  } catch (error) {
    // Inbound reconciliation is a derived repair projection.  A failure here must never
    // downgrade an already durable Telegram provider receipt or make the caller resend.
    return { ok: false, errorCode: clean(error?.code, 120) || "TELEGRAM_INBOUND_RECONCILE_FAILED" };
  }
}

async function assertProviderReceiptIdentityAvailable({ agencyId, accountId, remoteMessageId, excludeIntentId = null, db }) {
  const existing = await db.telegramDeliveryIntent.findFirst({
    where: { agencyId, accountId: String(accountId), remoteMessageId: Number(remoteMessageId), ...(excludeIntentId ? { id: { not: String(excludeIntentId) } } : {}) },
  });
  if (existing) throw fail("TELEGRAM_DELIVERY_REMOTE_MESSAGE_CONFLICT", "This Telegram account/message receipt is already owned by another delivery intent", 409);
}

async function confirmTelegramDeliveryIntent({ agencyId, member, intentId, deviceId, claimToken, remoteMessageId, remoteRecipientTelegramUserId = null, remoteSentAt, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const id = clean(intentId, 180); const row = await client.telegramDeliveryIntent.findFirst({ where: { id, agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  const messageId = positiveInt(remoteMessageId, "remoteMessageId"); const recipientTelegramUserId = clean(remoteRecipientTelegramUserId, 40);
  if (recipientTelegramUserId && !/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_RECIPIENT_ID_INVALID", "remoteRecipientTelegramUserId must be a numeric Telegram user id");
  if (String(row.kind) === "TASK" && !/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_TASK_RECIPIENT_REQUIRED", "TASK confirmation requires the proven Telegram recipient user id", 409);
  const sentAt = iso(remoteSentAt, "remoteSentAt", now) || now;
  if (row.state === "CONFIRMED") {
    if (Number(row.remoteMessageId) !== messageId) throw fail("TELEGRAM_DELIVERY_CONFIRM_CONFLICT", "Telegram delivery was already confirmed with a different remote message id", 409);
    if (recipientTelegramUserId && row.remoteRecipientTelegramUserId && String(row.remoteRecipientTelegramUserId) !== recipientTelegramUserId) throw fail("TELEGRAM_DELIVERY_CONFIRM_CONFLICT", "Telegram delivery was already confirmed for a different recipient identity", 409);
    // A late actual provider receipt is stronger than an earlier manual reconciliation of the
    // same exact message. It may upgrade provenance, but never change canonical remote identity.
    let confirmedRow = row;
    if (String(row.confirmationAuthority || "") !== "PROVIDER_RECEIPT") {
      await assertProviderReceiptIdentityAvailable({ agencyId, accountId: row.accountId, remoteMessageId: messageId, excludeIntentId: row.id, db: client });
      await client.telegramDeliveryIntent.updateMany({ where: { id: row.id, agencyId, state: "CONFIRMED", remoteMessageId: messageId }, data: { confirmationAuthority: "PROVIDER_RECEIPT" } });
      confirmedRow = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } }) || row;
    }
    // Repair-safe idempotency: historical/partially-settled rows are projected from the same canonical receipt.
    await projectConfirmedIntentObserved({ row: confirmedRow, now: confirmedRow.confirmedAt ? new Date(confirmedRow.confirmedAt) : now, db: client });
    await reconcileInboundAfterConfirmedReceipt({ row: confirmedRow, member, now, db: client });
    return { ok: true, idempotent: true, intent: publicIntent(confirmedRow) };
  }
  verifyCommitClaim(row, { deviceId, claimToken });
  const settle = async (tx) => {
    // A durable provider receipt captured by the committing Desktop is affirmative proof and may
    // settle a row that became RECONCILE_REQUIRED only because the backend acknowledgement was lost.
    await assertProviderReceiptIdentityAvailable({ agencyId, accountId: row.accountId, remoteMessageId: messageId, excludeIntentId: row.id, db: tx });
    let changed;
    try {
      changed = await tx.telegramDeliveryIntent.updateMany({
        where: { id: row.id, agencyId, state: { in: ["COMMITTING", "RECONCILE_REQUIRED"] }, claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash },
        data: {
          state: "CONFIRMED", remoteMessageId: messageId,
          ...(recipientTelegramUserId ? { remoteRecipientTelegramUserId: recipientTelegramUserId } : {}),
          remoteSentAt: sentAt, confirmedAt: now, outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT",
          // The provider fact and its derived-projection obligation become durable atomically.
          // Retirement sees either the old COMMITTING/UNKNOWN state or this CONFIRMED pending marker;
          // there is no state-transition gap in which already-sent work looks fully converged.
          projectionBlockedCode: "TELEGRAM_CONFIRMED_PROJECTION_PENDING",
          projectionBlockedAt: now, projectionLastAttemptAt: null, projectionAttempts: 0,
        },
      });
    } catch (error) {
      if (String(error?.code || "") === "P2002") throw fail("TELEGRAM_DELIVERY_REMOTE_MESSAGE_CONFLICT", "This Telegram account/message receipt is already owned by another delivery intent", 409);
      throw error;
    }
    if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_CONFIRM_RACE", "Telegram delivery changed before confirmation", 409);
    return tx.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  };
  const confirmed = typeof client.$transaction === "function" ? await client.$transaction(settle) : await settle(client);
  // Provider receipt is the canonical external fact. CustomOrder/thread fields are
  // derived projections and converge only after that fact commits. If projection
  // fails, replaying the same receipt repairs state without authorizing another send.
  await projectConfirmedIntentObserved({ row: confirmed, now, db: client });
  await reconcileInboundAfterConfirmedReceipt({ row: confirmed, member, now, db: client });
  await audit({ agencyId, actorUserId: member?.userId || row.userId || null, action: "custom_order.telegram_delivery_confirm", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind, remoteMessageId: messageId }, db: client });
  return { ok: true, idempotent: false, intent: publicIntent(confirmed) };
}

async function repairConfirmedTelegramDeliveryProjectionItem({ agencyId, intentId, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const scopedAgencyId = clean(agencyId, 180);
  const id = clean(intentId, 180);
  if (!scopedAgencyId || !id) throw fail("TELEGRAM_CONFIRMED_PROJECTION_ID_REQUIRED", "agencyId and intentId are required");
  const row = await client.telegramDeliveryIntent.findFirst({ where: { id, agencyId: scopedAgencyId, state: "CONFIRMED" } });
  if (!row) return { ok: true, obsolete: true, repaired: 0, intentId: id };
  await projectConfirmedIntentObserved({ row, now: row.confirmedAt ? new Date(row.confirmedAt) : now, db: client });
  return { ok: true, obsolete: false, repaired: 1, intentId: id, orderId: row.customOrderId ? String(row.customOrderId) : null };
}

async function repairConfirmedTelegramDeliveryProjections({ agencyId, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const scopedAgencyId = clean(agencyId, 180);
  if (!scopedAgencyId) throw fail("TELEGRAM_DELIVERY_REPAIR_AGENCY_REQUIRED", "agencyId is required for Telegram projection repair");
  const {
    DEBT,
    providerOperationalBackfillReady,
    reconcileProviderOperationalDebtForOrder,
  } = require("./provider-operational-debt-authority-service");

  if (!client?.providerOperationalDebt?.findMany || !client?.telegramDeliveryIntent?.findMany) {
    return { ok: false, skipped: true, reason: "provider_operational_debt_unavailable", scanned: 0, repaired: 0, alreadyConverged: 0, failed: 0, failures: [], reminderScheduleScanned: 0, reminderScheduleRepaired: 0, reminderScheduleFailed: 0, reminderScheduleFailures: [] };
  }

  const candidates = new Map();
  const rows = await client.providerOperationalDebt.findMany({
    where: { agencyId: scopedAgencyId, debtClass: { in: [DEBT.CONFIRMED_PROJECTION_DEBT, DEBT.CANCELLATION_FOLLOWUP_DEBT] } },
    select: { id: true, debtClass: true, intentId: true, customOrderId: true, reason: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  for (const debt of rows || []) {
    if (!debt.intentId) continue;
    candidates.set(String(debt.intentId), {
      intentId: String(debt.intentId),
      orderId: debt.customOrderId ? String(debt.customOrderId) : null,
      reason: String(debt.reason || debt.debtClass || "PROVIDER_OPERATIONAL_DEBT"),
    });
  }

  // New-generation confirm() atomically writes projectionBlockedAt before attempting derived
  // projection. Querying that indexed marker is a bounded CURRENT-work safety net while the
  // exact-order dirty lane catches up; it is not an archaeological scan over CONFIRMED history.
  const marked = await client.telegramDeliveryIntent.findMany({
    where: { agencyId: scopedAgencyId, state: "CONFIRMED", projectionBlockedAt: { not: null } },
    select: { id: true, customOrderId: true, kind: true },
    orderBy: [{ projectionBlockedAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  for (const row of marked || []) {
    candidates.set(String(row.id), { intentId: String(row.id), orderId: row.customOrderId ? String(row.customOrderId) : null, reason: "MARKED_PROJECTION_DEBT" });
  }

  let repaired = 0;
  let alreadyConverged = 0;
  const failures = [];
  for (const candidate of candidates.values()) {
    const row = await client.telegramDeliveryIntent.findFirst({ where: { id: candidate.intentId, agencyId: scopedAgencyId, state: "CONFIRMED" } });
    if (!row) {
      alreadyConverged += 1;
      if (candidate.orderId) await reconcileProviderOperationalDebtForOrder({ agencyId: scopedAgencyId, orderId: candidate.orderId, db: client, now, markClean: false });
      continue;
    }
    try {
      await projectConfirmedIntentObserved({ row, now: row.confirmedAt ? new Date(row.confirmedAt) : now, db: client });
      repaired += 1;
      if (row.customOrderId) await reconcileProviderOperationalDebtForOrder({ agencyId: scopedAgencyId, orderId: row.customOrderId, db: client, now, markClean: false });
    } catch (error) {
      failures.push({ intentId: candidate.intentId, reason: candidate.reason, code: clean(error?.code, 120) || "TELEGRAM_CONFIRMED_PROJECTION_REPAIR_FAILED" });
    }
  }

  return {
    ok: failures.length === 0,
    skipped: false,
    backfillReady: await providerOperationalBackfillReady({ db: client, agencyId: scopedAgencyId }),
    scanned: candidates.size,
    repaired,
    alreadyConverged,
    failed: failures.length,
    failures,
    reminderScheduleScanned: 0,
    reminderScheduleRepaired: 0,
    reminderScheduleFailed: 0,
    reminderScheduleFailures: [],
  };
}

const MODEL_COMMUNICATION_PRECOMMIT_KINDS = ["TASK", "REFERENCE", "REVISION_REQUEST", "AUTO_REMINDER", "MANUAL_REMINDER"];

async function ensureRevisionRequestIntentForOrder({ agencyId, orderId, now = new Date(), db } = {}) {
  if (!db?.customOrder?.findFirst || !db?.customContentSubmission?.findFirst || !db?.telegramDeliveryIntent?.findFirst) {
    return { changed: false, reason: "REVISION_REPAIR_STORAGE_UNAVAILABLE", intent: null };
  }
  const order = await db.customOrder.findFirst({
    where: { agencyId, id: String(orderId), type: "CONTENT", status: "PENDING", fanDeliveredAt: null },
    include: { creator: true },
  });
  if (!order) return { changed: false, reason: "ORDER_NOT_PENDING_CONTENT", intent: null };
  const submission = await db.customContentSubmission.findFirst({
    where: { agencyId, customOrderId: String(order.id), pipelineDisposition: "ACTIVE", reviewStatus: "REVISION_REQUESTED" },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  if (!submission) return { changed: false, reason: "REVISION_NOT_REQUIRED", intent: null };
  const existing = await db.telegramDeliveryIntent.findFirst({
    where: { agencyId, kind: "REVISION_REQUEST", customSubmissionId: String(submission.id) },
  });
  if (existing) return { changed: false, reason: "REVISION_INTENT_EXISTS", intent: existing };
  try {
    const intent = await planRevisionRequestIntentForReviewedSubmission({
      agencyId, member: null, submission, order, revisionNumber: null, now, db,
    });
    return { changed: Boolean(intent), reason: intent ? "REVISION_INTENT_CONVERGED" : "REVISION_DISPATCH_BLOCKED", intent };
  } catch (error) {
    const code = String(error?.code || "");
    if ([
      "TELEGRAM_DELIVERY_TASK_THREAD_REQUIRED",
      "TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN",
      "CUSTOM_REVISION_DISPATCH_BLOCKED",
      "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED",
      "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING",
      "TELEGRAM_DELIVERY_ACCOUNT_FENCE_UNAVAILABLE",
      "TELEGRAM_DELIVERY_CONTROL_CHANGED",
      "TELEGRAM_REVISION_SUBMISSION_NOT_FOUND",
    ].includes(code)) return { changed: false, blocked: true, reason: code, intent: null };
    throw error;
  }
}

async function lockClaimedCustomCommunicationOrder({ db, agencyId, orderId }) {
  await lockAgencyPipelineLifecycle({ db, agencyId });
  const observed = await db.customOrder?.findFirst?.({
    where: { id: String(orderId), agencyId: String(agencyId) },
    select: { id: true, creatorId: true },
  });
  if (!observed) return null;

  const creatorId = clean(observed.creatorId, 180);
  if (!creatorId) throw fail("CUSTOM_MODEL_COMMUNICATION_CREATOR_REQUIRED", "Custom order creator is required for claimed communication repair", 409);
  await lockCreatorPipelineLifecycle({ db, agencyId, creatorId });

  let locked = null;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      'SELECT "id", "creatorId" FROM "CustomOrder" WHERE "agencyId"=$1 AND "id"=$2 FOR UPDATE',
      String(agencyId), String(orderId),
    );
    locked = rows?.[0] || null;
  } else {
    locked = await db.customOrder?.findFirst?.({
      where: { id: String(orderId), agencyId: String(agencyId) },
      select: { id: true, creatorId: true },
    }) || null;
  }
  if (!locked) return null;
  if (String(locked.creatorId || "") !== creatorId) {
    throw fail("CUSTOM_MODEL_COMMUNICATION_CREATOR_CHANGED", "Custom order creator changed while acquiring communication commit authority", 409);
  }
  return { id: String(locked.id), creatorId };
}

// CUSTOM_COMMUNICATION is executable DomainWork, not merely a wakeup hint. The worker
// must therefore prove that the exact claimed revision still owns execution in the same
// transaction that can create/cancel Telegram intents or replace provider-debt projection.
// Lock order deliberately follows the Phase-2 domain graph: Agency(shared) -> Creator ->
// CustomOrder -> DomainWork. Canonical order/intent producers also reach DomainWork only
// after their business row, so taking DomainWork first here would create an inverse edge.
async function repairClaimedCustomModelCommunicationWork({
  agencyId,
  orderId,
  workItem,
  ownerToken,
  now = new Date(),
  db = null,
  leaseMs = 5 * 60 * 1000,
} = {}) {
  const client = db || require("../prisma");
  const scopedAgencyId = clean(agencyId, 180);
  const scopedOrderId = clean(orderId, 180);
  if (!scopedAgencyId || !scopedOrderId || !workItem?.id || !ownerToken) {
    throw fail("CUSTOM_MODEL_COMMUNICATION_WORK_CLAIM_REQUIRED", "Claimed communication repair requires agency/order/work claim authority", 409);
  }
  if (String(workItem.agencyId || "") !== scopedAgencyId
    || String(workItem.workClass || "") !== PHASE2_WORK_CLASS.CUSTOM_COMMUNICATION
    || String(workItem.objectType || "") !== "CustomOrder"
    || String(workItem.objectId || "") !== scopedOrderId) {
    throw fail("CUSTOM_MODEL_COMMUNICATION_WORK_IDENTITY_MISMATCH", "Claimed communication work does not match the Custom order target", 409);
  }

  return runDbTransaction(client, async (tx) => {
    const lockedOrder = await lockClaimedCustomCommunicationOrder({ db: tx, agencyId: scopedAgencyId, orderId: scopedOrderId });
    const authority = await lockDomainWorkClaimForCommit({
      db: tx, item: workItem, ownerToken, fallbackNow: now,
    });
    if (!authority?.current) return { ok: false, lostOwnership: true, superseded: false, missing: !lockedOrder };

    // A newer canonical invalidation belongs to the next revision. Do not let the V1
    // owner perform V2 mutations merely because its old lease is still live; scheduler
    // ACK of claimedRevision will release the newer requestedRevision as READY.
    if (authority.newerRevision) {
      return { ok: true, lostOwnership: false, superseded: true, missing: !lockedOrder, communication: null, projection: null };
    }

    const renewed = await heartbeatDomainWorkClaim({
      db: tx, item: workItem, ownerToken, leaseMs, fallbackNow: authority.authorityNow || now,
    });
    if (!renewed?.renewed) return { ok: false, lostOwnership: true, superseded: false, missing: !lockedOrder };
    if (!lockedOrder) return { ok: true, lostOwnership: false, superseded: false, missing: true, communication: null, projection: null };

    const communication = await repairCurrentCustomModelCommunicationForOrder({
      agencyId: scopedAgencyId, orderId: scopedOrderId, now: authority.authorityNow || now, db: tx,
    });
    if (communication?.ok === false) {
      return { ok: false, lostOwnership: false, superseded: false, missing: false, communication, projection: null };
    }

    const { reconcileProviderOperationalDebtForOrder } = require("./provider-operational-debt-authority-service");
    const projection = await reconcileProviderOperationalDebtForOrder({
      agencyId: scopedAgencyId, orderId: scopedOrderId, db: tx,
      now: authority.authorityNow || now, markClean: true,
    });
    return { ok: true, lostOwnership: false, superseded: false, missing: false, communication, projection };
  }, { isolationLevel: "Serializable", timeout: 60_000 });
}

async function repairCurrentCustomModelCommunicationForOrder({ agencyId, orderId, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const scopedAgencyId = clean(agencyId, 180);
  const scopedOrderId = clean(orderId, 180);
  if (!scopedAgencyId || !scopedOrderId) throw fail("CUSTOM_MODEL_COMMUNICATION_REPAIR_TARGET_REQUIRED", "agencyId and orderId are required");
  const report = {
    ok: true, orderId: scopedOrderId,
    initialTaskPlanned: 0, initialTaskReactivated: 0, initialTaskBlocked: 0, initialTaskBlockedReason: null, initialTaskFailed: 0,
    revisionIntentPlanned: 0, revisionIntentBlocked: 0, revisionIntentFailed: 0,
    precommitScanned: 0, precommitCancelled: 0, precommitRefreshed: 0, precommitFailed: 0,
    reminderScheduleScanned: 0, reminderScheduleRepaired: 0, reminderScheduleFailed: 0,
  };

  try {
    const initial = await ensureInitialTaskIntentForOrder({ agencyId: scopedAgencyId, orderId: scopedOrderId, member: null, now, db: client });
    report.initialTaskPlanned += initial?.created ? 1 : 0;
    report.initialTaskReactivated += initial?.reactivated ? 1 : 0;
    report.initialTaskBlocked += initial?.blocked ? 1 : 0;
    if (initial?.blocked) report.initialTaskBlockedReason = clean(initial?.reason, 120) || "CUSTOM_MODEL_COMMUNICATION_BLOCKED";
  } catch (_) { report.initialTaskFailed += 1; }

  try {
    const revision = await ensureRevisionRequestIntentForOrder({ agencyId: scopedAgencyId, orderId: scopedOrderId, now, db: client });
    report.revisionIntentPlanned += revision?.changed ? 1 : 0;
    report.revisionIntentBlocked += revision?.blocked ? 1 : 0;
  } catch (_) { report.revisionIntentFailed += 1; }

  if (client.telegramDeliveryIntent?.findMany) {
    const rows = await client.telegramDeliveryIntent.findMany({
      where: {
        agencyId: scopedAgencyId,
        customOrderId: scopedOrderId,
        kind: { in: MODEL_COMMUNICATION_PRECOMMIT_KINDS },
        state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] },
        commitStartedAt: null,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const row of rows || []) {
      if (isPrecommitProviderBlocked(row)) continue; // dedicated retry clock owns provider-unavailable work
      report.precommitScanned += 1;
      try {
        const beforeState = String(row.state || "");
        const beforeReason = String(row.outcomeReason || "");
        const refreshed = await refreshPrecommitIntentFromCurrentState({ row, agencyId: scopedAgencyId, now, db: client });
        const current = refreshed || await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId: scopedAgencyId } });
        if (String(current?.state || "") === "CANCELLED" && beforeState !== "CANCELLED") report.precommitCancelled += 1;
        else if (current && (String(current.state || "") !== beforeState || String(current.outcomeReason || "") !== beforeReason)) report.precommitRefreshed += 1;
        if (String(row.kind) === "REVISION_REQUEST" && String(current?.state || "") === "CANCELLED") {
          const cancelledOrder = await client.customOrder.findFirst({ where: { id: scopedOrderId, agencyId: scopedAgencyId, status: "CANCELLED" } });
          if (cancelledOrder && !cancelledOrder.telegramCancellationWaivedAt) {
            await ensureCancellationIntentForCancelledOrder({
              agencyId: scopedAgencyId, order: cancelledOrder, actorUserId: null,
              reason: "REVISION_PRECOMMIT_CANCELLED_AFTER_ORDER_CANCELLATION", now, db: client,
            });
          }
        }
      } catch (_) { report.precommitFailed += 1; }
    }
  }

  report.reminderScheduleScanned = 1;
  try {
    const reminder = await reprojectCustomReminderSchedule({ agencyId: scopedAgencyId, orderId: scopedOrderId, now, db: client });
    if (reminder?.changed) report.reminderScheduleRepaired += 1;
  } catch (_) { report.reminderScheduleFailed += 1; }

  report.ok = report.initialTaskFailed === 0 && report.revisionIntentFailed === 0 && report.precommitFailed === 0 && report.reminderScheduleFailed === 0;
  return report;
}

async function repairCustomModelCommunicationConvergence({ agencyId, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const scopedAgencyId = clean(agencyId, 180);
  if (!scopedAgencyId) throw fail("CUSTOM_MODEL_COMMUNICATION_REPAIR_AGENCY_REQUIRED", "agencyId is required for Custom model communication repair");

  // All order-bound current communication repair is owned by the bounded
  // providerOperationalDirty lane. This Agency-scoped lane owns only due provider-binding
  // retries, whose indexed retry clock naturally removes attempted rows from the current batch.
  const providerRepair = await repairPrecommitProviderBlockedIntents({
    agencyId: scopedAgencyId, member: null, limit: 100, now, db: client,
  });
  // Due reminders are executable DomainWorkItem obligations. The Agency sweep must not
  // rediscover/execute them from CustomOrder history as a second scheduler authority.
  const currentBacklog = Number(providerRepair?.attempted || 0) >= 100;
  return {
    ok: true,
    currentBacklog,
    initialTaskIntentsPlanned: 0,
    initialTaskIntentsReactivated: 0,
    initialTaskIntentsBlocked: 0,
    initialTaskIntentsRaced: 0,
    initialTaskIntentsFailed: 0,
    initialTaskIntentFailures: [],
    revisionIntentsPlanned: 0,
    providerBindingRepairAttempted: Number(providerRepair?.attempted || 0),
    providerBindingRepairRecovered: Number(providerRepair?.recovered || 0),
    providerBindingRepairStillBlocked: Number(providerRepair?.stillBlocked || 0),
    precommitScanned: 0,
    precommitCancelled: 0,
    precommitRefreshed: 0,
    precommitFailed: 0,
    precommitFailures: [],
    reminderScheduleScanned: 0,
    reminderScheduleRepaired: 0,
    reminderScheduleFailed: 0,
    reminderScheduleFailures: [],
  };
}

async function markTelegramDeliveryProvenNotSent({ agencyId, member, intentId, deviceId, claimToken, reason, db = null } = {}) {
  const client = db || require("../prisma"); const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  if (row.state === "PLANNED" || row.state === "FAILED_PRECOMMIT" || row.state === "CANCELLED") return { ok: true, idempotent: true, intent: publicIntent(row) };
  if (row.state === "CONFIRMED") throw fail("TELEGRAM_DELIVERY_PROVEN_NOT_SENT_CONFLICT", "A confirmed Telegram outcome cannot be downgraded to not-sent", 409);
  // A Desktop may lose the /begin response before it ever invokes the Telegram provider send.
  // In that exact case the canonical row can still be CLAIMED or can already be COMMITTING.
  // Both are safe to collapse back to retryable precommit work when the same claim holder proves
  // that provider dispatch was never invoked. Unknown provider outcome is still never inferred.
  if (row.state === "CLAIMED") verifyStoredClaim(row, { deviceId, claimToken });
  else verifyCommitClaim(row, { deviceId, claimToken });
  const justification = clean(reason, 500);
  if (!justification) throw fail("TELEGRAM_DELIVERY_PROVEN_NOT_SENT_REASON_REQUIRED", "A transport proof reason is required");
  const orderExists = await client.customOrder.findFirst({ where: { id: row.customOrderId, agencyId }, select: { id: true } });
  const orphan = !orderExists;
  const changed = await client.telegramDeliveryIntent.updateMany({
    where: { id: row.id, agencyId, state: { in: ["CLAIMED", "COMMITTING", "RECONCILE_REQUIRED"] }, claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash },
    data: orphan
      ? { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, commitStartedAt: null, claimRevision: Number(row.claimRevision || 0) + 1, outcomeReason: `PROVEN_NOT_SENT_ORPHAN:${justification}` }
      : { state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, commitStartedAt: null, outcomeReason: `PROVEN_NOT_SENT:${justification}` },
  });
  if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_PROVEN_NOT_SENT_RACE", "Telegram delivery changed while recording proven no-effect", 409);
  const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  await audit({ agencyId, actorUserId: member?.userId || row.userId || null, action: "custom_order.telegram_delivery_proven_not_sent", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind, reason: justification, orphanCustomOrder: orphan }, db: client });
  if (!orphan) {
    const cancelledOrder = await client.customOrder.findFirst({ where: { id: row.customOrderId, agencyId, status: "CANCELLED" } });
    if (cancelledOrder && !cancelledOrder.telegramCancellationWaivedAt) {
      await ensureCancellationIntentForCancelledOrder({
        agencyId, order: cancelledOrder, actorUserId: member?.userId || row.userId || null,
        reason: `${String(row.kind)}_PROVEN_NOT_SENT_AFTER_CANCELLATION`, now: new Date(), db: client,
      });
    }
  }
  return { ok: true, idempotent: false, intent: publicIntent(fresh) };
}

async function getTelegramOrderContext({ agencyId, member, orderId, db = null } = {}) {
  const client = db || require("../prisma");
  const order = await loadOrder({ agencyId, orderId, db: client });
  await requireCreatorAccess({ agencyId, member, creatorId: order.creatorId, db: client });
  const thread = await loadConfirmedTaskThread({ agencyId, orderId: order.id, db: client });

  // This context is an authorization/recovery authority, not a UI preview. A bounded
  // recent-history sample is therefore unsafe: a proven reference or a recoverable
  // precommit slot may be arbitrarily old. Apply correctness eligibility in SQL and
  // cursor to exhaustion before building the compact context projection.
  const confirmedReferences = [];
  await scanAllById({
    delegate: client.telegramDeliveryIntent,
    where: {
      agencyId, customOrderId: order.id, kind: "REFERENCE", state: "CONFIRMED",
      accountId: String(thread.accountId),
      remoteRecipientTelegramUserId: String(thread.recipientTelegramUserId),
    },
    onPage: async (rows) => { confirmedReferences.push(...rows); return false; },
  });

  const recoverableReferences = [];
  await scanAllById({
    delegate: client.telegramDeliveryIntent,
    where: {
      agencyId, customOrderId: order.id, kind: "REFERENCE",
      state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] },
      commitStartedAt: null,
    },
    onPage: async (rows) => { recoverableReferences.push(...rows); return false; },
  });

  const referenceOrder = (left, right) => {
    const aOrdinal = Number.isInteger(Number(left?.referenceOrdinal)) ? Number(left.referenceOrdinal) : Number.MAX_SAFE_INTEGER;
    const bOrdinal = Number.isInteger(Number(right?.referenceOrdinal)) ? Number(right.referenceOrdinal) : Number.MAX_SAFE_INTEGER;
    if (aOrdinal !== bOrdinal) return aOrdinal - bOrdinal;
    const aCreated = left?.createdAt ? new Date(left.createdAt).getTime() : 0;
    const bCreated = right?.createdAt ? new Date(right.createdAt).getTime() : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  };
  confirmedReferences.sort(referenceOrder);
  recoverableReferences.sort(referenceOrder);

  return {
    ok: true, orderId: String(order.id), creatorId: String(order.creatorId), accountId: thread.accountId, telegramUserId: thread.recipientTelegramUserId,
    telegramTaskMessageId: thread.replyToMessageId,
    telegramReferenceMessageIds: confirmedReferences.filter((row) => row.remoteMessageId != null).map((row) => String(row.remoteMessageId)),
    recoverableReferenceIntents: recoverableReferences.map(publicIntent),
  };
}

async function assertTelegramDeliveryMaterialAccess({ agencyId, member, intentId, creatorId, accountId, deviceId, deliveryClaimToken, db = null } = {}) {
  const client = db || require("../prisma");
  const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  if (String(row.creatorId) !== clean(creatorId, 180) || String(row.accountId) !== clean(accountId, 180)) {
    throw fail("TELEGRAM_DELIVERY_MATERIAL_SCOPE_MISMATCH", "Telegram delivery material scope does not match the committed intent", 403);
  }
  verifyCommitClaim(row, { deviceId, claimToken: deliveryClaimToken });
  if (String(row.state) !== "COMMITTING") throw fail("TELEGRAM_DELIVERY_MATERIAL_STATE_INVALID", "Telegram delivery material is available only after the commit permit", 409);
  const recipientTelegramUserId = clean(row.payload?.recipientTelegramUserId, 40);
  const replyToMessageId = clean(row.payload?.replyToMessageId, 40);
  const isTask = String(row.kind) === "TASK";
  if (!/^\d{1,20}$/.test(recipientTelegramUserId) || (!isTask && !/^\d+$/.test(replyToMessageId))) {
    throw fail("TELEGRAM_DELIVERY_THREAD_PROOF_INVALID", isTask
      ? "Committed TASK delivery has no proven Telegram recipient binding"
      : "Committed follow-up delivery has no proven Telegram thread binding", 409);
  }
  return { row, recipientTelegramUserId, replyToMessageId };
}

async function markTelegramDeliveryUnknown({ agencyId, member, intentId, deviceId, claimToken, reason, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  if (row.state === "CONFIRMED" || row.state === "RECONCILE_REQUIRED") return { ok: true, idempotent: true, intent: publicIntent(row) };
  verifyCommitClaim(row, { deviceId, claimToken });
  const changed = await client.telegramDeliveryIntent.updateMany({ where: { id: row.id, agencyId, state: "COMMITTING", claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash }, data: { state: "RECONCILE_REQUIRED", outcomeReason: clean(reason, 500) || "OUTCOME_UNKNOWN" } });
  if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_UNKNOWN_RACE", "Telegram delivery changed while recording unknown outcome", 409);
  const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  await audit({ agencyId, actorUserId: member?.userId || row.userId || null, action: "custom_order.telegram_delivery_unknown", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind, reason: fresh.outcomeReason }, db: client });
  return { ok: true, idempotent: false, intent: publicIntent(fresh) };
}

async function replaceTelegramReferencePrecommit({ agencyId, member, intentId, clientIntentId, reference, now = new Date(), db = null, _transactional = false } = {}) {
  const client = db || require("../prisma");
  if (!_transactional && typeof client?.$transaction === "function") {
    return client.$transaction((tx) => replaceTelegramReferencePrecommit({
      agencyId, member, intentId, clientIntentId, reference, now, db: tx, _transactional: true,
    }), { isolationLevel: "Serializable" });
  }
  await lockAgencyPipelineLifecycle({ db: client, agencyId });
  const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  await assertCustomManagementCreatorAccess({ agencyId, actorMember: member, creatorId: row.creatorId, permissionKey: null, db: client });
  if (String(row.kind) !== "REFERENCE") throw fail("TELEGRAM_REFERENCE_REPLACE_KIND_INVALID", "Only REFERENCE intents support artifact replacement", 409);
  if (!["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(row.state)) || row.commitStartedAt != null) {
    throw fail("TELEGRAM_REFERENCE_REPLACE_COMMIT_BOUNDARY", "A reference artifact can only be replaced before Telegram commit begins", 409);
  }
  const normalizedClientIntentId = uuid(clientIntentId);
  const ref = reference && typeof reference === "object" ? reference : {};
  const name = clean(ref.name, 500); const sha256Value = clean(ref.sha256, 64).toLowerCase(); const size = Number(ref.size);
  if (!name || !/^[0-9a-f]{64}$/.test(sha256Value) || !Number.isSafeInteger(size) || size < 0) {
    throw fail("CUSTOM_ORDER_REFERENCE_PROOF_REQUIRED", "Reference name, size and sha256 are required");
  }
  const order = await loadOrder({ agencyId, orderId: row.customOrderId, db: client });
  if (String(order.status || "").toUpperCase() !== "PENDING") throw fail("CUSTOM_ORDER_REFERENCE_STATE_INVALID", "References can only be delivered for a pending custom order", 409);
  const binding = await resolveIntentProviderBinding({ agencyId, order, kind: "REFERENCE", db: client });
  const payload = { reference: { name, size, sha256: sha256Value }, replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  const nextRevision = Number(row.claimRevision || 0) + 1;
  const changed = await client.telegramDeliveryIntent.updateMany({
    where: { id: row.id, agencyId, kind: "REFERENCE", state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
    data: {
      accountId: String(binding.accountId), clientIntentId: normalizedClientIntentId, payload, payloadFingerprint: payloadFingerprint(payload),
      state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null,
      claimRevision: nextRevision, outcomeReason: "REFERENCE_ARTIFACT_REPLACED_PRECOMMIT", updatedAt: now,
    },
  });
  if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_REFERENCE_REPLACE_RACE", "Reference changed while replacing its precommit artifact", 409);
  const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_reference_replace_precommit", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, referenceOrdinal: row.referenceOrdinal, oldClientIntentId: row.clientIntentId || null, clientIntentId: normalizedClientIntentId }, db: client });
  return { ok: true, intent: publicIntent(fresh) };
}

async function cancelTelegramReferencePrecommit({ agencyId, member, intentId, reason, now = new Date(), db = null, _transactional = false } = {}) {
  const client = db || require("../prisma");
  if (!_transactional && typeof client?.$transaction === "function") {
    return client.$transaction((tx) => cancelTelegramReferencePrecommit({
      agencyId, member, intentId, reason, now, db: tx, _transactional: true,
    }), { isolationLevel: "Serializable" });
  }
  await lockAgencyPipelineLifecycle({ db: client, agencyId });
  const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  await assertCustomManagementCreatorAccess({ agencyId, actorMember: member, creatorId: row.creatorId, permissionKey: null, db: client });
  if (String(row.kind) !== "REFERENCE") throw fail("TELEGRAM_REFERENCE_CANCEL_KIND_INVALID", "Only REFERENCE intents support precommit skip", 409);
  if (String(row.state) === "CANCELLED") return { ok: true, idempotent: true, intent: publicIntent(row) };
  if (!["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(row.state)) || row.commitStartedAt != null) {
    throw fail("TELEGRAM_REFERENCE_CANCEL_COMMIT_BOUNDARY", "A reference can only be skipped before Telegram commit begins", 409);
  }
  const justification = clean(reason, 500);
  if (!justification) throw fail("TELEGRAM_REFERENCE_CANCEL_REASON_REQUIRED", "A reason is required to skip a reference slot");
  const changed = await client.telegramDeliveryIntent.updateMany({
    where: { id: row.id, agencyId, kind: "REFERENCE", state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
    data: { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, claimRevision: Number(row.claimRevision || 0) + 1, outcomeReason: `REFERENCE_SKIPPED:${justification}`, updatedAt: now },
  });
  if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_REFERENCE_CANCEL_RACE", "Reference changed while skipping its precommit slot", 409);
  const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_reference_cancel_precommit", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, referenceOrdinal: row.referenceOrdinal, reason: justification }, db: client });
  return { ok: true, idempotent: false, intent: publicIntent(fresh) };
}

async function failTelegramDeliveryPrecommit({ agencyId, member, intentId, deviceId, claimToken, reason, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  const failureReason = clean(reason, 500) || "PRECOMMIT_FAILURE";

  // Before a claim exists, the Desktop may still have proof that no provider call could
  // start (missing local reference, runtime unavailable, claim request itself failed).
  // This is operational state only. Serialize with claim through a state/revision CAS:
  // if another executor already claimed the row, this branch loses without cancelling it.
  if (["PLANNED", "FAILED_PRECOMMIT"].includes(String(row.state)) && row.commitStartedAt == null) {
    await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
    const changed = await client.telegramDeliveryIntent.updateMany({
      where: { id: row.id, agencyId, state: row.state, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
      data: { state: "FAILED_PRECOMMIT", outcomeReason: `FAILED_PRECOMMIT:${failureReason}`, updatedAt: now },
    });
    if (Number(changed?.count || 0) !== 1) return { ok: true, ignored: true, intent: publicIntent(await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } })) };
    return { ok: true, ignored: false, orphanCustomOrder: false, intent: publicIntent(await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } })) };
  }

  if (row.state !== "CLAIMED") return { ok: true, ignored: true, intent: publicIntent(row) };
  if (!clean(claimToken, 500)) return { ok: true, ignored: true, intent: publicIntent(row) };
  verifyStoredClaim(row, { deviceId, claimToken });
  const orderExists = await client.customOrder.findFirst({ where: { id: row.customOrderId, agencyId }, select: { id: true } });
  const orphan = !orderExists;
  const changed = await client.telegramDeliveryIntent.updateMany({
    where: { id: row.id, agencyId, state: "CLAIMED", claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash },
    data: orphan
      ? { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, claimRevision: Number(row.claimRevision || 0) + 1, outcomeReason: "LEGACY_ORPHAN_CUSTOM_ORDER_PRECOMMIT" }
      : { state: "FAILED_PRECOMMIT", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: `FAILED_PRECOMMIT:${failureReason}` },
  });
  if (Number(changed?.count || 0) !== 1) return { ok: true, ignored: true, intent: publicIntent(await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } })) };
  return { ok: true, ignored: false, orphanCustomOrder: orphan, intent: publicIntent(await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } })) };
}

async function listTelegramConfirmedProjectionBlockedQueue({ agencyId, member, limit = 50, cursor = null, db = null } = {}) {
  const client = db || require("../prisma");
  if (!await canUsePermission({ member, key: "team.analytics.view", db: client })) throw fail("TELEGRAM_CONFIRMED_PROJECTION_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  const afterId = clean(cursor, 180);
  const rows = await client.telegramDeliveryIntent.findMany({
    where: { agencyId, ...scopeWhere(scope), state: "CONFIRMED", projectionBlockedAt: { not: null } },
    orderBy: [{ projectionBlockedAt: "asc" }, { id: "asc" }],
    ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    take: take + 1,
  });
  const hasMore = (rows || []).length > take;
  const visible = (rows || []).slice(0, take);
  const nextCursor = hasMore && visible.length ? String(visible[visible.length - 1].id) : null;
  const creatorIds = Array.from(new Set(visible.map((row) => String(row.creatorId || "")).filter(Boolean)));
  const orderIds = Array.from(new Set(visible.map((row) => String(row.customOrderId || "")).filter(Boolean)));
  const creators = creatorIds.length && client.creatorAccount?.findMany
    ? await client.creatorAccount.findMany({ where: { agencyId, id: { in: creatorIds } }, select: { id: true, displayName: true, username: true, avatarUrl: true, deletedAt: true } }) : [];
  const orders = orderIds.length && client.customOrder?.findMany
    ? await client.customOrder.findMany({ where: { agencyId, id: { in: orderIds } }, select: { id: true, creatorId: true, scenario: true, type: true, status: true, dueAt: true, scheduledAt: true, createdAt: true } }) : [];
  const creatorById = new Map((creators || []).map((row) => [String(row.id), row]));
  const orderById = new Map((orders || []).map((row) => [String(row.id), row]));
  const canRetry = await canUsePermission({ member, key: "content.review_customs", db: client });
  return {
    ok: true,
    items: visible.map((row) => {
      const creator = creatorById.get(String(row.creatorId));
      const order = orderById.get(String(row.customOrderId));
      return {
        id: String(row.id), creatorId: String(row.creatorId), customOrderId: String(row.customOrderId), accountId: String(row.accountId), kind: String(row.kind), state: "CONFIRMED",
        remoteMessageId: row.remoteMessageId == null ? null : String(row.remoteMessageId), remoteSentAt: row.remoteSentAt ? new Date(row.remoteSentAt).toISOString() : null,
        confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
        projectionBlockedCode: clean(row.projectionBlockedCode, 120) || "TELEGRAM_CONFIRMED_PROJECTION_FAILED",
        projectionBlockedAt: row.projectionBlockedAt ? new Date(row.projectionBlockedAt).toISOString() : null,
        projectionLastAttemptAt: row.projectionLastAttemptAt ? new Date(row.projectionLastAttemptAt).toISOString() : null,
        projectionAttempts: Number(row.projectionAttempts || 0), externalEffectConfirmed: true,
        creator: creator ? { id: String(creator.id), displayName: creator.displayName || null, username: creator.username || null, avatarUrl: creator.avatarUrl || null, deleted: creator.deletedAt != null } : null,
        customOrder: order ? { customOrderId: String(order.id), creatorId: String(order.creatorId), scenario: order.scenario || "", type: String(order.type || ""), status: String(order.status || ""), dueAt: order.dueAt ? new Date(order.dueAt).toISOString() : null, scheduledAt: order.scheduledAt ? new Date(order.scheduledAt).toISOString() : null, createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : null } : null,
      };
    }),
    count: visible.length, nextCursor, hasMore, canRetry: canRetry === true, serverNow: new Date().toISOString(),
  };
}

async function retryTelegramConfirmedProjection({ agencyId, member, intentId, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  if (!await canUsePermission({ member, key: "content.review_customs", db: client })) throw fail("TELEGRAM_CONFIRMED_PROJECTION_RETRY_FORBIDDEN", "content.review_customs permission is required", 403);
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId, ...scopeWhere(scope), state: "CONFIRMED" } });
  if (!row) throw fail("TELEGRAM_CONFIRMED_PROJECTION_INTENT_NOT_FOUND", "Confirmed Telegram delivery intent not found", 404);
  await projectConfirmedIntentObserved({ row, now: row.confirmedAt ? new Date(row.confirmedAt) : now, db: client });
  await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_confirmed_projection_retry", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind, remoteMessageId: row.remoteMessageId }, db: client });
  const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  return { ok: true, intentId: String(row.id), projectionBlocked: Boolean(fresh?.projectionBlockedAt), projectionBlockedCode: fresh?.projectionBlockedCode || null };
}

async function listTelegramDeliveryReconciliationQueue({ agencyId, member, limit = 50, cursor = null, db = null } = {}) {
  const client = db || require("../prisma");
  if (!await canUsePermission({ member, key: "team.analytics.view", db: client })) throw fail("TELEGRAM_DELIVERY_RECONCILE_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  const afterId = clean(cursor, 180);
  // RECONCILE_REQUIRED is durable operator work.  Preserve the original oldest-unknown-outcome
  // priority while continuing losslessly from the unique intent id cursor.
  const discovered = await client.telegramDeliveryIntent.findMany({
    where: { agencyId, ...scopeWhere(scope), state: "RECONCILE_REQUIRED" },
    orderBy: [{ commitStartedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    take: take + 1,
  });
  const hasMore = (discovered || []).length > take;
  const rows = (discovered || []).slice(0, take);
  const nextCursor = hasMore && rows.length ? String(rows[rows.length - 1].id) : null;
  const creatorIds = Array.from(new Set((rows || []).map((row) => String(row.creatorId || "")).filter(Boolean)));
  const orderIds = Array.from(new Set((rows || []).map((row) => String(row.customOrderId || "")).filter(Boolean)));
  const creators = creatorIds.length && client.creatorAccount?.findMany
    ? await client.creatorAccount.findMany({ where: { agencyId, id: { in: creatorIds } }, select: { id: true, displayName: true, username: true, avatarUrl: true, deletedAt: true } })
    : [];
  const orders = orderIds.length && client.customOrder?.findMany
    ? await client.customOrder.findMany({ where: { agencyId, id: { in: orderIds } }, select: { id: true, creatorId: true, scenario: true, type: true, status: true, dueAt: true, scheduledAt: true, createdAt: true } })
    : [];
  const creatorById = new Map((creators || []).map((row) => [String(row.id), row]));
  const orderById = new Map((orders || []).map((row) => [String(row.id), row]));
  const canResolve = await canUsePermission({ member, key: "content.review_customs", db: client });
  return {
    ok: true,
    items: (rows || []).map((row) => ({
      ...publicIntent(row),
      creator: creatorById.has(String(row.creatorId)) ? {
        id: String(creatorById.get(String(row.creatorId)).id),
        displayName: creatorById.get(String(row.creatorId)).displayName || null,
        username: creatorById.get(String(row.creatorId)).username || null,
        avatarUrl: creatorById.get(String(row.creatorId)).avatarUrl || null,
        deleted: creatorById.get(String(row.creatorId)).deletedAt != null,
      } : null,
      customOrder: orderById.has(String(row.customOrderId)) ? {
        customOrderId: String(orderById.get(String(row.customOrderId)).id),
        creatorId: String(orderById.get(String(row.customOrderId)).creatorId),
        scenario: orderById.get(String(row.customOrderId)).scenario || "",
        type: String(orderById.get(String(row.customOrderId)).type || ""),
        status: String(orderById.get(String(row.customOrderId)).status || ""),
        dueAt: orderById.get(String(row.customOrderId)).dueAt ? new Date(orderById.get(String(row.customOrderId)).dueAt).toISOString() : null,
        scheduledAt: orderById.get(String(row.customOrderId)).scheduledAt ? new Date(orderById.get(String(row.customOrderId)).scheduledAt).toISOString() : null,
        createdAt: orderById.get(String(row.customOrderId)).createdAt ? new Date(orderById.get(String(row.customOrderId)).createdAt).toISOString() : null,
      } : null,
    })),
    count: (rows || []).length,
    nextCursor,
    hasMore,
    canResolve: canResolve === true,
    serverNow: new Date().toISOString(),
  };
}

async function listTelegramDeliveryPrecommitBlockedQueue({ agencyId, member, limit = 50, cursor = null, db = null } = {}) {
  const client = db || require("../prisma");
  if (!await canUsePermission({ member, key: "team.analytics.view", db: client })) throw fail("TELEGRAM_DELIVERY_BLOCKED_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  const afterId = clean(cursor, 180);
  const discovered = await client.telegramDeliveryIntent.findMany({
    where: {
      agencyId,
      ...scopeWhere(scope),
      commitStartedAt: null,
      OR: [
        { state: "PLANNED", outcomeReason: { startsWith: "PRECOMMIT_PROVIDER_UNAVAILABLE:" } },
        { state: "FAILED_PRECOMMIT" },
      ],
    },
    orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    take: take + 1,
  });
  const hasMore = (discovered || []).length > take;
  const rows = (discovered || []).slice(0, take);
  const nextCursor = hasMore && rows.length ? String(rows[rows.length - 1].id) : null;
  const creatorIds = Array.from(new Set(rows.map((row) => String(row.creatorId || "")).filter(Boolean)));
  const orderIds = Array.from(new Set(rows.map((row) => String(row.customOrderId || "")).filter(Boolean)));
  const creators = creatorIds.length && client.creatorAccount?.findMany
    ? await client.creatorAccount.findMany({ where: { agencyId, id: { in: creatorIds } }, select: { id: true, displayName: true, username: true, avatarUrl: true, deletedAt: true, telegramContact: true, telegramAccountId: true } })
    : [];
  const orders = orderIds.length && client.customOrder?.findMany
    ? await client.customOrder.findMany({ where: { agencyId, id: { in: orderIds } }, select: { id: true, creatorId: true, scenario: true, type: true, status: true, dueAt: true, scheduledAt: true, createdAt: true } })
    : [];
  const creatorById = new Map((creators || []).map((row) => [String(row.id), row]));
  const orderById = new Map((orders || []).map((row) => [String(row.id), row]));
  return {
    ok: true,
    items: rows.map((row) => {
      const creator = creatorById.get(String(row.creatorId));
      const order = orderById.get(String(row.customOrderId));
      const rawReason = clean(row.outcomeReason, 500);
      return {
        ...publicIntent(row),
        blockedCode: rawReason.startsWith(PRECOMMIT_PROVIDER_UNAVAILABLE_PREFIX)
          ? rawReason.slice(PRECOMMIT_PROVIDER_UNAVAILABLE_PREFIX.length) || "PROVIDER_UNAVAILABLE"
          : rawReason.startsWith("FAILED_PRECOMMIT:")
            ? rawReason.slice("FAILED_PRECOMMIT:".length) || "PRECOMMIT_EXECUTION_FAILED"
            : "PRECOMMIT_EXECUTION_FAILED",
        externalEffectStarted: false,
        creator: creator ? {
          id: String(creator.id), displayName: creator.displayName || null, username: creator.username || null, avatarUrl: creator.avatarUrl || null,
          deleted: creator.deletedAt != null, telegramContact: creator.telegramContact || null, telegramAccountId: creator.telegramAccountId || null,
        } : null,
        customOrder: order ? {
          customOrderId: String(order.id), creatorId: String(order.creatorId), scenario: order.scenario || "", type: String(order.type || ""), status: String(order.status || ""),
          dueAt: order.dueAt ? new Date(order.dueAt).toISOString() : null,
          scheduledAt: order.scheduledAt ? new Date(order.scheduledAt).toISOString() : null,
          createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : null,
        } : null,
      };
    }),
    count: rows.length,
    nextCursor,
    hasMore,
    serverNow: new Date().toISOString(),
  };
}

async function listTelegramReminderPlanningBlockedQueue({ agencyId, member, limit = 50, cursor = null, now = new Date(), scanBudget = 1000, db = null } = {}) {
  const client = db || require("../prisma");
  if (!await canUsePermission({ member, key: "team.analytics.view", db: client })) throw fail("TELEGRAM_REMINDER_BLOCKED_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  const afterId = clean(cursor, 180);
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
  const blocked = [];
  let scanCursor = afterId || null;
  let exhausted = false;
  let scannedRows = 0;
  const maxScan = Math.max(200, Math.min(5000, Math.floor(Number(scanBudget) || 1000)));

  while (blocked.length < take + 1 && !exhausted && scannedRows < maxScan) {
    const rows = await client.customOrder.findMany({
      where: {
        agencyId,
        ...scopeWhere(scope),
        status: "PENDING",
        // CONTENT reminder eligibility belongs to the current model obligation, not to the
        // legacy TASK scalar projection. Historical no-TASK revisions can own the current
        // provider-confirmed obligation and must remain visible when reminder planning is
        // blocked. The authority check below filters orders that no longer owe model work.
        nextReminderAt: { lte: now },
      },
      include: { creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, deletedAt: true, telegramContact: true, telegramAccountId: true } } },
      orderBy: [{ nextReminderAt: "asc" }, { id: "asc" }],
      take: Math.min(200, maxScan - scannedRows),
      ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
    });
    if (!rows.length) { exhausted = true; break; }
    scannedRows += rows.length;
    for (const order of rows) {
      scanCursor = String(order.id);
      if (await findUnresolvedReminder({ agencyId, orderId: order.id, db: client })) continue;
      let thread = null;
      let blockedCode = null;
      try {
        thread = await resolveReminderProviderBinding({ agencyId, order, db: client });
      } catch (error) {
        const code = String(error?.code || "");
        if (code === "CUSTOM_MODEL_OBLIGATION_NOT_WAITING_RESPONSE") continue;
        if (code === "TELEGRAM_DELIVERY_TASK_THREAD_REQUIRED" || code === "TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN") blockedCode = code;
        else throw error;
      }
      const due = desiredReminderSchedule(order, workspacePolicy, now, { modelObligation: thread?.obligation || null });
      if (!clean(due?.key, 500) || (due?.at && new Date(due.at).getTime() > now.getTime())) continue;

      let accountId = thread?.accountId ? String(thread.accountId) : null;
      if (!blockedCode && thread) {
        if (!client.agencyTelegramMtprotoAccount?.findFirst) throw fail("TELEGRAM_REMINDER_ACCOUNT_LOOKUP_UNAVAILABLE", "Telegram account lookup is unavailable", 503);
        const account = await client.agencyTelegramMtprotoAccount.findFirst({
          where: { id: String(thread.accountId), agencyId },
          select: { id: true, lifecycleState: true },
        });
        if (!account) blockedCode = "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED";
        else if (!isActiveTelegramAccount(account)) blockedCode = "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING";
      }
      if (!blockedCode) continue;

      const creator = order.creator || null;
      blocked.push({
        id: `reminder-planning:${String(order.id)}`,
        customOrderId: String(order.id),
        creatorId: String(order.creatorId),
        accountId,
        kind: "AUTO_REMINDER",
        blockedCode,
        externalEffectStarted: false,
        nextReminderAt: order.nextReminderAt ? new Date(order.nextReminderAt).toISOString() : null,
        creator: creator ? {
          id: String(creator.id), displayName: creator.displayName || null, username: creator.username || null, avatarUrl: creator.avatarUrl || null,
          deleted: creator.deletedAt != null, telegramContact: creator.telegramContact || null, telegramAccountId: creator.telegramAccountId || null,
        } : null,
        customOrder: {
          customOrderId: String(order.id), creatorId: String(order.creatorId), scenario: order.scenario || "", type: String(order.type || ""), status: String(order.status || ""),
          dueAt: order.dueAt ? new Date(order.dueAt).toISOString() : null,
          scheduledAt: order.scheduledAt ? new Date(order.scheduledAt).toISOString() : null,
          createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : null,
        },
        _cursor: String(order.id),
      });
      if (blocked.length >= take + 1) break;
    }
    exhausted = rows.length < Math.min(200, maxScan - (scannedRows - rows.length));
  }

  const visibleOverflow = blocked.length > take;
  const visible = blocked.slice(0, take);
  const scanComplete = exhausted;
  const hasMore = visibleOverflow || !scanComplete;
  const nextCursor = hasMore ? (visibleOverflow && visible.length ? visible[visible.length - 1]._cursor : scanCursor) : null;
  return {
    ok: true,
    items: visible.map(({ _cursor, ...row }) => row),
    count: visible.length,
    nextCursor,
    hasMore,
    scanComplete,
    scannedRows,
    serverNow: new Date().toISOString(),
  };
}

async function reconcileTelegramDeliveryIntent({ agencyId, member, intentId, resolution, remoteMessageId = null, remoteRecipientTelegramUserId = null, remoteSentAt = null, reason = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const id = clean(intentId, 180);
  if (!await canUsePermission({ member, key: "content.review_customs", db: client })) throw fail("TELEGRAM_DELIVERY_RECONCILE_FORBIDDEN", "content.review_customs permission is required", 403);
  const justification = clean(reason, 500);
  if (!justification) throw fail("TELEGRAM_DELIVERY_RECONCILE_REASON_REQUIRED", "A reconciliation reason is required");
  if (typeof client?.$transaction !== "function") throw fail("TELEGRAM_DELIVERY_RECONCILE_TRANSACTION_REQUIRED", "Manual Telegram reconciliation requires transactional audit authority", 500);
  const mode = clean(resolution, 40).toUpperCase();
  if (!["CONFIRMED", "PROVEN_NOT_SENT"].includes(mode)) throw fail("TELEGRAM_DELIVERY_RECONCILE_RESOLUTION_INVALID", "resolution must be CONFIRMED or PROVEN_NOT_SENT");
  try {
    const fresh = await client.$transaction(async (tx) => {
      const currentMember = await lockCurrentAgencyMember({ agencyId, actorMember: member, db: tx });
      if (!await canUsePermission({ member: currentMember, key: "content.review_customs", db: tx })) {
        throw fail("TELEGRAM_DELIVERY_RECONCILE_FORBIDDEN", "content.review_customs permission is required", 403);
      }
      const row = await tx.telegramDeliveryIntent.findFirst({ where: { id, agencyId } });
      if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
      // Historical provider exceptions can outlive the mutable/active Creator row. A broad
      // Customs reviewer may adjudicate that durable agency-owned exception; scoped members
      // still require current creator access and therefore cannot cross their assignment fence.
      const exceptionScope = await allowedCreatorScope({ agencyId, member: currentMember, db: tx });
      if (!exceptionScope?.broad) await requireCreatorAccess({ agencyId, member: currentMember, creatorId: row.creatorId, db: tx });
      if (row.state !== "RECONCILE_REQUIRED") throw fail("TELEGRAM_DELIVERY_NOT_RECONCILABLE", "Telegram delivery is not awaiting reconciliation", 409);
      if (mode === "CONFIRMED") {
        const messageId = positiveInt(remoteMessageId, "remoteMessageId");
        const recipientTelegramUserId = clean(remoteRecipientTelegramUserId, 40);
        if (recipientTelegramUserId && !/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_RECIPIENT_ID_INVALID", "remoteRecipientTelegramUserId must be a numeric Telegram user id");
        if (String(row.kind) === "TASK" && !/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_TASK_RECIPIENT_REQUIRED", "TASK reconciliation requires the Telegram recipient user id used for the manual decision", 409);
        const sentAt = iso(remoteSentAt, "remoteSentAt", now) || now;
        await assertProviderReceiptIdentityAvailable({ agencyId, accountId: row.accountId, remoteMessageId: messageId, excludeIntentId: row.id, db: tx });
        let changed;
        try {
          changed = await tx.telegramDeliveryIntent.updateMany({
            where: { id: row.id, agencyId, state: "RECONCILE_REQUIRED", claimRevision: row.claimRevision },
            data: { state: "CONFIRMED", remoteMessageId: messageId, ...(recipientTelegramUserId ? { remoteRecipientTelegramUserId: recipientTelegramUserId } : {}), remoteSentAt: sentAt, confirmedAt: now, outcomeReason: `MANUAL_CONFIRMED:${justification}`, confirmationAuthority: "MANUAL_RECONCILIATION" },
          });
        } catch (error) {
          if (String(error?.code || "") === "P2002") throw fail("TELEGRAM_DELIVERY_REMOTE_MESSAGE_CONFLICT", "This Telegram account/message receipt is already owned by another delivery intent", 409);
          throw error;
        }
        if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_RECONCILE_RACE", "Telegram delivery changed during reconciliation", 409);
        const settled = await tx.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
        await projectConfirmedIntent({ row: settled, now, db: tx });
        await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_delivery_manual_reconcile_confirm", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind, remoteMessageId: messageId, reason: justification, authority: "MANUAL_RECONCILIATION" }, db: tx, required: true });
        return settled;
      }
      const orderExists = await tx.customOrder.findFirst({ where: { id: row.customOrderId, agencyId }, select: { id: true } });
      const orphan = !orderExists;
      const changed = await tx.telegramDeliveryIntent.updateMany({
        where: { id: row.id, agencyId, state: "RECONCILE_REQUIRED", claimRevision: row.claimRevision },
        data: orphan
          ? {
              state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null,
              claimTokenHash: null, claimUntil: null, commitStartedAt: null,
              claimRevision: Number(row.claimRevision || 0) + 1,
              outcomeReason: `PROVEN_NOT_SENT_ORPHAN:${justification}`, confirmationAuthority: null,
            }
          : {
              state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null,
              claimTokenHash: null, claimUntil: null, commitStartedAt: null,
              outcomeReason: `PROVEN_NOT_SENT:${justification}`, confirmationAuthority: null,
            },
      });
      if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_RECONCILE_RACE", "Telegram delivery changed during reconciliation", 409);
      await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_delivery_manual_reconcile_not_sent", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind, reason: justification, orphanCustomOrder: orphan }, db: tx, required: true });
      if (!orphan) {
        const cancelledOrder = await tx.customOrder.findFirst({ where: { id: row.customOrderId, agencyId, status: "CANCELLED" } });
        if (cancelledOrder && !cancelledOrder.telegramCancellationWaivedAt) {
          await ensureCancellationIntentForCancelledOrder({
            agencyId, order: cancelledOrder, actorUserId: member?.userId || null,
            reason: `${String(row.kind)}_MANUAL_PROVEN_NOT_SENT_AFTER_CANCELLATION`, now, db: tx,
          });
        }
      }
      return tx.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    }, { isolationLevel: "Serializable" });
    if (mode === "CONFIRMED") await reconcileInboundAfterConfirmedReceipt({ row: fresh, member, now, db: client });
    return { ok: true, intent: publicIntent(fresh) };
  } catch (error) {
    if (String(error?.code || "") === "P2034") throw fail("TELEGRAM_DELIVERY_RECONCILE_RACE", "Telegram reconciliation changed concurrently; refresh and retry", 409);
    throw error;
  }
}

async function planTaskIntentForCommittedOrder({ agencyId, member, order, now = new Date(), db, reactivateCancelled = false }) {
  if (!order || String(order.status) !== "PENDING" || !clean(order.creator?.telegramContact, 160)) return null;
  let obligation;
  try {
    obligation = await assertInitialTaskDispatchCurrent({ agencyId, order, allowMissing: true, allowCancelled: reactivateCancelled === true, allowAnyInitialState: true, db });
  } catch (error) {
    if (String(error?.code || "") === "CUSTOM_MODEL_INITIAL_INSTRUCTION_NOT_REQUIRED") return null;
    throw error;
  }
  if (String(obligation?.deliveryState || "") === "CANCELLED" && reactivateCancelled !== true) return null;
  let accountId;
  try { accountId = await resolveAccountForOrder({ agencyId, order, db }); } catch { return null; }
  const payload = taskPayload(order);
  const reserved = await createOrReadIntent({
    agencyId, order, accountId: String(accountId), kind: "TASK", identity: "one", payload, now, db,
    reactivateCancelledTask: reactivateCancelled === true,
  });
  if (reserved.created || reserved.reactivated) {
    await audit({
      agencyId, actorUserId: member?.userId || null,
      action: reserved.reactivated ? "custom_order.telegram_task_reactivate" : "custom_order.telegram_task_plan",
      targetType: "TelegramDeliveryIntent", targetId: reserved.row.id,
      metadata: { orderId: order.id, creatorId: order.creatorId, causalAuthority: reserved.reactivated ? "CURRENT_MODEL_OBLIGATION" : "ORDER_COMMIT" },
      db,
    });
  }
  return reserved.row;
}

async function ensureCancellationIntentForCancelledOrder({ agencyId, order, actorUserId = null, reason = "CUSTOM_ORDER_CANCELLED", now = new Date(), db }) {
  if (!order || String(order.status) !== "CANCELLED" || order.telegramCancellationWaivedAt) return null;
  let binding;
  try {
    binding = await resolveCancellationProviderBinding({ agencyId, order, db });
  } catch (error) {
    // Business cancellation is allowed to win while a model instruction outcome is unknown.
    // Follow-up delivery waits for that provider fact; CONFIRMED / PROVEN_NOT_SENT settlement
    // re-enters this same authority. No provider outcome is guessed here.
    if ([
      "CUSTOM_CANCELLATION_MODEL_INSTRUCTION_NOT_DELIVERED",
      "CUSTOM_CANCELLATION_INSTRUCTION_OUTCOME_UNRESOLVED",
    ].includes(String(error?.code || ""))) return null;
    throw error;
  }
  const payload = {
    text: cancellationText(order),
    replyToDeliveryId: null,
    replyToMessageId: binding.replyToMessageId,
    recipientTelegramUserId: binding.recipientTelegramUserId,
  };
  const reserved = await createOrReadIntent({
    agencyId, order, accountId: binding.accountId, kind: "CANCELLATION", identity: "one", payload, now, db,
  });
  if (reserved.created || reserved.reactivated || reserved.refreshed) {
    await audit({
      agencyId, actorUserId, action: "custom_order.telegram_cancellation_plan",
      targetType: "TelegramDeliveryIntent", targetId: reserved.row.id,
      metadata: {
        orderId: order.id, creatorId: order.creatorId, reason,
        instructionKind: binding.anchorKind, instructionIntentId: binding.instructionIntentId || null,
      },
      db,
    });
  }
  return reserved.row;
}

async function planCancellationIntentForCommittedOrder({ agencyId, member, order, now = new Date(), db }) {
  return ensureCancellationIntentForCancelledOrder({
    agencyId, order, actorUserId: member?.userId || null, reason: "CUSTOM_ORDER_CANCELLED", now, db,
  });
}

module.exports = {
  CLAIM_MS,
  DELIVERY_KINDS,
  DELIVERY_STATES,
  publicIntent,
  planTelegramDeliveryIntent,
  planTaskIntentForCommittedOrder,
  planCancellationIntentForCommittedOrder,
  planRevisionRequestIntentForReviewedSubmission,
  revisionDecisionFingerprint,
  ensureAutomaticReminderIntentForOrder,
  ensureAutomaticReminderIntents,
  repairPrecommitProviderBlockedIntents,
  listTelegramDeliveryWork,
  claimTelegramDeliveryIntent,
  beginTelegramDeliveryIntent,
  confirmTelegramDeliveryIntent,
  repairConfirmedTelegramDeliveryProjections,
  repairConfirmedTelegramDeliveryProjectionItem,
  repairCurrentCustomModelCommunicationForOrder,
  repairClaimedCustomModelCommunicationWork,
  repairCustomModelCommunicationConvergence,
  markTelegramDeliveryUnknown,
  markTelegramDeliveryProvenNotSent,
  failTelegramDeliveryPrecommit,
  replaceTelegramReferencePrecommit,
  cancelTelegramReferencePrecommit,
  getTelegramOrderContext,
  assertTelegramDeliveryMaterialAccess,
  listTelegramDeliveryReconciliationQueue,
  listTelegramConfirmedProjectionBlockedQueue,
  retryTelegramConfirmedProjection,
  listTelegramDeliveryPrecommitBlockedQueue,
  listTelegramReminderPlanningBlockedQueue,
  reconcileTelegramDeliveryIntent,
};
