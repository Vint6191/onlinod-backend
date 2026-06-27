"use strict";

const prisma = require("../prisma");

const BODY_KEYS_ALLOWLIST = new Set(["name", "role", "status", "plan", "tier", "tierMode", "billingExcluded", "permissions", "disabled", "enabled", "hard", "reason"]);
const SECRET_KEY_RE = /(password|token|secret|authorization|cookie|session|hash|key)/i;

function safeSmallObject(input, maxKeys = 30) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= maxKeys) break;
    if (SECRET_KEY_RE.test(key)) continue;
    if (value === undefined) continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[key] = typeof value === "string" ? value.slice(0, 300) : value;
      count += 1;
      continue;
    }
    if (BODY_KEYS_ALLOWLIST.has(key)) {
      try {
        const json = JSON.parse(JSON.stringify(value));
        const serialized = JSON.stringify(json);
        out[key] = serialized.length > 1200 ? `${serialized.slice(0, 1200)}…` : json;
      } catch (_) {
        out[key] = String(value).slice(0, 300);
      }
      count += 1;
    }
  }
  return Object.keys(out).length ? out : null;
}

function targetIdFrom(req) {
  const p = req.params || {};
  return p.id || p.agencyId || p.creatorId || p.memberId || p.userId || p.deviceId || p.model || null;
}

function targetTypeFrom(req) {
  const path = String(req.baseUrl || req.originalUrl || req.url || "").toLowerCase();
  if (path.includes("billing")) return "admin_billing";
  if (path.includes("data")) return "admin_data";
  if (path.includes("auth")) return "admin_auth";
  return "admin_route";
}

function agencyIdFrom(req) {
  const p = req.params || {};
  const q = req.query || {};
  const b = req.body || {};
  if (p.agencyId) return p.agencyId;
  if (q.agencyId) return q.agencyId;
  if (b.agencyId) return b.agencyId;

  const path = String(req.path || req.originalUrl || "").toLowerCase();
  if ((path.includes("/agency/") || path.includes("/agencies/")) && p.id) return p.id;
  return null;
}

function routePath(req) {
  const base = String(req.baseUrl || "");
  const route = String(req.route?.path || req.path || "");
  return `${base}${route}`.replace(/\/+/g, "/").slice(0, 180) || "unknown";
}

function actionName(req) {
  const method = String(req.method || "GET").toLowerCase();
  return `admin.http.${method}.${routePath(req).replace(/[^a-zA-Z0-9:_/-]+/g, "_")}`.slice(0, 220);
}

function adminHttpAuditMiddleware(req, res, next) {
  const startedAt = Date.now();
  res.once("finish", () => {
    const adminUserId = req.admin?.id;
    if (!adminUserId) return;

    // Fire-and-forget. Admin actions must not fail because audit insert failed.
    void prisma.adminActionLog.create({
      data: {
        adminUserId,
        agencyId: agencyIdFrom(req),
        action: actionName(req),
        targetType: targetTypeFrom(req),
        targetId: targetIdFrom(req),
        before: null,
        after: {
          method: req.method,
          path: req.originalUrl || req.url,
          route: routePath(req),
          statusCode: res.statusCode,
          ok: res.statusCode < 400,
          durationMs: Date.now() - startedAt,
          query: safeSmallObject(req.query),
          body: ["POST", "PUT", "PATCH", "DELETE"].includes(String(req.method || "").toUpperCase())
            ? safeSmallObject(req.body)
            : null,
          ip: req.ip || null,
          userAgent: String(req.headers?.["user-agent"] || "").slice(0, 300) || null,
        },
      },
    }).catch((err) => {
      console.warn("[admin-audit] failed:", err?.message || err);
    });
  });
  next();
}

module.exports = {
  adminHttpAuditMiddleware,
};
