"use strict";

const SUPPORTED_RUNTIME_EVENT_TYPES = new Set([
  "presence_online",
  "chat_message_received",
  "subscription_created",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clean(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function idList(value, maxItems = 5_000) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const id = clean(item, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= maxItems) break;
  }
  return result;
}
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}
function subscriptionRelationshipObservation(event) {
  const explicit = object(event.relationship);
  let fanSubscriptionType = clean(explicit.fanSubscriptionType, 100);
  if (!fanSubscriptionType) {
    if (event.isPaidSubscription === true || /paid/i.test(String(event.eventType || ""))) fanSubscriptionType = "paid";
    else if (event.isFreeSubscription === true || /free/i.test(String(event.eventType || ""))) fanSubscriptionType = "free";
  }
  return compact({
    // The event itself proves a current subscription edge. Keep this as typed
    // relationship evidence rather than retaining any raw/private profile snapshot.
    fanSubscribesToCreator: true,
    fanSubscriptionActive: true,
    fanSubscriptionType,
  });
}

/**
 * Return the smallest server-safe event required by Automation.
 *
 * Message text, HTML, media identifiers/URLs, profile snapshots, avatars,
 * headers and raw websocket payloads are intentionally never returned.
 */
function sanitizeAutomationRuntimeEvent(raw) {
  const event = object(raw);
  const type = clean(event.type, 80);
  if (!type || !SUPPORTED_RUNTIME_EVENT_TYPES.has(type)) return null;
  const source = clean(event.source, 80) || "ws";

  if (type === "presence_online") {
    const fanIds = idList(event.fanIds || event.onlineIds);
    if (!fanIds.length) return null;
    return compact({
      type,
      source,
      fanIds,
      createdAt: isoOrNull(event.createdAt || event.ts),
    });
  }

  if (type === "chat_message_received") {
    const fanId = clean(event.fanId || event.dialogId, 160);
    if (!fanId) return null;
    return compact({
      type,
      source,
      fanId,
      messageId: clean(event.messageId, 240),
      createdAt: isoOrNull(event.createdAt || event.changedAt || event.ts),
    });
  }

  const fanId = clean(event.fanId || event.dialogId, 160);
  if (!fanId) return null;
  return compact({
    type,
    source,
    fanId,
    dialogId: clean(event.dialogId, 160) || fanId,
    providerEventId: clean(event.providerEventId || event.notificationId || event.externalEventId || event.eventHash, 240),
    createdAt: isoOrNull(event.createdAt || event.occurredAt || event.ts),
    relationship: subscriptionRelationshipObservation(event),
  });
}

function sanitizeAutomationRuntimeEvents(events, maxItems = 500) {
  const source = Array.isArray(events) ? events : [];
  const result = [];
  for (const raw of source) {
    const event = sanitizeAutomationRuntimeEvent(raw);
    if (!event) continue;
    result.push(event);
    if (result.length >= Math.max(1, Math.trunc(Number(maxItems) || 500))) break;
  }
  return result;
}

module.exports = {
  SUPPORTED_RUNTIME_EVENT_TYPES,
  sanitizeAutomationRuntimeEvent,
  sanitizeAutomationRuntimeEvents,
};
