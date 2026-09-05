"use strict";

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
    enabled: true,
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
      enabled: input.enabled !== false,
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
    const future = candidates.filter((candidate) => candidate.at.getTime() > nowMs && candidate.key !== order.lastReminderKey)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    if (future.length) return future[0];
    if (!afterAck) {
      const due = candidates.filter((candidate) => candidate.at.getTime() <= nowMs && candidate.key !== order.lastReminderKey)
        .sort((a, b) => b.at.getTime() - a.at.getTime());
      if (due.length && nowMs < scheduledAt.getTime()) return { ...due[0], at: new Date(nowMs) };
    }
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

function desiredReminderSchedule(order, workspacePolicy, now = new Date(), { firstAnchorAt = null } = {}) {
  if (!order || String(order.status || "PENDING") !== "PENDING") return { at: null, key: null };
  // Automatic reminders are follow-ups to the canonical Telegram TASK thread. Until that provider
  // effect is confirmed there is no executable reminder schedule, regardless of Custom type.
  if (order.telegramTaskMessageId == null) return { at: null, key: null };
  const type = String(order.type || "CONTENT").toUpperCase();

  // Once a reminder effect exists, every schedule projection is derived from that latest provider
  // fact plus the CURRENT policy. Before the first reminder, CONTENT/PHYSICAL start from the
  // confirmed TASK effect when available; CALL remains anchored to scheduledAt.
  if (order.lastReminderAt) return nextReminderForOrder(order, workspacePolicy, now, { afterAck: true });
  if (type === "CALL") return nextReminderForOrder(order, workspacePolicy, now);

  const explicitAnchor = validDate(firstAnchorAt);
  if (explicitAnchor) {
    if (order.telegramTaskMessageId == null) return { at: null, key: null };
    return nextReminderForOrder({ ...order, createdAt: explicitAnchor }, workspacePolicy, now);
  }

  const taskAnchor = validDate(order.deliveredAt);
  if (order.telegramTaskMessageId != null && taskAnchor) {
    return nextReminderForOrder({ ...order, createdAt: taskAnchor }, workspacePolicy, now);
  }
  return nextReminderForOrder(order, workspacePolicy, now);
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
    const order = await db.customOrder.findFirst({ where: { id, agencyId } });
    if (!order) return { ok: true, missing: true, changed: false, nextReminderAt: null };
    const revision = validDate(order.updatedAt);
    if (!revision) {
      const error = new Error("CustomOrder.updatedAt revision is required for reminder projection");
      error.code = "CUSTOM_REMINDER_SCHEDULE_REVISION_REQUIRED";
      error.status = 500;
      throw error;
    }

    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db });
    const desired = desiredReminderSchedule(order, workspacePolicy, now, { firstAnchorAt });
    const desiredAt = desired.at ? new Date(desired.at) : null;
    if (sameInstant(order.nextReminderAt, desiredAt)) {
      return { ok: true, missing: false, changed: false, nextReminderAt: desiredAt, attempts: attempt + 1 };
    }

    // updatedAt is the cross-service revision fence. Write it explicitly: correctness must not
    // depend on whether a particular Prisma Client version advances @updatedAt for updateMany().
    const fenceAt = new Date(Math.max(now.getTime(), revision.getTime() + 1));
    const changed = await db.customOrder.updateMany({
      where: { id, agencyId, updatedAt: revision },
      data: { nextReminderAt: desiredAt, updatedAt: fenceAt },
    });
    if (Number(changed?.count || 0) === 1) {
      return { ok: true, missing: false, changed: true, nextReminderAt: desiredAt, attempts: attempt + 1 };
    }
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
    const exists = await db.agencyTelegramMtprotoAccount.findFirst({ where: { id: assigned, agencyId }, select: { id: true } });
    if (exists) return exists.id;
  }
  const rows = await db.agencyTelegramMtprotoAccount.findMany({ where: { agencyId }, select: { id: true }, take: 2, orderBy: { id: "asc" } });
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
  reprojectCustomReminderSchedule,
  reminderText,
  taskText,
  readWorkspaceReminderPolicy,
  resolveTelegramAccountId,
};
