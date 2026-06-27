"use strict";

const crypto = require("node:crypto");

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

function clean(value, max = 500) {
  const s = String(value || "").trim();
  return s ? s.slice(0, max) : "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function stableJson(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function prune(cache, now, ttlMs, maxEntries) {
  for (const [key, item] of cache) {
    if (!item || item.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function createIdempotencyMiddleware(options = {}) {
  const ttlMs = Math.max(60_000, Number(options.ttlMs || process.env.IDEMPOTENCY_TTL_MS || DEFAULT_TTL_MS));
  const maxEntries = Math.max(100, Number(options.maxEntries || process.env.IDEMPOTENCY_MAX_ENTRIES || DEFAULT_MAX_ENTRIES));
  const cache = new Map();

  return function idempotencyMiddleware(req, res, next) {
    const method = String(req.method || "GET").toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();

    const rawKey = clean(req.get("Idempotency-Key") || req.get("X-Idempotency-Key"), 240);
    if (!rawKey) return next();

    const now = Date.now();
    prune(cache, now, ttlMs, maxEntries);

    const authScope = sha256(req.get("Authorization") || req.ip || "anonymous").slice(0, 24);
    const bodyHash = sha256(stableJson(req.body || {}));
    const cacheKey = sha256(`${method}\n${req.originalUrl || req.url}\n${authScope}\n${rawKey}`);
    const existing = cache.get(cacheKey);

    if (existing) {
      if (existing.bodyHash !== bodyHash) {
        return res.status(409).json({
          ok: false,
          code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY",
          error: "Idempotency-Key was already used for this endpoint with a different request body",
        });
      }
      if (existing.pending) {
        return res.status(409).json({
          ok: false,
          code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
          error: "The first request with this Idempotency-Key is still in progress",
        });
      }
      res.setHeader("Idempotency-Replayed", "true");
      for (const [name, value] of Object.entries(existing.headers || {})) {
        if (value !== undefined && value !== null) res.setHeader(name, value);
      }
      return res.status(existing.statusCode || 200).send(existing.body);
    }

    const entry = { pending: true, bodyHash, expiresAt: now + ttlMs };
    cache.set(cacheKey, entry);

    const originalSend = res.send.bind(res);
    res.send = function patchedSend(body) {
      try {
        const statusCode = res.statusCode || 200;
        if (statusCode < 500) {
          cache.set(cacheKey, {
            pending: false,
            bodyHash,
            statusCode,
            body,
            headers: {
              "content-type": res.getHeader("content-type"),
            },
            expiresAt: Date.now() + ttlMs,
          });
        } else {
          cache.delete(cacheKey);
        }
      } catch (_) {
        cache.delete(cacheKey);
      }
      return originalSend(body);
    };

    res.once("close", () => {
      const item = cache.get(cacheKey);
      if (item?.pending && !res.writableEnded) cache.delete(cacheKey);
    });

    return next();
  };
}

module.exports = { createIdempotencyMiddleware };
