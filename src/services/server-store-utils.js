"use strict";

function cleanString(value, max = 5000) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}

function optionalString(value, max = 5000) {
  const text = cleanString(value, max);
  return text || null;
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function boolValue(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function clampInt(value, fallback = 0, min = 0, max = 2_147_483_647) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function safeDate(value, fallback = null) {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : fallback;
}

const RAW_KEY_RE = /(^|_)(raw|html|payload|headers|cookies|token|authorization|password|secret)($|_)/i;

function pruneRawValue(value, depth = 0) {
  if (depth > 6) return null;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") {
    if (typeof value === "string") return value.length > 2000 ? value.slice(0, 2000) : value;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => pruneRawValue(item, depth + 1)).filter((item) => item !== undefined);
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (RAW_KEY_RE.test(key)) continue;
    const next = pruneRawValue(item, depth + 1);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function compactJson(value, max = 12000) {
  const pruned = pruneRawValue(value || {});
  try {
    const str = JSON.stringify(pruned || {});
    return str.length > max ? {} : (pruned || {});
  } catch (_) {
    return {};
  }
}

function moneyToCents(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n * 100);
}

function centsFromAny(body = {}, centsKey = "priceCents", moneyKey = "price") {
  if (body?.[centsKey] !== undefined) return positiveInt(body[centsKey], 0);
  if (body?.[moneyKey] !== undefined) return moneyToCents(body[moneyKey], 0);
  return 0;
}

function parseLimit(value, fallback = 100, max = 500) {
  return Math.max(1, Math.min(max, positiveInt(value, fallback)));
}

function parseOffset(value) {
  return Math.max(0, positiveInt(value, 0));
}

async function requireCreator(prisma, agencyId, creatorId) {
  const id = cleanString(creatorId, 100);
  if (!id) {
    const err = new Error("creatorId is required");
    err.status = 400;
    err.code = "CREATOR_ID_MISSING";
    throw err;
  }
  const creator = await prisma.creatorAccount.findFirst({ where: { id, agencyId, deletedAt: null } });
  if (!creator) {
    const err = new Error("Creator not found");
    err.status = 404;
    err.code = "CREATOR_NOT_FOUND";
    throw err;
  }
  return creator;
}

function sendError(res, err, fallbackCode = "SERVER_STORE_FAILED") {
  const status = Number(err?.status || 500) || 500;
  return res.status(status).json({
    ok: false,
    code: err?.code || fallbackCode,
    error: String(err?.message || "Failed"),
  });
}

module.exports = {
  cleanString,
  optionalString,
  jsonArray,
  jsonObject,
  positiveInt,
  boolValue,
  clampInt,
  safeDate,
  pruneRawValue,
  compactJson,
  moneyToCents,
  centsFromAny,
  parseLimit,
  parseOffset,
  requireCreator,
  sendError,
};
