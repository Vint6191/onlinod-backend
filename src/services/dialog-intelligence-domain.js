"use strict";

const crypto = require("node:crypto");

const TERMINAL_PURCHASE_STATUSES = new Set(["REFUNDED", "INVALID"]);

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function integer(value, fallback = 0, min = 0, max = 2_000_000_000) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

function classifyPurchase(input = {}) {
  if (input.refunded === true) return "REFUNDED";
  if (input.invalid === true) return "INVALID";
  if (input.messageResolved !== true) return input.deletedMessage === true ? "DELETED_MESSAGE" : "UNRESOLVED_MESSAGE";
  if (input.mediaResolved !== true) return "UNRESOLVED_MEDIA";
  if (input.hasCreatorMedia !== true && input.hasFanMedia === true) return "EXCLUDED_FAN_MEDIA";
  const priceCents = integer(input.priceCents, 0);
  if (input.isFree === true || priceCents <= 0) return "FREE";
  if (input.isOpened === true) return input.deletedUser === true ? "DELETED_USER" : "SOLD";
  return input.deletedUser === true ? "DELETED_USER" : "NOT_OPENED";
}

function purchaseCountsAsRevenue(purchase) {
  return purchase?.isOpened === true
    && purchase?.isFree !== true
    && integer(purchase?.priceCents, 0) > 0
    && !TERMINAL_PURCHASE_STATUSES.has(String(purchase?.status || ""))
    && String(purchase?.status || "") !== "EXCLUDED_FAN_MEDIA";
}


function allocatePackagePrice(priceCentsValue, media = []) {
  const priceCents = integer(priceCentsValue, 0);
  const rows = Array.isArray(media) ? media : [];
  const creatorIndexes = rows
    .map((item, index) => (item?.isFanMedia === true ? -1 : index))
    .filter((index) => index >= 0);
  if (!creatorIndexes.length) return rows.map(() => 0);
  const base = Math.floor(priceCents / creatorIndexes.length);
  const remainder = priceCents - base * creatorIndexes.length;
  const lastCreatorIndex = creatorIndexes[creatorIndexes.length - 1];
  return rows.map((item, index) => {
    if (item?.isFanMedia === true) return 0;
    return base + (index === lastCreatorIndex ? remainder : 0);
  });
}

function advanceKnownMessageStreak(input = {}) {
  const threshold = integer(input.threshold, 3, 1, 1000);
  let streak = integer(input.startingStreak, 0, 0, threshold);
  for (const observation of Array.isArray(input.observations) ? input.observations : []) {
    if (observation?.known === true && observation?.changed !== true) streak += 1;
    else streak = 0;
  }
  return { streak: Math.min(streak, threshold), threshold, stop: streak >= threshold };
}

function evaluateIncrementalStop(input = {}) {
  const streakResult = advanceKnownMessageStreak(input);
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const watermarkMessageId = clean(input.watermarkMessageId, 240);
  const watermarkAt = dateOrNull(input.watermarkAt);
  let watermarkReached = input.watermarkReached === true;
  let pageOrderStable = input.pageOrderStable !== false;
  let previousAt = dateOrNull(input.previousPageOldestAt);
  let pageOldestAt = previousAt;

  for (const observation of observations) {
    const messageId = clean(observation?.messageId, 240);
    const createdAt = dateOrNull(observation?.createdAtOf);
    if (watermarkMessageId && messageId === watermarkMessageId) watermarkReached = true;
    // A strictly older timestamp proves that a deleted/missing watermark was crossed.
    // Equality is intentionally insufficient because multiple messages may share it.
    if (watermarkAt && createdAt && createdAt.getTime() < watermarkAt.getTime()) watermarkReached = true;
    if (createdAt) {
      if (previousAt && createdAt.getTime() > previousAt.getTime()) pageOrderStable = false;
      previousAt = createdAt;
      pageOldestAt = createdAt;
    }
  }

  const pageNumber = integer(input.pageNumber, 0, 0, 10000);
  const overlapPages = integer(input.overlapPages, 2, 1, 100);
  const overlapSatisfied = pageNumber >= overlapPages;
  const watermarkConfigured = Boolean(watermarkMessageId || watermarkAt);
  const candidate = streakResult.stop === true;
  const stop = candidate
    && watermarkConfigured
    && watermarkReached
    && overlapSatisfied
    && pageOrderStable;

  return {
    ...streakResult,
    candidate,
    stop,
    watermarkReached,
    watermarkConfigured,
    overlapSatisfied,
    pageOrderStable,
    pageOldestAt: pageOldestAt ? pageOldestAt.toISOString() : null,
  };
}

function purchaseIdempotencyKey(signal) {
  const creatorId = clean(signal.creatorId, 160) || "unknown";
  const sourceEventId = clean(signal.sourceEventId, 240);
  if (sourceEventId) return `vault_purchase:${creatorId}:${sourceEventId}`;
  return `vault_purchase:${creatorId}:fp:${sha256([
    clean(signal.buyerId, 160) || "",
    clean(signal.sourceMessageId, 240) || "",
    dateOrNull(signal.occurredAt)?.toISOString() || "",
    integer(signal.amountCents, 0),
  ].join("|"))}`;
}

module.exports = {
  TERMINAL_PURCHASE_STATUSES,
  classifyPurchase,
  purchaseCountsAsRevenue,
  purchaseIdempotencyKey,
  allocatePackagePrice,
  advanceKnownMessageStreak,
  evaluateIncrementalStop,
};
