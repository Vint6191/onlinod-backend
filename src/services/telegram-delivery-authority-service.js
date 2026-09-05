"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { assertExecutionAccessFence } = require("./execution-access-fence-service");
const { assertTelegramRuntimeLease } = require("./telegram-execution-runtime");
const { reconcilePendingInboundForConfirmedDelivery } = require("./telegram-inbound-authority-service");
const {
  nextReminderForOrder,
  readWorkspaceReminderPolicy,
  reminderText,
  resolveTelegramAccountId,
  taskText,
} = require("./custom-order-reminders");

const DELIVERY_KINDS = Object.freeze(["TASK", "REFERENCE", "MANUAL_REMINDER", "AUTO_REMINDER", "CANCELLATION"]);
const DELIVERY_STATES = Object.freeze(["PLANNED", "CLAIMED", "COMMITTING", "CONFIRMED", "RECONCILE_REQUIRED", "CANCELLED", "FAILED_PRECOMMIT"]);
const KIND_SET = new Set(DELIVERY_KINDS);
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
    outcomeReason: row.outcomeReason || null, confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
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

async function createOrReadIntent({ agencyId, order, accountId, kind, identity, clientIntentId = null, referenceOrdinal = null, payload, now, db }) {
  const key = logicalKey({ agencyId, orderId: order.id, kind, identity });
  const fingerprint = payloadFingerprint(payload);
  const existing = await db.telegramDeliveryIntent.findUnique({ where: { logicalKey: key } });
  if (existing) {
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
        const fresh = await db.telegramDeliveryIntent.findUnique({ where: { logicalKey: key } });
        return { row: fresh, created: false, refreshed: true };
      }
      const raced = await db.telegramDeliveryIntent.findUnique({ where: { logicalKey: key } });
      if (raced && String(raced.payloadFingerprint) === fingerprint && String(raced.accountId) === String(accountId)) return { row: raced, created: false, refreshed: false };
      throw fail("TELEGRAM_DELIVERY_INTENT_CONFLICT", "Telegram delivery crossed the commit boundary while its precommit provider binding was being refreshed", 409);
    }
    throw fail("TELEGRAM_DELIVERY_INTENT_CONFLICT", "Logical Telegram delivery intent already exists with different immutable payload", 409);
  }
  try {
    const row = await db.telegramDeliveryIntent.create({ data: {
      agencyId, creatorId: order.creatorId, customOrderId: order.id, accountId, kind, logicalKey: key,
      clientIntentId, referenceOrdinal, payloadFingerprint: fingerprint, payload, state: "PLANNED", createdAt: now,
    } });
    return { row, created: true, refreshed: false };
  } catch (error) {
    if (String(error?.code || "") !== "P2002") throw error;
    // Concurrent retries may have computed a newer provider/context-derived payload for the same
    // logical intent. Re-enter the existing-row path so precommit refresh semantics, not a second
    // identity or a false conflict, decide the winner.
    return createOrReadIntent({ agencyId, order, accountId, kind, identity, clientIntentId, referenceOrdinal, payload, now, db });
  }
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
    identity = normalizedClientIntentId;
    const ref = reference && typeof reference === "object" ? reference : {};
    referenceOrdinal = Math.max(0, Math.floor(Number(ref.ordinal) || 0));
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
  const rows = await db.customOrder.findMany({
    where: { agencyId, ...scopeWhere(scope), status: "PENDING", telegramTaskMessageId: { not: null }, nextReminderAt: { lte: now } },
    include: { creator: { select: { id: true, displayName: true, username: true, telegramContact: true, telegramUserId: true, telegramAccountId: true } } },
    orderBy: [{ nextReminderAt: "asc" }, { id: "asc" }], take: take * 2,
  });
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
  for (const order of rows) {
    let binding;
    try { binding = await loadConfirmedTaskThread({ agencyId, orderId: order.id, db }); } catch { continue; }
    const accountId = String(binding.accountId);
    const due = nextReminderForOrder(order, workspacePolicy, now, { afterAck: false });
    const reminderKey = clean(due.key || order.lastReminderKey || (order.nextReminderAt ? `AT:${new Date(order.nextReminderAt).toISOString()}` : ""), 500);
    if (!reminderKey || (due.at && due.at.getTime() > now.getTime())) continue;
    const payload = { text: reminderText(order, order.creator, workspacePolicy, now), replyToDeliveryId: null, replyToMessageId: binding.replyToMessageId, recipientTelegramUserId: binding.recipientTelegramUserId, reminderKey };
    await createOrReadIntent({ agencyId, order, accountId: String(accountId), kind: "AUTO_REMINDER", identity: sha256(reminderKey).slice(0, 32), payload, now, db });
  }
}

