"use strict";

const FORBIDDEN_KEYS = /(cookie|authorization|token|secret|password|csrf|x-bc|sign|lease|raw|payload|message(text)?|caption|body|mediaurl|urlsignature)/i;
const MAX_DEPTH = 4;
const MAX_ARRAY = 40;
const MAX_OBJECT_KEYS = 80;
const MAX_STRING = 500;

function sanitizeAuditValue(value, depth = 0, key = "") {
  if (FORBIDDEN_KEYS.test(String(key || ""))) return "[redacted]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.slice(0, MAX_STRING);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => sanitizeAuditValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      out[childKey] = sanitizeAuditValue(childValue, depth + 1, childKey);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

function sanitizeAuditMetadata(metadata) {
  const sanitized = sanitizeAuditValue(metadata || {}, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized : {};
}

async function audit({ agencyId, actorUserId = null, action, targetType = null, targetId = null, metadata = null, db = null }) {
  try {
    if (!agencyId || !action) return null;

    const client = db || require("../prisma");
    return await client.auditLog.create({
      data: {
        agencyId,
        actorUserId,
        action: String(action).slice(0, 160),
        targetType: targetType ? String(targetType).slice(0, 120) : null,
        targetId: targetId ? String(targetId).slice(0, 180) : null,
        metadata: sanitizeAuditMetadata(metadata),
      },
    });
  } catch (err) {
    console.warn("[audit] failed:", err?.message || err);
    return null;
  }
}

module.exports = {
  audit,
  sanitizeAuditMetadata,
  sanitizeAuditValue,
  FORBIDDEN_KEYS,
};
