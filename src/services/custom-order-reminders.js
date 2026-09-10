"use strict";

const crypto = require("node:crypto");
const { activeLifecycleWhere } = require("./telegram-account-reference-authority-service");

const SETTINGS_KEY = "telegramCustomReminders";
const MIN_MINUTES = 1;
const MAX_MINUTES = 525_600; // 1 year; UI presets are shortcuts, arbitrary values remain supported
const MAX_TEXT = 2_000;
const MAX_CALL_OFFSETS = 12;

const DEFAULT_TELEGRAM_CUSTOM_REMINDERS = Object.freeze({
  content: Object.freeze({
    enabled: true,
    firstAfterMinutes: 30,
    repeatEveryMinutes: 60,
    text: "Напоминание: у тебя есть незавершённый кастом «{custom}». Дедлайн: {deadline}.",
  }),
  call: Object.freeze({
    enabled: false,
    offsetsMinutes: Object.freeze([30, 5]),
    text: "Созвон через {minutes} мин. Не пропусти: «{custom}».",
  }),
  physical: Object.freeze({
    enabled: false,
    repeatEveryMinutes: 1440,
    text: "Напоминание по физическому заказу «{custom}»: проверь статус отправки.",
  }),
});

function cleanText(value, fallback, max = MAX_TEXT) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : fallback;
}

function positiveMinutes(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.round(numeric)));
}

function offsets(value, fallback = DEFAULT_TELEGRAM_CUSTOM_REMINDERS.call.offsetsMinutes) {
  const raw = Array.isArray(value) ? value : String(value == null ? "" : value).split(/[\s,;]+/g);
  const normalized = Array.from(new Set(raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => positiveMinutes(item, 1))))
    .sort((a, b) => b - a)
    .slice(0, MAX_CALL_OFFSETS);
  return normalized.length ? normalized : [...fallback];
}

function normalizeTelegramCustomReminders(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const content = input.content && typeof input.content === "object" ? input.content : {};
  const call = input.call && typeof input.call === "object" ? input.call : {};
  const physical = input.physical && typeof input.physical === "object" ? input.physical : {};
  return {
    content: {
      enabled: content.enabled === undefined ? DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.enabled : content.enabled === true,
      firstAfterMinutes: positiveMinutes(content.firstAfterMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.firstAfterMinutes),
      repeatEveryMinutes: positiveMinutes(content.repeatEveryMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.repeatEveryMinutes),
      text: cleanText(content.text, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.text),
    },
    call: {
      enabled: call.enabled === undefined ? DEFAULT_TELEGRAM_CUSTOM_REMINDERS.call.enabled : call.enabled === true,
      offsetsMinutes: offsets(call.offsetsMinutes),
      text: cleanText(call.text, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.call.text),
    },
    physical: {
      enabled: physical.enabled === undefined ? DEFAULT_TELEGRAM_CUSTOM_REMINDERS.physical.enabled : physical.enabled === true,
      repeatEveryMinutes: positiveMinutes(physical.repeatEveryMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.physical.repeatEveryMinutes),
      text: cleanText(physical.text, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.physical.text),
    },
  };
}

function normalizeReminderOverride(type, value) {
  if (value == null) return null;
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalizedType = String(type || "CONTENT").toUpperCase();
  if (normalizedType === "CALL") {
    return {
      // Historical/omitted CALL override state is fail-closed. Automatic CALL reminders
      // become executable only after an explicit ON decision.
      enabled: input.enabled === true,
      offsetsMinutes: offsets(input.offsetsMinutes),
      ...(String(input.text || "").trim() ? { text: cleanText(input.text, "") } : {}),
    };
  }
  if (normalizedType === "PHYSICAL") {
    return {
      enabled: input.enabled === true,
      repeatEveryMinutes: positiveMinutes(input.repeatEveryMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.physical.repeatEveryMinutes),
      ...(String(input.text || "").trim() ? { text: cleanText(input.text, "") } : {}),
    };
  }
  return {
    enabled: input.enabled !== false,
    firstAfterMinutes: positiveMinutes(input.firstAfterMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.firstAfterMinutes),
    repeatEveryMinutes: positiveMinutes(input.repeatEveryMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.repeatEveryMinutes),
    ...(String(input.text || "").trim() ? { text: cleanText(input.text, "") } : {}),
  };
}