async function refreshPrecommitIntentFromCurrentState({ row, agencyId, now = new Date(), db }) {
  if (!row || !["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(row.state)) || row.commitStartedAt != null) return row;
  const order = await loadOrder({ agencyId, orderId: row.customOrderId, db });
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
    if (!clientIntentId || order.telegramTaskMessageId == null || !row.payload?.reference) return null;
    identity = String(clientIntentId);
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
  // A process can die after the commit permit but before it durably reports an outcome.
  // That row must become visible as unresolved, never silently become retryable.
  const staleCommitBefore = new Date(now.getTime() - CLAIM_MS);
  await client.telegramDeliveryIntent.updateMany({
    where: { agencyId, ...scopeWhere(scope), state: "COMMITTING", commitStartedAt: { lte: staleCommitBefore } },
    data: { state: "RECONCILE_REQUIRED", outcomeReason: "COMMIT_PROCESS_LOST" },
  });
  const rows = await client.telegramDeliveryIntent.findMany({
    where: { agencyId, ...scopeWhere(scope), state: { in: ["PLANNED", "CLAIMED", "RECONCILE_REQUIRED"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: Math.min(500, take * 2),
  });
  const items = [];
  for (const snapshot of rows) {
    let current = snapshot;
    if (["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"].includes(String(snapshot.state)) && snapshot.commitStartedAt == null) {
      current = await refreshPrecommitIntentFromCurrentState({ row: snapshot, agencyId, now, db: client });
    }
    if (!current || String(current.state) === "CANCELLED") continue;
    items.push(publicIntent(current));
    if (items.length >= take) break;
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
      where: { agencyId, customOrderId: row.customOrderId, kind: "REFERENCE", referenceOrdinal: { lt: Number(row.referenceOrdinal) }, state: { not: "CONFIRMED" } },
      orderBy: [{ referenceOrdinal: "asc" }, { createdAt: "asc" }],
    });
    if (predecessor) return { ok: true, claimed: false, busy: true, blockedByIntentId: String(predecessor.id), intent: publicIntent(row), claimToken: null };
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
  const client = db || require("../prisma"); const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  if (row.state === "CONFIRMED" || row.state === "RECONCILE_REQUIRED" || row.state === "COMMITTING") return { ok: true, begun: false, intent: publicIntent(row) };
  verifyStoredClaim(row, { deviceId, claimToken });
  try { await currentBeginGuard({ row, member, agencyId, runtimeClaimToken, deviceId, now, db: client }); }
  catch (error) {
    const reason = clean(error?.code || error?.message, 500) || "PRECOMMIT_GUARD_FAILED";
    const domainCancelled = String(error?.code || "") === "TELEGRAM_DELIVERY_CONTROL_CHANGED";
    await client.telegramDeliveryIntent.updateMany({
      where: { id: row.id, agencyId, state: "CLAIMED", claimRevision: row.claimRevision },
      data: domainCancelled
        ? { state: "CANCELLED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: reason }
        : { state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: `FAILED_PRECOMMIT:${reason}` },
    }).catch(() => undefined);
    if (!domainCancelled && String(error?.code || "") === "TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED") {
      const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } }).catch(() => null);
      if (fresh) await refreshPrecommitIntentFromCurrentState({ row: fresh, agencyId, now, db: client }).catch(() => undefined);
    }
    throw error;
  }
  const changed = await client.telegramDeliveryIntent.updateMany({ where: { id: row.id, agencyId, state: "CLAIMED", claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash }, data: { state: "COMMITTING", commitStartedAt: now, claimUntil: null } });
  if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_BEGIN_RACE", "Telegram delivery changed before commit permit", 409);
  const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  return { ok: true, begun: true, intent: publicIntent(fresh) };
}

async function projectConfirmedIntent({ row, now, db }) {
  const kind = String(row.kind); const remoteMessageId = Number(row.remoteMessageId);
  const effectAtCandidate = row.remoteSentAt ? new Date(row.remoteSentAt) : (row.confirmedAt ? new Date(row.confirmedAt) : now);
  const effectAt = Number.isFinite(effectAtCandidate.getTime()) ? effectAtCandidate : now;
  const order = await db.customOrder.findFirst({ where: { id: row.customOrderId, agencyId: row.agencyId } });
  if (!order) return;
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

    // Reminder scheduling is a derived projection, not part of the provider receipt. Only a
    // freshly-read still-PENDING order may receive it. updatedAt + status form the freshness
    // CAS: if cancellation/settings changes race this statement, it loses and we re-read.
    if (Number(linked?.count || 0) === 1 && String(settledOrder.status) === "PENDING") {
      const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId: row.agencyId, db });
      const seed = String(settledOrder.type || "CONTENT").toUpperCase() === "CALL" ? settledOrder : { ...settledOrder, createdAt: effectAt };
      const nextReminderAt = nextReminderForOrder(seed, workspacePolicy, effectAt).at;
      await db.customOrder.updateMany({
        where: { id: settledOrder.id, agencyId: row.agencyId, status: "PENDING", telegramTaskMessageId: remoteMessageId, updatedAt: settledOrder.updatedAt },
        data: { nextReminderAt },
      });
      settledOrder = await db.customOrder.findFirst({ where: { id: order.id, agencyId: row.agencyId } }) || settledOrder;
    }

    // A task may settle after cancellation won the concurrent business-state race. The cancel
    // path could have observed telegramTaskMessageId=null and therefore planned nothing. Always
    // decide cancellation from the fresh post-receipt order, never from the stale pre-write row.
    if (String(settledOrder.status) === "CANCELLED") {
      const recipientTelegramUserId = clean(row.remoteRecipientTelegramUserId, 40);
      if (!/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN", "Confirmed Telegram TASK is missing its provider recipient identity", 409);
      const payload = { text: cancellationText(settledOrder), replyToDeliveryId: null, replyToMessageId: String(remoteMessageId), recipientTelegramUserId };
      const reserved = await createOrReadIntent({ agencyId: row.agencyId, order: settledOrder, accountId: String(row.accountId), kind: "CANCELLATION", identity: "one", payload, now: effectAt, db });
      if (reserved.created) await audit({ agencyId: row.agencyId, actorUserId: row.userId || null, action: "custom_order.telegram_cancellation_plan", targetType: "TelegramDeliveryIntent", targetId: reserved.row.id, metadata: { orderId: settledOrder.id, creatorId: settledOrder.creatorId, reason: "TASK_SETTLED_AFTER_CANCELLATION" }, db });
    }
  } else if (kind === "REFERENCE") {
    const refs = Array.from(new Set([...(Array.isArray(order.telegramReferenceMessageIds) ? order.telegramReferenceMessageIds.map(Number) : []), remoteMessageId]));
    await db.customOrder.update({ where: { id: order.id }, data: { telegramReferenceMessageIds: refs } });
  } else if (kind === "MANUAL_REMINDER" || kind === "AUTO_REMINDER") {
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId: row.agencyId, db });
    const reminderKey = clean(row.payload?.reminderKey, 500) || null;
    const synthetic = { ...order, lastReminderAt: effectAt, lastReminderKey: reminderKey };
    const next = nextReminderForOrder(synthetic, workspacePolicy, effectAt, { afterAck: true });
    // Provider effect time, not backend arrival order, owns the current reminder projection.
    // Two distinct reminder intents may both be legitimate and settle out of order; an older
    // receipt must never move lastReminderAt/nextReminderAt backwards and cause an early resend.
    await db.customOrder.updateMany({
      where: {
        id: order.id,
        agencyId: row.agencyId,
        OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: effectAt } }],
      },
      data: { lastReminderAt: effectAt, lastReminderKey: reminderKey, nextReminderAt: next.at },
    });
  }
}

