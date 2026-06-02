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
  moneyToCents,
  centsFromAny,
  parseLimit,
  parseOffset,
  requireCreator,
  sendError,
};
