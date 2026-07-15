"use strict";

const crypto = require("node:crypto");

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function int(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
function date(value) { const d = value instanceof Date ? value : new Date(value || 0); return Number.isFinite(d.getTime()) ? d : null; }

function htmlText(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\s*<\w+/i.test(raw)) return raw;
  return `<p>${raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r?\n/g, "</p><p>")}</p>`;
}

function mediaIds(value) {
  const rows = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of rows) {
    const raw = typeof item === "object" && item ? (item.id ?? item.mediaId ?? item.fileId) : item;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    const id = Math.floor(n);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function stableFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function taskToTemplate(task) {
  const config = object(task.config);
  const triggers = object(task.triggers);
  const rules = object(task.rules);
  const mediaFiles = mediaIds(config.media || config.mediaFiles);
  const text = htmlText(config.messageText || config.text || "");
  const price = Number(config.price ?? (Number(config.priceCents || 0) / 100)) || 0;
  const snapshot = {
    id: task.clientId || task.id,
    serverTaskId: task.id,
    title: task.title || "Bump",
    text,
    price,
    lockedText: config.lockedText === true || config.paidMode === "paid_text",
    mediaFiles,
    previews: Array.isArray(config.previews) ? config.previews : [],
    rfGuest: Array.isArray(config.rfGuest) ? config.rfGuest : [],
    rfPartner: Array.isArray(config.rfPartner) ? config.rfPartner : [],
    rfTag: Array.isArray(config.rfTag) ? config.rfTag : [],
    triggers,
    rules,
  };
  return { ...snapshot, fingerprint: stableFingerprint(snapshot) };
}

function triggerEnabled(template, source) {
  const triggers = object(template.triggers);
  if (source === "online") return triggers.fanOnline === true;
  if (source === "hidden_online") return triggers.hiddenOnlineSignal === true;
  if (source === "subscription_event") return triggers.fanSubscribed === true;
  if (source === "paid_subscriber" || source === "free_subscriber") return triggers.fanSubscribed === true || triggers.subscriber === true;
  return true;
}

function templateTiming(template, settings, source) {
  const rules = object(template.rules);
  const hidden = source === "hidden_online";
  const deleteAfterNoReplyMs = hidden
    ? int(rules.hiddenDeleteAfterNoReplyHours, settings.deleteAfterNoReplyMs / 3_600_000, 1, 720) * 3_600_000
    : int(rules.deleteAfterNoReplyHours ?? rules.replyTimeoutHours, settings.deleteAfterNoReplyMs / 3_600_000, 1, 720) * 3_600_000;
  return {
    deleteAfterNoReplyMs,
    afterReplyCooldownMs: int(rules.replyCooldownHours, settings.afterReplyCooldownMs / 3_600_000, 0, 2160) * 3_600_000,
    afterSendCooldownMs: hidden
      ? int(
          rules.hiddenRetryAfterNoReplyHours ?? rules.hiddenCadenceHours,
          settings.hiddenRetryIntervalMs / 3_600_000,
          1,
          720,
        ) * 3_600_000
      : int(rules.sentCooldownHours, settings.afterSendCooldownMs / 3_600_000, 0, 2160) * 3_600_000,
    sameTemplateCooldownMs: int(rules.cooldownHours ?? rules.sameTemplateCooldownHours, settings.sameTemplateCooldownMs / 3_600_000, 0, 2160) * 3_600_000,
  };
}

function eligibility({ candidate, fanState, settings, source, now }) {
  if (!candidate?.fanId) return "invalid_target";
  if (!candidate.dialogId) return "missing_dialog";
  if (candidate.canReceiveChatMessage === false) return "cannot_message";
  if (fanState?.blocked) return "blocked";
  if (fanState?.ignored) return "ignored";
  if (fanState?.pendingMessageId) return "pending_reply";
  if (fanState?.cooldownUntil && fanState.cooldownUntil > now) return "fan_cooldown";
  if (source === "online") {
    const observed = date(candidate.observedAt || fanState?.lastOnlineAt);
    if (!observed || observed.getTime() < now.getTime() - settings.onlineObservationTtlMs) return "stale_candidate";
  }
  if (source === "hidden_online" && candidate.metadata?.lastSeenIsNull !== true) return "stale_candidate";
  return null;
}

module.exports = {
  stableFingerprint,
  taskToTemplate,
  triggerEnabled,
  templateTiming,
  eligibility,
};