async function reconcileInboundAfterConfirmedReceipt({ row, member, now, db }) {
  if (!row?.remoteRecipientTelegramUserId && !row?.remoteMessageId) return { ok: true, skipped: true };
  try {
    return await reconcilePendingInboundForConfirmedDelivery({
      agencyId: row.agencyId,
      accountId: row.accountId,
      senderTelegramUserId: row.remoteRecipientTelegramUserId || null,
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
    // Repair-safe idempotency: historical/partially-settled rows are projected from the same canonical receipt.
    await projectConfirmedIntent({ row, now: row.confirmedAt ? new Date(row.confirmedAt) : now, db: client });
    await reconcileInboundAfterConfirmedReceipt({ row, member, now, db: client });
    return { ok: true, idempotent: true, intent: publicIntent(row) };
  }
  verifyCommitClaim(row, { deviceId, claimToken });
  const settle = async (tx) => {
    // A durable provider receipt captured by the committing Desktop is affirmative proof and may
    // settle a row that became RECONCILE_REQUIRED only because the backend acknowledgement was lost.
    const changed = await tx.telegramDeliveryIntent.updateMany({ where: { id: row.id, agencyId, state: { in: ["COMMITTING", "RECONCILE_REQUIRED"] }, claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash }, data: { state: "CONFIRMED", remoteMessageId: messageId, ...(recipientTelegramUserId ? { remoteRecipientTelegramUserId: recipientTelegramUserId } : {}), remoteSentAt: sentAt, confirmedAt: now, outcomeReason: null } });
    if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_CONFIRM_RACE", "Telegram delivery changed before confirmation", 409);
    const confirmed = await tx.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
    await projectConfirmedIntent({ row: confirmed, now, db: tx });
    return confirmed;
  };
  const confirmed = typeof client.$transaction === "function" ? await client.$transaction(settle) : await settle(client);
  await reconcileInboundAfterConfirmedReceipt({ row: confirmed, member, now, db: client });
  await audit({ agencyId, actorUserId: member?.userId || row.userId || null, action: "custom_order.telegram_delivery_confirm", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind, remoteMessageId: messageId }, db: client });
  return { ok: true, idempotent: false, intent: publicIntent(confirmed) };
}

async function markTelegramDeliveryProvenNotSent({ agencyId, member, intentId, deviceId, claimToken, reason, db = null } = {}) {
  const client = db || require("../prisma"); const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  if (row.state === "PLANNED" || row.state === "FAILED_PRECOMMIT" || row.state === "CANCELLED") return { ok: true, idempotent: true, intent: publicIntent(row) };
  if (row.state === "CONFIRMED") throw fail("TELEGRAM_DELIVERY_PROVEN_NOT_SENT_CONFLICT", "A confirmed Telegram outcome cannot be downgraded to not-sent", 409);
  verifyCommitClaim(row, { deviceId, claimToken });
  const justification = clean(reason, 500);
  if (!justification) throw fail("TELEGRAM_DELIVERY_PROVEN_NOT_SENT_REASON_REQUIRED", "A transport proof reason is required");
  const changed = await client.telegramDeliveryIntent.updateMany({
    where: { id: row.id, agencyId, state: { in: ["COMMITTING", "RECONCILE_REQUIRED"] }, claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash },
    data: { state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, commitStartedAt: null, outcomeReason: `PROVEN_NOT_SENT:${justification}` },
  });
  if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_PROVEN_NOT_SENT_RACE", "Telegram delivery changed while recording proven no-effect", 409);
  const fresh = await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
  await audit({ agencyId, actorUserId: member?.userId || row.userId || null, action: "custom_order.telegram_delivery_proven_not_sent", targetType: "TelegramDeliveryIntent", targetId: row.id, metadata: { orderId: row.customOrderId, creatorId: row.creatorId, kind: row.kind, reason: justification }, db: client });
  return { ok: true, idempotent: false, intent: publicIntent(fresh) };
}

async function getTelegramOrderContext({ agencyId, member, orderId, db = null } = {}) {
  const client = db || require("../prisma");
  const order = await loadOrder({ agencyId, orderId, db: client });
  await requireCreatorAccess({ agencyId, member, creatorId: order.creatorId, db: client });
  const thread = await loadConfirmedTaskThread({ agencyId, orderId: order.id, db: client });
  const references = await client.telegramDeliveryIntent.findMany({
    where: { agencyId, customOrderId: order.id, kind: "REFERENCE", state: "CONFIRMED", accountId: thread.accountId, remoteRecipientTelegramUserId: thread.recipientTelegramUserId },
    orderBy: [{ referenceOrdinal: "asc" }, { createdAt: "asc" }],
    take: 200,
  });
  return {
    ok: true, orderId: String(order.id), creatorId: String(order.creatorId), accountId: thread.accountId, telegramUserId: thread.recipientTelegramUserId,
    telegramTaskMessageId: thread.replyToMessageId,
    telegramReferenceMessageIds: references.filter((row) => row.remoteMessageId != null).map((row) => String(row.remoteMessageId)),
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

async function failTelegramDeliveryPrecommit({ agencyId, member, intentId, deviceId, claimToken, reason, db = null } = {}) {
  const client = db || require("../prisma"); const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  if (row.state !== "CLAIMED") return { ok: true, ignored: true, intent: publicIntent(row) };
  verifyStoredClaim(row, { deviceId, claimToken });
  const changed = await client.telegramDeliveryIntent.updateMany({ where: { id: row.id, agencyId, state: "CLAIMED", claimRevision: row.claimRevision, claimTokenHash: row.claimTokenHash }, data: { state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, outcomeReason: clean(reason, 500) || "PRECOMMIT_FAILURE" } });
  if (Number(changed?.count || 0) !== 1) return { ok: true, ignored: true, intent: publicIntent(await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } })) };
  return { ok: true, ignored: false, intent: publicIntent(await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } })) };
}

