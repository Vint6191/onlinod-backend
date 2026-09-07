"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { assertExecutionAccessFence } = require("./execution-access-fence-service");
const { assertTelegramRuntimeLease } = require("./telegram-execution-runtime");
const { reconcilePendingInboundForConfirmedDelivery } = require("./telegram-inbound-authority-service");
const { canUsePermission } = require("./team-access-control");
const { lockActiveTelegramAccountReference } = require("./telegram-account-reference-authority-service");
const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
const { scanAllById, findPendingTaskAnchors, findCancelledTaskFollowupDebt } = require("./telegram-exact-authority-scan-service");
const {
  nextReminderForOrder,
  desiredReminderSchedule,
  readWorkspaceReminderPolicy,
  reprojectCustomReminderSchedule,
  reminderText,
  resolveTelegramAccountId,
  taskText,
} = require("./custom-order-reminders");

const DELIVERY_KINDS = Object.freeze(["TASK", "REFERENCE", "MANUAL_REMINDER", "AUTO_REMINDER", "CANCELLATION"]);
const DELIVERY_STATES = Object.freeze(["PLANNED", "CLAIMED", "COMMITTING", "CONFIRMED", "RECONCILE_REQUIRED", "CANCELLED", "FAILED_PRECOMMIT"]);
const KIND_SET = new Set(DELIVERY_KINDS);
const REMINDER_KINDS = new Set(["MANUAL_REMINDER", "AUTO_REMINDER"]);
const UNRESOLVED_REMINDER_STATES = ["COMMITTING", "RECONCILE_REQUIRED"];
const UNRESOLVED_REFERENCE_STATES = ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT"];
const CLAIM_MS = 2 * 60 * 1000;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 500) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }
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
    id: String(row.id), creatorId: String(row.creatorId), customOrderId: String(row.customOrderId), accountId: String(row.accountId),
    kind: String(row.kind), logicalKey: String(row.logicalKey), clientIntentId: row.clientIntentId || null,
    referenceOrdinal: row.referenceOrdinal == null ? null : Number(row.referenceOrdinal), payloadFingerprint: String(row.payloadFingerprint), payload,
    state: String(row.state), claimRevision: Number(row.claimRevision || 0), claimUntil: row.claimUntil ? new Date(row.claimUntil).toISOString() : null,
    commitStartedAt: row.commitStartedAt ? new Date(row.commitStartedAt).toISOString() : null,
    remoteMessageId: row.remoteMessageId == null ? null : String(row.remoteMessageId), remoteRecipientTelegramUserId: row.remoteRecipientTelegramUserId || null, remoteSentAt: row.remoteSentAt ? new Date(row.remoteSentAt).toISOString() : null,
    outcomeReason: row.outcomeReason || null, confirmationAuthority: row.confirmationAuthority || null, confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
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
  if (!account || String(account.lifecycleState || "ACTIVE") !== "ACTIVE") throw fail("CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING", "Telegram connection is retiring and cannot accept new Custom delivery work", 409);
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

async function resolveIntentProviderBinding({ agencyId, order, kind, db }) {
  if (String(kind) === "TASK") {
    return { accountId: await resolveAccountForOrder({ agencyId, order, db }), replyToMessageId: null, recipientTelegramUserId: null };
  }
  return loadConfirmedTaskThread({ agencyId, orderId: order.id, db });
}