function effectivePolicy(order, workspacePolicy) {
  const defaults = normalizeTelegramCustomReminders(workspacePolicy);
  const override = normalizeReminderOverride(order?.type, order?.reminderConfig);
  const type = String(order?.type || "CONTENT").toUpperCase();
  if (type === "CALL") return { ...defaults.call, ...(override || {}) };
  if (type === "PHYSICAL") return { ...defaults.physical, ...(override || {}) };
  return { ...defaults.content, ...(override || {}) };
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function nextReminderForOrder(order, workspacePolicy, now = new Date(), { afterAck = false } = {}) {
  if (!order || String(order.status || "PENDING") !== "PENDING") return { at: null, key: null };
  const policy = effectivePolicy(order, workspacePolicy);
  if (policy.enabled !== true) return { at: null, key: null };
  const type = String(order.type || "CONTENT").toUpperCase();
  const nowMs = now.getTime();

  if (type === "CALL") {
    const scheduledAt = validDate(order.scheduledAt);
    if (!scheduledAt) return { at: null, key: null };
    const offsetsMinutes = offsets(policy.offsetsMinutes);
    const candidates = offsetsMinutes.map((minutes) => ({
      minutes,
      at: new Date(scheduledAt.getTime() - minutes * 60_000),
      key: `CALL:${scheduledAt.toISOString()}:${minutes}`,
    }));
    const ordered = candidates.slice().sort((a, b) => a.at.getTime() - b.at.getTime());
    if (nowMs >= scheduledAt.getTime()) return { at: null, key: null };
    // A concrete due offset has priority over the next future wakeup. Its catch-up window
    // ends at the next offset (or scheduledAt for the final offset), so a missed :30 does
    // not get silently replaced by the future :5 and old offsets do not burst later.
    const due = ordered.filter((candidate, index) => {
      if (candidate.key === order.lastReminderKey || candidate.at.getTime() > nowMs) return false;
      const windowEnd = ordered[index + 1]?.at || scheduledAt;
      return nowMs < windowEnd.getTime();
    }).sort((a, b) => b.at.getTime() - a.at.getTime());
    if (due.length) return { ...due[0], at: new Date(nowMs) };
    const future = ordered.filter((candidate) => candidate.at.getTime() > nowMs && candidate.key !== order.lastReminderKey);
    if (future.length) return future[0];
    return { at: null, key: null };
  }

  if (type === "PHYSICAL") {
    if (String(order.physicalStatus || "WAITING") === "COMPLETED") return { at: null, key: null };
    const repeat = positiveMinutes(policy.repeatEveryMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.physical.repeatEveryMinutes);
    const base = afterAck && order.lastReminderAt ? validDate(order.lastReminderAt) : validDate(order.createdAt);
    if (!base) return { at: new Date(nowMs + repeat * 60_000), key: `PHYSICAL:${nowMs}` };
    const at = new Date(base.getTime() + repeat * 60_000);
    return { at: at.getTime() <= nowMs ? new Date(nowMs) : at, key: `PHYSICAL:${at.toISOString()}` };
  }

  const first = positiveMinutes(policy.firstAfterMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.firstAfterMinutes);
  const repeat = positiveMinutes(policy.repeatEveryMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.repeatEveryMinutes);
  const base = afterAck && order.lastReminderAt ? validDate(order.lastReminderAt) : validDate(order.createdAt);
  const minutes = afterAck && order.lastReminderAt ? repeat : first;
  if (!base) return { at: new Date(nowMs + minutes * 60_000), key: `CONTENT:${nowMs}` };
  const at = new Date(base.getTime() + minutes * 60_000);
  return { at: at.getTime() <= nowMs ? new Date(nowMs) : at, key: `CONTENT:${at.toISOString()}` };
}


function sameInstant(a, b) {
  const aa = validDate(a);
  const bb = validDate(b);
  if (!aa || !bb) return aa === null && bb === null;
  return aa.getTime() === bb.getTime();
}

function contentObligationReminderSchedule(order, workspacePolicy, now, modelObligation) {
  if (!modelObligation?.modelOwesResponse || !modelObligation?.currentInstruction) return { at: null, key: null };
  const instruction = modelObligation.currentInstruction;
  const anchor = validDate(instruction.remoteSentAt);
  if (!anchor) return { at: null, key: null };
  const policy = effectivePolicy(order, workspacePolicy);
  if (policy.enabled !== true) return { at: null, key: null };
  const first = positiveMinutes(policy.firstAfterMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.firstAfterMinutes);
  const repeat = positiveMinutes(policy.repeatEveryMinutes, DEFAULT_TELEGRAM_CUSTOM_REMINDERS.content.repeatEveryMinutes);
  const cyclePrefix = `CONTENT:${String(instruction.kind)}:${String(instruction.intentId)}:`;
  const lastKey = String(order.lastReminderKey || "");
  // Historical pre-cutover CONTENT reminders had no instruction identity. They belong only to
  // the initial TASK cycle; never carry them into a later REVISION_REQUEST cycle.
  const legacyInitialCycle = String(instruction.kind) === "TASK"
    && Boolean(order.lastReminderAt)
    && !lastKey.startsWith("CONTENT:REVISION_REQUEST:")
    && !lastKey.startsWith("CONTENT:TASK:");
  const sameCycle = Boolean(order.lastReminderAt) && (lastKey.startsWith(cyclePrefix) || legacyInitialCycle);
  const base = sameCycle ? validDate(order.lastReminderAt) : anchor;
  const minutes = sameCycle ? repeat : first;
  if (!base) return { at: null, key: null };
  const at = new Date(base.getTime() + minutes * 60_000);
  const due = at.getTime() <= now.getTime() ? new Date(now.getTime()) : at;
  return { at: due, key: `${cyclePrefix}${at.toISOString()}`, cycleId: `${instruction.kind}:${instruction.intentId}` };
}

function desiredReminderSchedule(order, workspacePolicy, now = new Date(), { firstAnchorAt = null, modelObligation = null } = {}) {
  if (!order || String(order.status || "PENDING") !== "PENDING") return { at: null, key: null };
  const type = String(order.type || "CONTENT").toUpperCase();
  if (type === "CONTENT" && modelObligation) {
    return contentObligationReminderSchedule(order, workspacePolicy, now, modelObligation);
  }
  // Non-CONTENT reminder semantics remain tied to the canonical TASK thread. CONTENT callers that
  // have not yet migrated may still use this compatibility projection; authoritative persistence
  // always supplies modelObligation via reprojectCustomReminderSchedule().
  if (order.telegramTaskMessageId == null) return { at: null, key: null };

  if (order.lastReminderAt) return nextReminderForOrder(order, workspacePolicy, now, { afterAck: true });
  if (type === "CALL") return nextReminderForOrder(order, workspacePolicy, now);

  const explicitAnchor = validDate(firstAnchorAt);
  if (explicitAnchor) return nextReminderForOrder({ ...order, createdAt: explicitAnchor }, workspacePolicy, now);

  const taskAnchor = validDate(order.deliveredAt);
  if (taskAnchor) return nextReminderForOrder({ ...order, createdAt: taskAnchor }, workspacePolicy, now);
  return nextReminderForOrder(order, workspacePolicy, now);
}

function reminderWorkObjectId(orderId, reminderKey) {
  const digest = crypto.createHash("sha256").update(String(reminderKey || "")).digest("hex").slice(0, 32);
  return `${String(orderId)}:${digest}`;
}

async function synchronizeReminderDomainWork({ agencyId, order, desired, db, now = new Date() } = {}) {
  if (!order?.id || !db) return { published: false, skipped: true };
  const { WORK_CLASS: PHASE2_WORK_CLASS, publishDomainWork } = require("./domain-work-authority-service");
  const storageAvailable = typeof db.$queryRawUnsafe === "function" || Boolean(db.domainWorkItem?.upsert);
  if (!storageAvailable) return { published: false, skipped: true, reason: "domain_work_storage_unavailable" };

  const parentObjectId = String(order.id);
  const nextKey = String(desired?.key || "").trim();
  const nextAt = validDate(desired?.at);
  const nextObjectId = nextKey ? reminderWorkObjectId(parentObjectId, nextKey) : null;

  // Old precommit reminder obligations are no longer executable once the canonical schedule
  // changes. A CLAIMED old item is fenced out here as well; the Telegram begin guard still
  // revalidates current policy/identity before any physical effect.
  if (typeof db.$queryRawUnsafe === "function") {
    await db.$queryRawUnsafe(
      `UPDATE "DomainWorkItem"
          SET "state"='DONE',"isOutstanding"=FALSE,"completedRevision"=GREATEST("completedRevision","requestedRevision"),
              "ownerToken"=NULL,"leaseUntil"=$1,"nextAttemptAt"=NULL,"errorClass"=NULL,"lastError"=NULL,
              "terminalCause"='REMINDER_SUPERSEDED',"updatedAt"=CURRENT_TIMESTAMP
        WHERE "agencyId"=$2 AND "workClass"='CUSTOM_REMINDER' AND "parentObjectId"=$3
          AND ($4::text IS NULL OR "objectId"<>$4)
          AND "state"<>'DONE'`,
      now, String(agencyId), parentObjectId, nextObjectId,
    );
  } else if (db.domainWorkItem?.updateMany) {
    const where = { agencyId: String(agencyId), workClass: PHASE2_WORK_CLASS.CUSTOM_REMINDER, parentObjectId, state: { not: "DONE" } };
    if (nextObjectId) where.objectId = { not: nextObjectId };
    await db.domainWorkItem.updateMany({ where, data: { state: "DONE", isOutstanding: false, ownerToken: null, leaseUntil: now, nextAttemptAt: null, errorClass: null, lastError: null, terminalCause: "REMINDER_SUPERSEDED" } });
  }

  if (!nextObjectId || !nextAt) return { published: false, cleared: true };
  const row = await publishDomainWork({
    db, agencyId: String(agencyId), workClass: PHASE2_WORK_CLASS.CUSTOM_REMINDER,
    objectType: "CustomReminderObligation", objectId: nextObjectId, parentObjectId,
    partitionKey: String(order.creatorId || agencyId), creatorId: order.creatorId ? String(order.creatorId) : null,
    availableAt: nextAt,
  });
  return { published: true, objectId: nextObjectId, work: row };
}

async function reprojectCustomReminderSchedule({ agencyId, orderId, now = new Date(), firstAnchorAt = null, db, maxAttempts = 5 } = {}) {
  if (!db?.customOrder?.findFirst || !db?.customOrder?.updateMany) {
    const error = new Error("CustomOrder CAS projection storage is required");
    error.code = "CUSTOM_REMINDER_SCHEDULE_STORAGE_REQUIRED";
    error.status = 500;
    throw error;
  }
  const id = String(orderId || "").trim();
  if (!agencyId || !id) {
    const error = new Error("agencyId and orderId are required");
    error.code = "CUSTOM_REMINDER_SCHEDULE_SCOPE_REQUIRED";
    error.status = 400;
    throw error;
  }

  const attempts = Math.max(1, Math.min(20, Math.floor(Number(maxAttempts) || 5)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const execute = async (tx) => {
      const order = await tx.customOrder.findFirst({ where: { id, agencyId } });
      if (!order) return { ok: true, missing: true, changed: false, nextReminderAt: null };
      const revision = validDate(order.updatedAt);
      if (!revision) {
        const error = new Error("CustomOrder.updatedAt revision is required for reminder projection");
        error.code = "CUSTOM_REMINDER_SCHEDULE_REVISION_REQUIRED";
        error.status = 500;
        throw error;
      }

      const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: tx });
      let modelObligation = null;
      if (String(order.type || "CONTENT").toUpperCase() === "CONTENT") {
        const { deriveCustomModelObligation } = require("./custom-model-obligation-authority-service");
        modelObligation = await deriveCustomModelObligation({ agencyId, order, db: tx });
      }
      const desired = desiredReminderSchedule(order, workspacePolicy, now, { firstAnchorAt, modelObligation });
      const desiredAt = desired.at ? new Date(desired.at) : null;
      const scheduleChanged = !sameInstant(order.nextReminderAt, desiredAt);

      // F53-17: even the sameInstant branch must acquire the exact CustomOrder revision
      // before it is allowed to cancel/publish reminder DomainWork. Otherwise a stale
      // R1 scheduler can supersede R2 work after a concurrent policy/obligation change.
      // Touch updatedAt deliberately to make the schedule-revision permit observable.
      const fenceAt = new Date(Math.max(now.getTime(), revision.getTime() + 1));
      const changed = await tx.customOrder.updateMany({
        where: { id, agencyId, updatedAt: revision },
        data: { nextReminderAt: desiredAt, updatedAt: fenceAt },
      });
      if (Number(changed?.count || 0) !== 1) return null;
      const nextOrder = { ...order, nextReminderAt: desiredAt, updatedAt: fenceAt };
      const work = await synchronizeReminderDomainWork({ agencyId, order: nextOrder, desired, db: tx, now });
      return { ok: true, missing: false, changed: scheduleChanged, nextReminderAt: desiredAt, reminderKey: desired.key || null, work, attempts: attempt + 1 };
    };
    const result = typeof db.$transaction === "function" ? await db.$transaction(execute) : await execute(db);
    if (result) return result;
  }

  const error = new Error("Custom reminder schedule changed concurrently too many times; retry from current state");
  error.code = "CUSTOM_REMINDER_SCHEDULE_CONFLICT";
  error.status = 409;
  throw error;
}