async function reconcileTelegramDeliveryIntent({ agencyId, member, intentId, resolution, remoteMessageId = null, remoteRecipientTelegramUserId = null, remoteSentAt = null, reason = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const row = await client.telegramDeliveryIntent.findFirst({ where: { id: clean(intentId, 180), agencyId } });
  if (!row) throw fail("TELEGRAM_DELIVERY_INTENT_NOT_FOUND", "Telegram delivery intent not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  if (row.state !== "RECONCILE_REQUIRED") throw fail("TELEGRAM_DELIVERY_NOT_RECONCILABLE", "Telegram delivery is not awaiting reconciliation", 409);
  const mode = clean(resolution, 40).toUpperCase();
  if (mode === "CONFIRMED") {
    const messageId = positiveInt(remoteMessageId, "remoteMessageId");
    const recipientTelegramUserId = clean(remoteRecipientTelegramUserId, 40);
    if (recipientTelegramUserId && !/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_RECIPIENT_ID_INVALID", "remoteRecipientTelegramUserId must be a numeric Telegram user id");
    if (String(row.kind) === "TASK" && !/^\d{1,20}$/.test(recipientTelegramUserId)) throw fail("TELEGRAM_DELIVERY_TASK_RECIPIENT_REQUIRED", "TASK reconciliation requires the proven Telegram recipient user id", 409);
    const sentAt = iso(remoteSentAt, "remoteSentAt", now) || now;
    const settle = async (tx) => {
      const changed = await tx.telegramDeliveryIntent.updateMany({ where: { id: row.id, agencyId, state: "RECONCILE_REQUIRED", claimRevision: row.claimRevision }, data: { state: "CONFIRMED", remoteMessageId: messageId, ...(recipientTelegramUserId ? { remoteRecipientTelegramUserId: recipientTelegramUserId } : {}), remoteSentAt: sentAt, confirmedAt: now, outcomeReason: `MANUAL_CONFIRMED:${clean(reason, 300) || "operator"}` } });
      if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_RECONCILE_RACE", "Telegram delivery changed during reconciliation", 409);
      const fresh = await tx.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } });
      await projectConfirmedIntent({ row: fresh, now, db: tx });
      return fresh;
    };
    const fresh = typeof client.$transaction === "function" ? await client.$transaction(settle) : await settle(client);
    await reconcileInboundAfterConfirmedReceipt({ row: fresh, member, now, db: client });
    return { ok: true, intent: publicIntent(fresh) };
  }
  if (mode === "PROVEN_NOT_SENT") {
    const justification = clean(reason, 500); if (!justification) throw fail("TELEGRAM_DELIVERY_RECONCILE_REASON_REQUIRED", "A reconciliation reason is required");
    const changed = await client.telegramDeliveryIntent.updateMany({ where: { id: row.id, agencyId, state: "RECONCILE_REQUIRED", claimRevision: row.claimRevision }, data: { state: "PLANNED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimUntil: null, commitStartedAt: null, outcomeReason: `PROVEN_NOT_SENT:${justification}` } });
    if (Number(changed?.count || 0) !== 1) throw fail("TELEGRAM_DELIVERY_RECONCILE_RACE", "Telegram delivery changed during reconciliation", 409);
    return { ok: true, intent: publicIntent(await client.telegramDeliveryIntent.findFirst({ where: { id: row.id, agencyId } })) };
  }
  throw fail("TELEGRAM_DELIVERY_RECONCILE_RESOLUTION_INVALID", "resolution must be CONFIRMED or PROVEN_NOT_SENT");
}

async function planTaskIntentForCommittedOrder({ agencyId, member, order, now = new Date(), db }) {
  if (!order || String(order.status) !== "PENDING" || !clean(order.creator?.telegramContact, 160)) return null;
  const accountId = await resolveTelegramAccountId({ agencyId, creator: order.creator, db });
  if (!accountId) return null;
  const payload = taskPayload(order);
  const reserved = await createOrReadIntent({ agencyId, order, accountId: String(accountId), kind: "TASK", identity: "one", payload, now, db });
  if (reserved.created) await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_task_plan", targetType: "TelegramDeliveryIntent", targetId: reserved.row.id, metadata: { orderId: order.id, creatorId: order.creatorId }, db });
  return reserved.row;
}

async function planCancellationIntentForCommittedOrder({ agencyId, member, order, now = new Date(), db }) {
  if (!order || String(order.status) !== "CANCELLED" || order.telegramTaskMessageId == null) return null;
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
  markTelegramDeliveryUnknown,
  markTelegramDeliveryProvenNotSent,
  failTelegramDeliveryPrecommit,
  getTelegramOrderContext,
  assertTelegramDeliveryMaterialAccess,
  reconcileTelegramDeliveryIntent,
};