async function createOrReadIntent({ agencyId, order, accountId, kind, identity, clientIntentId = null, referenceOrdinal = null, payload, now, db, _transactional = false }) {
  // New Telegram work and Telegram-account retirement contend on the same account row.
  // Running the canonical-intent reservation in one transaction lets the no-op ACTIVE
  // update below act as a row mutex: either planning wins and retirement sees the new
  // blocker, or retirement wins and planning cannot create a new intent afterwards.
  if (!_transactional && typeof db?.$transaction === "function") {
    return db.$transaction(
      (tx) => createOrReadIntent({ agencyId, order, accountId, kind, identity, clientIntentId, referenceOrdinal, payload, now, db: tx, _transactional: true }),
      { isolationLevel: "Serializable" },
    );
  }
  const key = logicalKey({ agencyId, orderId: order.id, kind, identity });
  const fingerprint = payloadFingerprint(payload);
  const findCanonicalExisting = async () => {
    const byKey = await db.telegramDeliveryIntent.findUnique({ where: { logicalKey: key } });
    if (byKey) return byKey;
    if (String(kind) !== "REFERENCE" || !Number.isInteger(Number(referenceOrdinal))) return null;
    // REFERENCE has exactly one business identity: order + ordinal. clientIntentId is correlation only.
    return db.telegramDeliveryIntent.findFirst({
      where: { agencyId, customOrderId: order.id, kind: "REFERENCE", referenceOrdinal: Number(referenceOrdinal) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  };
  const useExisting = async (existing) => {
    const exact = String(existing.payloadFingerprint) === fingerprint && String(existing.creatorId) === String(order.creatorId) && String(existing.accountId) === String(accountId);
    if (exact) return { row: existing, created: false, refreshed: false };

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
          accountId: String(accountId), payloadFingerprint: fingerprint, payload, state: "PLANNED",
          deviceId: null, userId: null, memberId: null, accessEpoch: null,
          claimTokenHash: null, claimUntil: null, claimRevision: nextRevision,
          outcomeReason: `PRECOMMIT_${String(kind)}_REFRESH`,
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

  const existing = await findCanonicalExisting();
  if (existing && !mayReactivateCancelledCancellation(existing)) return useExisting(existing);

  // NEW outbound Custom work participates in the same parent/creator retirement
  // serialization as CustomOrder/submission/provider intake. The global lock order is
  // Agency -> CreatorAccount -> TelegramAccount. This is crucial for terminal-order
  // follow-ups such as CANCELLATION: the order itself no longer blocks retirement.
  await lockAgencyPipelineLifecycle({ db, agencyId });
  await lockCreatorPipelineLifecycle({ db, agencyId, creatorId: order.creatorId });

  // Re-read after lifecycle locks. Another transaction may have created the canonical
  // intent while we waited; preserve exactly-once identity before taking the account lock.
  const afterLifecycle = await findCanonicalExisting();
  if (afterLifecycle && !mayReactivateCancelledCancellation(afterLifecycle)) return useExisting(afterLifecycle);

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
  if (mayReactivateCancelledCancellation(cancelledCanonical)) {
    const nextRevision = Number(cancelledCanonical.claimRevision || 0) + 1;
    const changed = await db.telegramDeliveryIntent.updateMany({
      where: {
        id: cancelledCanonical.id, agencyId, kind: "CANCELLATION", state: "CANCELLED",
        claimRevision: Number(cancelledCanonical.claimRevision || 0), commitStartedAt: null,
      },
      data: {
        accountId: String(accountId), payloadFingerprint: fingerprint, payload, state: "PLANNED",
        deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null,
        claimRevision: nextRevision, outcomeReason: "CANCELLATION_REACTIVATED_FOR_TERMINAL_ORDER",
      },
    });
    if (Number(changed?.count || 0) === 1) {
      const fresh = await findCanonicalExisting();
      return { row: fresh, created: false, refreshed: true, reactivated: true };
    }
    const raced = await findCanonicalExisting();
    if (raced && !mayReactivateCancelledCancellation(raced)) return useExisting(raced);
    throw fail("TELEGRAM_DELIVERY_INTENT_RACE", "Cancelled Telegram intent could not be reactivated from current lifecycle state", 409);
  }

  try {
    const row = await db.telegramDeliveryIntent.create({ data: {
      agencyId, creatorId: order.creatorId, customOrderId: order.id, accountId, kind, logicalKey: key,
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

async function planTelegramDeliveryIntent({ agencyId, member, orderId, kind, clientIntentId = null, reference = null, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("TELEGRAM_DELIVERY_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedKind = clean(kind, 40).toUpperCase();
  if (!KIND_SET.has(normalizedKind) || normalizedKind === "AUTO_REMINDER") throw fail("TELEGRAM_DELIVERY_KIND_INVALID", "Unsupported user-planned Telegram delivery kind");
  const order = await loadOrder({ agencyId, orderId, db: client });
  await requireCreatorAccess({ agencyId, member, creatorId: order.creatorId, db: client });
  const status = String(order.status || "PENDING").toUpperCase();
  let binding = null; let accountId = null;
  let identity = "one"; let normalizedClientIntentId = null; let referenceOrdinal = null; let payload;
  if (normalizedKind === "TASK") {
    if (status !== "PENDING") throw fail("CUSTOM_ORDER_TELEGRAM_TASK_STATE_INVALID", "A new Telegram task can only be delivered for a pending custom order", 409);
    binding = await resolveIntentProviderBinding({ agencyId, order, kind: normalizedKind, db: client });
    accountId = String(binding.accountId);
    payload = taskPayload(order);
  } else if (normalizedKind === "CANCELLATION") {
    if (status !== "CANCELLED") throw fail("CUSTOM_ORDER_TELEGRAM_STATUS_INVALID", "Cancellation delivery requires a cancelled custom order", 409);
    if (order.telegramTaskMessageId == null) return { ok: true, skipped: true, reason: "TASK_NOT_DELIVERED", intent: null };
    binding = await resolveIntentProviderBinding({ agencyId, order, kind: normalizedKind, db: client }); accountId = String(binding.accountId);
    payload = { text: cancellationText(order), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  } else if (normalizedKind === "MANUAL_REMINDER") {
    if (status !== "PENDING") throw fail("CUSTOM_ORDER_REMINDER_STATE_INVALID", "Only pending custom orders can be reminded", 409);
    if (order.telegramTaskMessageId == null) throw fail("CUSTOM_ORDER_TELEGRAM_REQUIRED", "Send the custom to Telegram before reminding the model", 409);
    const unresolvedReminder = await findUnresolvedReminder({ agencyId, orderId: order.id, db: client });
    if (unresolvedReminder) throw fail("CUSTOM_ORDER_REMINDER_OUTCOME_UNRESOLVED", "A previous reminder outcome is unresolved and must be reconciled before another reminder can be sent", 409);
    binding = await resolveIntentProviderBinding({ agencyId, order, kind: normalizedKind, db: client }); accountId = String(binding.accountId);
    normalizedClientIntentId = uuid(clientIntentId);
    identity = normalizedClientIntentId;
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
    payload = { text: reminderText(order, order.creator, workspacePolicy, now), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId, reminderKey: `MANUAL:${normalizedClientIntentId}` };
  } else {
    if (status !== "PENDING") throw fail("CUSTOM_ORDER_REFERENCE_STATE_INVALID", "References can only be delivered for a pending custom order", 409);
    if (order.telegramTaskMessageId == null) throw fail("CUSTOM_ORDER_TELEGRAM_TASK_REQUIRED", "Confirm the Telegram task before delivering references", 409);
    binding = await resolveIntentProviderBinding({ agencyId, order, kind: normalizedKind, db: client }); accountId = String(binding.accountId);
    normalizedClientIntentId = uuid(clientIntentId);
    const ref = reference && typeof reference === "object" ? reference : {};
    referenceOrdinal = Math.max(0, Math.floor(Number(ref.ordinal) || 0));
    identity = `slot:${referenceOrdinal}`;
    const name = clean(ref.name, 500); const sha256Value = clean(ref.sha256, 64).toLowerCase(); const size = Number(ref.size);
    if (!name || !/^[0-9a-f]{64}$/.test(sha256Value) || !Number.isSafeInteger(size) || size < 0) throw fail("CUSTOM_ORDER_REFERENCE_PROOF_REQUIRED", "Reference name, size and sha256 are required");
    payload = { reference: { name, size, sha256: sha256Value }, replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  }
  const reserved = await createOrReadIntent({ agencyId, order, accountId: String(accountId), kind: normalizedKind, identity, clientIntentId: normalizedClientIntentId, referenceOrdinal, payload, now, db: client });
  if (reserved.created) await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.telegram_delivery_plan", targetType: "TelegramDeliveryIntent", targetId: reserved.row.id, metadata: { orderId: order.id, creatorId: order.creatorId, kind: normalizedKind }, db: client });
  return { ok: true, skipped: false, created: reserved.created, intent: publicIntent(reserved.row) };
}

async function ensureAutomaticReminderIntents({ agencyId, member, limit = 25, now = new Date(), db }) {
  const scope = await allowedCreatorScope({ agencyId, member, db });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
  let planned = 0;
  let cursor = null;
  while (planned < take) {
    const rows = await db.customOrder.findMany({
      where: { agencyId, ...scopeWhere(scope), status: "PENDING", telegramTaskMessageId: { not: null }, nextReminderAt: { lte: now } },
      include: { creator: { select: { id: true, displayName: true, username: true, telegramContact: true, telegramUserId: true, telegramAccountId: true } } },
      orderBy: [{ nextReminderAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const order of rows) {
      if (planned >= take) break;
      const unresolvedReminder = await findUnresolvedReminder({ agencyId, orderId: order.id, db });
      if (unresolvedReminder) continue;
      let binding;
      try {
        binding = await loadConfirmedTaskThread({ agencyId, orderId: order.id, db });
      } catch (error) {
        const code = String(error?.code || "");
        // A reminder cannot be planned until the confirmed TASK thread/recipient is proven.
        // Those are expected business-domain blockers and are exposed by the dedicated
        // reminder-planning exception queue. Unexpected DB/invariant failures must surface;
        // swallowing them here would turn broken durable work into a false empty scheduler.
        if (code === "TELEGRAM_DELIVERY_TASK_THREAD_REQUIRED" || code === "TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN") continue;
        throw error;
      }
      const accountId = String(binding.accountId);
      const due = nextReminderForOrder(order, workspacePolicy, now, { afterAck: false });
      const reminderKey = clean(due.key || order.lastReminderKey || (order.nextReminderAt ? `AT:${new Date(order.nextReminderAt).toISOString()}` : ""), 500);
      if (!reminderKey || (due.at && due.at.getTime() > now.getTime())) continue;
      const payload = { text: reminderText(order, order.creator, workspacePolicy, now), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId, reminderKey };
      try {
        await createOrReadIntent({ agencyId, order, accountId, kind: "AUTO_REMINDER", identity: sha256(reminderKey).slice(0, 32), payload, now, db });
        planned += 1;
      } catch (error) {
        const code = String(error?.code || "");
        // Historical versions could retire/delete the pinned TASK account before this exact
        // reminder obligation was drained. That reminder is currently impossible to execute,
        // but it must not abort the whole executable-work endpoint and starve unrelated healthy
        // deliveries. Only provider-capability domain failures are isolated here; DB/invariant
        // failures still surface so correctness bugs cannot be silently swallowed.
        if (code === "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED" || code === "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING") continue;
        throw error;
      }
    }
    if (rows.length < 200) break;
  }
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

  let binding; let accountId;
  try { binding = await resolveIntentProviderBinding({ agencyId, order, kind, db }); accountId = String(binding.accountId); }
  catch (error) {
    // Missing/reassigned provider binding is not a remote effect and must not destroy D1.
    // Keep it durable but do not expose the stale account to Desktop execution.
    await db.telegramDeliveryIntent.updateMany({
      where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
      data: { state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: `PRECOMMIT_PROVIDER_UNAVAILABLE:${clean(error?.code || error?.message, 300)}` },
    });
    return null;
  }

  let identity = "one"; let clientIntentId = row.clientIntentId || null; let referenceOrdinal = row.referenceOrdinal == null ? null : Number(row.referenceOrdinal); let payload;
  if (kind === "TASK") {
    payload = taskPayload(order);
  } else if (kind === "CANCELLATION") {
    if (order.telegramTaskMessageId == null) return null;
    payload = { text: cancellationText(order), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  } else if (kind === "MANUAL_REMINDER") {
    if (!clientIntentId || order.telegramTaskMessageId == null) return null;
    identity = String(clientIntentId);
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
    const reminderKey = clean(row.payload?.reminderKey, 500) || `MANUAL:${clientIntentId}`;
    payload = { text: reminderText(order, order.creator, workspacePolicy, now), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId, reminderKey };
  } else if (kind === "REFERENCE") {
    if (!clientIntentId || order.telegramTaskMessageId == null || !row.payload?.reference || !Number.isInteger(Number(referenceOrdinal))) return null;
    identity = `slot:${Number(referenceOrdinal)}`;
    payload = { reference: row.payload.reference, replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  } else if (kind === "AUTO_REMINDER") {
    if (order.telegramTaskMessageId == null) return null;
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
    const due = nextReminderForOrder(order, workspacePolicy, now, { afterAck: false });
    const plannedKey = clean(row.payload?.reminderKey, 500);
    if (!plannedKey || due.key !== plannedKey || (due.at && due.at.getTime() > now.getTime())) {
      await db.telegramDeliveryIntent.updateMany({
        where: { id: row.id, agencyId, state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, claimRevision: Number(row.claimRevision || 0), commitStartedAt: null },
        data: { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: "AUTO_REMINDER_POLICY_CHANGED" },
      });
      return db.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    }
    identity = sha256(plannedKey).slice(0, 32);
    payload = { text: reminderText(order, order.creator, workspacePolicy, now), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId, reminderKey: plannedKey };
  } else {
    return row;
  }

  const reserved = await createOrReadIntent({ agencyId, order, accountId: String(accountId), kind, identity, clientIntentId, referenceOrdinal, payload, now, db });
  return reserved.row;
}

async function listTelegramDeliveryWork({ agencyId, member, limit = 25, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("TELEGRAM_DELIVERY_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  await ensureAutomaticReminderIntents({ agencyId, member, limit, now, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
  const staleCommitBefore = new Date(now.getTime() - CLAIM_MS);
  await client.telegramDeliveryIntent.updateMany({
    where: { agencyId, ...scopeWhere(scope), state: "COMMITTING", commitStartedAt: { lte: staleCommitBefore } },
    data: { state: "RECONCILE_REQUIRED", outcomeReason: "COMMIT_PROCESS_LOST" },
  });
  const items = [];
  let cursor = null;
  while (items.length < take) {
    const rows = await client.telegramDeliveryIntent.findMany({
      // Executable scheduler capacity is reserved for proven-precommit work only.
      // RECONCILE_REQUIRED is durable manager work with an unknown provider outcome and
      // must never consume this limit; otherwise a backlog of unknown outcomes can
      // permanently hide healthy executable deliveries behind it.
      where: { agencyId, ...scopeWhere(scope), state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const snapshot of rows) {
      if (items.length >= take) break;
      let current = snapshot;
      if (["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(snapshot.state)) && snapshot.commitStartedAt == null) {
        current = await refreshPrecommitIntentFromCurrentState({ row: snapshot, agencyId, now, db: client });
      }
      if (!current || String(current.state) === "CANCELLED") continue;
      items.push(publicIntent(current));
    }
    if (rows.length < 200) break;
  }
  return { ok: true, items, serverNow: now.toISOString() };
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
  const binding = await resolveIntentProviderBinding({ agencyId, order, kind: String(row.kind), db });
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
    const due = nextReminderForOrder(order, workspacePolicy, now, { afterAck: false });
    const plannedKey = clean(row.payload?.reminderKey, 500);
    if (!plannedKey || due.key !== plannedKey || (due.at && due.at.getTime() > now.getTime())) throw fail("TELEGRAM_DELIVERY_CONTROL_CHANGED", "Reminder settings changed before Telegram commit", 409);
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
    if (kind === "TASK" || REMINDER_KINDS.has(kind)) {
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
      const recipientTelegramUserId = clean(row.remoteRecipientTelegramUserId, 40);
      if (!/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN", "Confirmed Telegram TASK is missing its provider recipient identity", 409);
      const payload = { text: cancellationText(settledOrder), replyToDeliveryId: null, replyToMessageId: String(remoteMessageId), recipientTelegramUserId };
      const reserved = await createOrReadIntent({ agencyId: row.agencyId, order: settledOrder, accountId: String(row.accountId), kind: "CANCELLATION", identity: "one", payload, now: effectAt, db });
      if (reserved.created) await audit({ agencyId: row.agencyId, actorUserId: row.userId || null, action: "custom_order.telegram_cancellation_plan", targetType: "TelegramDeliveryIntent", targetId: reserved.row.id, metadata: { orderId: settledOrder.id, creatorId: settledOrder.creatorId, reason: "TASK_SETTLED_AFTER_CANCELLATION" }, db });
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

function reminderScheduleProjectionConverged(order, workspacePolicy, now = new Date()) {
  const desired = desiredReminderSchedule(order, workspacePolicy, now);
  const desiredAt = desired?.at ? new Date(desired.at) : null;
  const actualAt = order?.nextReminderAt ? new Date(order.nextReminderAt) : null;
  const validDesired = desiredAt && Number.isFinite(desiredAt.getTime()) ? desiredAt : null;
  const validActual = actualAt && Number.isFinite(actualAt.getTime()) ? actualAt : null;
  if (!validDesired) return validActual === null;
  if (!validActual) return false;
  const nowMs = now.getTime();
  // Once work is already due, the exact historical due timestamp is not business truth.
  // Any persisted due-at-or-before-now value keeps the reminder executable without a hot rewrite.
  if (validDesired.getTime() <= nowMs && validActual.getTime() <= nowMs) return true;
  return validDesired.getTime() === validActual.getTime();
}

async function repairConfirmedTaskReminderScheduleDebt({ agencyId, now = new Date(), db }) {
  if (!db?.telegramDeliveryIntent?.findMany || !db?.customOrder?.findMany) {
    return { scanned: 0, repaired: 0, failed: 0, failures: [] };
  }
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
  let scanned = 0;
  let repaired = 0;
  const failures = [];

  await scanAllById({
    delegate: db.telegramDeliveryIntent,
    where: { agencyId, kind: "TASK", state: "CONFIRMED", remoteMessageId: { not: null } },
    select: { id: true, creatorId: true, customOrderId: true, remoteMessageId: true },
    pageSize: 250,
    onPage: async (rows) => {
      const orderIds = Array.from(new Set((rows || []).map((row) => clean(row.customOrderId, 180)).filter(Boolean)));
      if (!orderIds.length) return false;
      const orders = await db.customOrder.findMany({
        where: { agencyId, id: { in: orderIds }, status: "PENDING" },
      });
      const orderById = new Map((orders || []).map((order) => [String(order.id), order]));
      for (const row of rows || []) {
        const order = orderById.get(String(row.customOrderId));
        if (!order) continue;
        if (String(order.creatorId) !== String(row.creatorId)) continue;
        if (order.telegramTaskMessageId == null || Number(order.telegramTaskMessageId) !== Number(row.remoteMessageId) || !order.deliveredAt) continue;
        scanned += 1;
        if (reminderScheduleProjectionConverged(order, workspacePolicy, now)) continue;
        try {
          await reprojectCustomReminderSchedule({ agencyId, orderId: order.id, now, db });
          repaired += 1;
        } catch (error) {
          failures.push({ orderId: String(order.id), code: clean(error?.code, 120) || "CUSTOM_REMINDER_SCHEDULE_REPAIR_FAILED" });
        }
      }
      return false;
    },
  });

  return { scanned, repaired, failed: failures.length, failures };
}

async function repairConfirmedTelegramDeliveryProjections({ agencyId, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const scopedAgencyId = clean(agencyId, 180);
  if (!scopedAgencyId) throw fail("TELEGRAM_DELIVERY_REPAIR_AGENCY_REQUIRED", "agencyId is required for Telegram projection repair");

  // Durable provider receipts are canonical facts. Projection/follow-up creation is server-owned
  // derived work and must converge without requiring the original Desktop to repeat confirm().
  // Discovery is exact: current PENDING threads and CANCELLED follow-up debt are both cursor-drained
  // by telegram-exact-authority-scan-service before any repair limit is considered.
  const [pendingAnchors, cancelledDebt] = await Promise.all([
    findPendingTaskAnchors({ agencyId: scopedAgencyId, db: client }),
    findCancelledTaskFollowupDebt({ agencyId: scopedAgencyId, db: client }),
  ]);

  const candidates = new Map();
  // Any durable projection marker is itself authoritative operational debt. A process may crash
  // after projecting only part of the derived state (for example lastReminderAt) but before the
  // final schedule/follow-up step and marker clear. Always retry marked CONFIRMED receipts first;
  // the semantic scans below exist for older unmarked rows created before this protocol.
  if (client.telegramDeliveryIntent?.findMany) {
    await scanAllById({
      delegate: client.telegramDeliveryIntent,
      where: { agencyId: scopedAgencyId, state: "CONFIRMED", projectionBlockedAt: { not: null } },
      select: { id: true, kind: true },
      pageSize: 250,
      onPage: async (rows) => {
        for (const row of rows || []) {
          candidates.set(String(row.id), { intentId: String(row.id), kind: String(row.kind), reason: "MARKED_PROJECTION_DEBT" });
        }
        return false;
      },
    });
  }
  // The provider TASK receipt remains canonical even if the CustomOrder changes status after
  // confirmation. Projection debt therefore cannot be discovered only from current PENDING rows:
  // a manager may complete a CALL/PHYSICAL order after the receipt commits but before the derived
  // task anchor is projected. Drain every CONFIRMED TASK and compare its exact business target.
  if (client.telegramDeliveryIntent?.findMany && client.customOrder?.findMany) {
    await scanAllById({
      delegate: client.telegramDeliveryIntent,
      where: { agencyId: scopedAgencyId, kind: "TASK", state: "CONFIRMED", remoteMessageId: { not: null } },
      select: { id: true, customOrderId: true, remoteMessageId: true },
      pageSize: 250,
      onPage: async (rows) => {
        const orderIds = Array.from(new Set((rows || []).map((row) => clean(row.customOrderId, 180)).filter(Boolean)));
        if (!orderIds.length) return false;
        const orders = await client.customOrder.findMany({
          where: { agencyId: scopedAgencyId, id: { in: orderIds } },
          select: { id: true, telegramTaskMessageId: true, deliveredAt: true },
        });
        const orderById = new Map((orders || []).map((order) => [String(order.id), order]));
        for (const row of rows || []) {
          const order = orderById.get(String(row.customOrderId));
          if (!order) continue;
          const remoteMessageId = Number(row.remoteMessageId);
          const projectedMessageId = order.telegramTaskMessageId == null ? null : Number(order.telegramTaskMessageId);
          if (projectedMessageId !== remoteMessageId || !order.deliveredAt) {
            candidates.set(String(row.id), { intentId: String(row.id), kind: "TASK", reason: "TASK_PROJECTION_DEBT" });
          }
        }
        return false;
      },
    });
  }
  // REFERENCE receipts are canonical too. Drain all confirmed reference intents by
  // cursor and compare them with the derived CustomOrder scalar-list in bounded pages;
  // never let a fixed first-N sample define whether projection debt exists.
  if (client.telegramDeliveryIntent?.findMany && client.customOrder?.findMany) {
    await scanAllById({
      delegate: client.telegramDeliveryIntent,
      where: { agencyId: scopedAgencyId, kind: "REFERENCE", state: "CONFIRMED", remoteMessageId: { not: null } },
      select: { id: true, customOrderId: true, remoteMessageId: true },
      pageSize: 250,
      onPage: async (rows) => {
        const orderIds = Array.from(new Set((rows || []).map((row) => clean(row.customOrderId, 180)).filter(Boolean)));
        if (!orderIds.length) return false;
        const orders = await client.customOrder.findMany({
          where: { agencyId: scopedAgencyId, id: { in: orderIds } },
          select: { id: true, telegramReferenceMessageIds: true },
        });
        const orderById = new Map((orders || []).map((order) => [String(order.id), order]));
        for (const row of rows || []) {
          const order = orderById.get(String(row.customOrderId));
          if (!order) continue;
          const messageId = Number(row.remoteMessageId);
          const projected = new Set((Array.isArray(order.telegramReferenceMessageIds) ? order.telegramReferenceMessageIds : []).map(Number));
          if (!projected.has(messageId)) candidates.set(String(row.id), { intentId: String(row.id), kind: "REFERENCE", reason: "REFERENCE_PROJECTION_DEBT" });
        }
        return false;
      },
    });
  }
  // Reminder provider effects are canonical too. A Desktop may disappear after the
  // CONFIRMED receipt commits but before lastReminderAt / nextReminderAt projection succeeds.
  // Drain confirmed reminders exactly and repair only rows whose provider effect is newer than
  // the current derived CustomOrder reminder fact. A newer already-projected reminder naturally
  // subsumes older receipts and prevents historical replay from moving the schedule backwards.
  if (client.telegramDeliveryIntent?.findMany && client.customOrder?.findMany) {
    await scanAllById({
      delegate: client.telegramDeliveryIntent,
      where: { agencyId: scopedAgencyId, kind: { in: ["MANUAL_REMINDER", "AUTO_REMINDER"] }, state: "CONFIRMED", remoteMessageId: { not: null } },
      select: { id: true, kind: true, customOrderId: true, remoteSentAt: true, confirmedAt: true },
      pageSize: 250,
      onPage: async (rows) => {
        const orderIds = Array.from(new Set((rows || []).map((row) => clean(row.customOrderId, 180)).filter(Boolean)));
        if (!orderIds.length) return false;
        const orders = await client.customOrder.findMany({
          where: { agencyId: scopedAgencyId, id: { in: orderIds } },
          select: { id: true, lastReminderAt: true },
        });
        const orderById = new Map((orders || []).map((order) => [String(order.id), order]));
        for (const row of rows || []) {
          const order = orderById.get(String(row.customOrderId));
          if (!order) continue;
          const effectAt = row.remoteSentAt ? new Date(row.remoteSentAt) : (row.confirmedAt ? new Date(row.confirmedAt) : null);
          if (!effectAt || !Number.isFinite(effectAt.getTime())) continue;
          const projectedAt = order.lastReminderAt ? new Date(order.lastReminderAt) : null;
          if (projectedAt && Number.isFinite(projectedAt.getTime()) && projectedAt.getTime() >= effectAt.getTime()) continue;
          candidates.set(String(row.id), { intentId: String(row.id), kind: String(row.kind), reason: "REMINDER_PROJECTION_DEBT" });
        }
        return false;
      },
    });
  }
  for (const anchor of pendingAnchors || []) {
    const order = anchor?.order || {};
    const remoteMessageId = Number(anchor?.remoteMessageId);
    const projectedMessageId = order.telegramTaskMessageId == null ? null : Number(order.telegramTaskMessageId);
    // A fully-linked pending thread does not need continuous re-projection. Missing delivery anchor
    // or a conflicting historical projection is debt and must be adjudicated from the receipt.
    if (projectedMessageId === remoteMessageId && order.deliveredAt) continue;
    candidates.set(String(anchor.id), { intentId: String(anchor.id), kind: "TASK", reason: "PENDING_TASK_PROJECTION_DEBT" });
  }
  for (const debt of cancelledDebt || []) {
    if (!debt?.task?.id) continue;
    candidates.set(String(debt.task.id), { intentId: String(debt.task.id), kind: "TASK", reason: "CANCELLED_TASK_FOLLOWUP_DEBT" });
  }

  let repaired = 0;
  let alreadyConverged = 0;
  const failures = [];
  for (const candidate of candidates.values()) {
    const row = await client.telegramDeliveryIntent.findFirst({
      where: { id: candidate.intentId, agencyId: scopedAgencyId, kind: candidate.kind, state: "CONFIRMED" },
    });
    if (!row) { alreadyConverged += 1; continue; }
    try {
      await projectConfirmedIntentObserved({ row, now: row.confirmedAt ? new Date(row.confirmedAt) : now, db: client });
      repaired += 1;
    } catch (error) {
      failures.push({ intentId: candidate.intentId, reason: candidate.reason, code: clean(error?.code, 120) || "TELEGRAM_CONFIRMED_PROJECTION_REPAIR_FAILED" });
    }
  }

  // Schedule is rebuildable derived state, not provider truth. Historical versions could crash
  // after projecting the confirmed TASK/reminder fact but before nextReminderAt. Repair it from
  // the CURRENT order + CURRENT policy instead of replaying an old receipt timestamp and thereby
  // stale-overwriting a later settings change.
  const scheduleRepair = await repairConfirmedTaskReminderScheduleDebt({ agencyId: scopedAgencyId, now, db: client });
  return {
    ok: failures.length === 0 && scheduleRepair.failed === 0,
    scanned: candidates.size, repaired, alreadyConverged, failed: failures.length, failures,
    reminderScheduleScanned: scheduleRepair.scanned,
    reminderScheduleRepaired: scheduleRepair.repaired,
    reminderScheduleFailed: scheduleRepair.failed,
    reminderScheduleFailures: scheduleRepair.failures,
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

async function replaceTelegramReferencePrecommit({ agencyId, member, intentId, clientIntentId, reference, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
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

async function cancelTelegramReferencePrecommit({ agencyId, member, intentId, reason, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
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
        blockedCode: rawReason.startsWith("PRECOMMIT_PROVIDER_UNAVAILABLE:")
          ? rawReason.slice("PRECOMMIT_PROVIDER_UNAVAILABLE:".length) || "PROVIDER_UNAVAILABLE"
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

async function listTelegramReminderPlanningBlockedQueue({ agencyId, member, limit = 50, cursor = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  if (!await canUsePermission({ member, key: "team.analytics.view", db: client })) throw fail("TELEGRAM_REMINDER_BLOCKED_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  const afterId = clean(cursor, 180);
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
  const blocked = [];
  let scanCursor = afterId || null;
  let exhausted = false;

  while (blocked.length < take + 1 && !exhausted) {
    const rows = await client.customOrder.findMany({
      where: {
        agencyId,
        ...scopeWhere(scope),
        status: "PENDING",
        telegramTaskMessageId: { not: null },
        nextReminderAt: { lte: now },
      },
      include: { creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, deletedAt: true, telegramContact: true, telegramAccountId: true } } },
      orderBy: [{ nextReminderAt: "asc" }, { id: "asc" }],
      take: 200,
      ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    for (const order of rows) {
      scanCursor = String(order.id);
      if (await findUnresolvedReminder({ agencyId, orderId: order.id, db: client })) continue;
      const due = nextReminderForOrder(order, workspacePolicy, now, { afterAck: false });
      if (!clean(due?.key, 500) || (due?.at && new Date(due.at).getTime() > now.getTime())) continue;

      let thread = null;
      let blockedCode = null;
      try {
        thread = await loadConfirmedTaskThread({ agencyId, orderId: order.id, db: client });
      } catch (error) {
        const code = String(error?.code || "");
        if (code === "TELEGRAM_DELIVERY_TASK_THREAD_REQUIRED" || code === "TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN") blockedCode = code;
        else throw error;
      }

      let accountId = thread?.accountId ? String(thread.accountId) : null;
      if (!blockedCode && thread) {
        if (!client.agencyTelegramMtprotoAccount?.findFirst) throw fail("TELEGRAM_REMINDER_ACCOUNT_LOOKUP_UNAVAILABLE", "Telegram account lookup is unavailable", 503);
        const account = await client.agencyTelegramMtprotoAccount.findFirst({
          where: { id: String(thread.accountId), agencyId },
          select: { id: true, lifecycleState: true },
        });
        if (!account) blockedCode = "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED";
        else if (String(account.lifecycleState || "ACTIVE") !== "ACTIVE") blockedCode = "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING";
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
    exhausted = rows.length < 200;
  }

  const hasMore = blocked.length > take;
  const visible = blocked.slice(0, take);
  const nextCursor = hasMore && visible.length ? visible[visible.length - 1]._cursor : null;
  return {
    ok: true,
    items: visible.map(({ _cursor, ...row }) => row),
    count: visible.length,
    nextCursor,
    hasMore,
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
      const row = await tx.telegramDeliveryIntent.findFirst({ where: { id, agencyId } });
      if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
      // Historical provider exceptions can outlive the mutable/active Creator row. A broad
      // Customs reviewer may adjudicate that durable agency-owned exception; scoped members
      // still require current creator access and therefore cannot cross their assignment fence.
      const exceptionScope = await allowedCreatorScope({ agencyId, member, db: tx });
      if (!exceptionScope?.broad) await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: tx });
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
      return tx.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    }, { isolationLevel: "Serializable" });
    if (mode === "CONFIRMED") await reconcileInboundAfterConfirmedReceipt({ row: fresh, member, now, db: client });
    return { ok: true, intent: publicIntent(fresh) };
  } catch (error) {
    if (String(error?.code || "") === "P2034") throw fail("TELEGRAM_DELIVERY_RECONCILE_RACE", "Telegram reconciliation changed concurrently; refresh and retry", 409);
    throw error;
  }
}

async function planTaskIntentForCommittedOrder({ agencyId, member, order, now = new Date(), db }) {
  if (!order || String(order.status) !== "PENDING" || !clean(order.creator?.telegramContact, 160)) return null;
  let accountId;
  try { accountId = await resolveAccountForOrder({ agencyId, order, db }); } catch { return null; }
  const payload = taskPayload(order);
  const reserved = await createOrReadIntent({ agencyId, order, accountId: String(accountId), kind: "TASK", identity: "one", payload, now, db });
  if (reserved.created) await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_task_plan", targetType: "TelegramDeliveryIntent", targetId: reserved.row.id, metadata: { orderId: order.id, creatorId: order.creatorId }, db });
  return reserved.row;
}

async function planCancellationIntentForCommittedOrder({ agencyId, member, order, now = new Date(), db }) {
  if (!order || String(order.status) !== "CANCELLED" || order.telegramTaskMessageId == null || order.telegramCancellationWaivedAt) return null;
  const binding = await loadConfirmedTaskThread({ agencyId, orderId: order.id, db });
  const payload = { text: cancellationText(order), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId };
  const reserved = await createOrReadIntent({ agencyId, order, accountId: binding.accountId, kind: "CANCELLATION", identity: "one", payload, now, db });
  if (reserved.created) await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_cancellation_plan", targetType: "TelegramDeliveryIntent", targetId: reserved.row.id, metadata: { orderId: order.id, creatorId: order.creatorId }, db });
  return reserved.row;
}

module.exports = {
  CLAIM_MS,
  DELIVERY_KINDS,
  DELIVERY_STATES,
  publicIntent,
  planTelegramDeliveryIntent,
  planTaskIntentForCommittedOrder,
  planCancellationIntentForCommittedOrder,
  ensureAutomaticReminderIntents,
  listTelegramDeliveryWork,
  claimTelegramDeliveryIntent,
  beginTelegramDeliveryIntent,
  confirmTelegramDeliveryIntent,
  repairConfirmedTelegramDeliveryProjections,
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