function dateLabel(value) {
  const date = validDate(value);
  return date ? date.toISOString().replace("T", " ").replace(/\.000Z$/, " UTC") : "—";
}

function renderTemplate(template, order, creator, now = new Date()) {
  const type = String(order?.type || "CONTENT").toUpperCase();
  let minutes = "";
  if (type === "CALL" && order?.scheduledAt) {
    const scheduled = validDate(order.scheduledAt);
    if (scheduled) minutes = String(Math.max(0, Math.ceil((scheduled.getTime() - now.getTime()) / 60_000)));
  }
  const replacements = {
    "{custom}": String(order?.scenario || "").trim().slice(0, 500),
    "{deadline}": dateLabel(order?.dueAt),
    "{scheduledAt}": dateLabel(order?.scheduledAt),
    "{minutes}": minutes,
    "{model}": String(creator?.displayName || creator?.username || "").trim(),
  };
  let text = String(template || "").trim();
  for (const [token, value] of Object.entries(replacements)) text = text.split(token).join(value);
  return text.slice(0, 4096);
}

function reminderText(order, creator, workspacePolicy, now = new Date()) {
  const policy = effectivePolicy(order, workspacePolicy);
  return renderTemplate(policy.text, order, creator, now);
}

function taskText(order) {
  const type = String(order?.type || "CONTENT").toUpperCase();
  const lines = [];
  if (type === "CALL") {
    lines.push("📞 Новый созвон");
    lines.push(`Время: ${dateLabel(order.scheduledAt)}`);
    if (Number(order.durationMinutes) > 0) lines.push(`Длительность: ${Number(order.durationMinutes)} мин`);
  } else if (type === "PHYSICAL") {
    lines.push("📦 Новый физический заказ");
  } else {
    const kind = String(order?.contentKind || "BOTH").toUpperCase();
    const label = kind === "PHOTO" ? "Фото" : kind === "VIDEO" ? "Видео" : "Фото + видео";
    lines.push("🔥 Новый кастом");
    lines.push(`Формат: ${label}`);
    if (order?.dueAt) lines.push(`Дедлайн: ${dateLabel(order.dueAt)}`);
  }
  lines.push("");
  lines.push(String(order?.scenario || "").trim());
  return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n").slice(0, 4096);
}

async function readWorkspaceReminderPolicy({ agencyId, db }) {
  const row = await db.workspaceSetting.findUnique({ where: { agencyId_key: { agencyId, key: SETTINGS_KEY } } }).catch(() => null);
  return normalizeTelegramCustomReminders(row?.value);
}

async function resolveTelegramAccountId({ agencyId, creator, db }) {
  const assigned = String(creator?.telegramAccountId || "").trim();
  if (assigned) {
    const exists = await db.agencyTelegramMtprotoAccount.findFirst({ where: { id: assigned, agencyId, ...activeLifecycleWhere() }, select: { id: true } });
    // An explicit creator assignment is not Auto. If that exact connection is retiring/missing,
    // fail closed instead of silently rerouting new work through another agency account. Historical
    // Custom threads use their pinned TASK account independently of this current-work resolver.
    return exists ? exists.id : null;
  }
  const rows = await db.agencyTelegramMtprotoAccount.findMany({ where: { agencyId, ...activeLifecycleWhere() }, select: { id: true }, take: 2, orderBy: { id: "asc" } });
  return rows.length === 1 ? rows[0].id : null;
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_TELEGRAM_CUSTOM_REMINDERS,
  normalizeTelegramCustomReminders,
  normalizeReminderOverride,
  effectivePolicy,
  nextReminderForOrder,
  desiredReminderSchedule,
  reminderWorkObjectId,
  synchronizeReminderDomainWork,
  reprojectCustomReminderSchedule,
  reminderText,
  taskText,
  readWorkspaceReminderPolicy,
  resolveTelegramAccountId,
};
