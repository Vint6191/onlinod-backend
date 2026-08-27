"use strict";

const { randomUUID } = require("node:crypto");
const logger = require("../utils/logger");

const TRACE_HEADER = "x-onlinod-trace-id";
const STARTUP_TRACE_HEADER = "x-onlinod-startup-trace-id";
const TRACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function safeTraceId(value) {
  const text = String(Array.isArray(value) ? value[0] : value || "").trim();
  return TRACE_ID_RE.test(text) ? text : null;
}

function requestPath(req) {
  const direct = String(req?.path || "").trim();
  if (direct) return direct;
  return String(req?.originalUrl || req?.url || "/").split("?")[0] || "/";
}

function expectedLongRequest(path) {
  const normalized = String(path || "").toLowerCase();
  return normalized.endsWith("/events") || normalized.includes("/events/");
}

function createRequestObservabilityMiddleware(options = {}) {
  const log = options.log || logger;
  const configuredSlowMs = Number(options.slowRequestMs ?? process.env.HTTP_SLOW_REQUEST_MS ?? 1500);
  const slowRequestMs = Number.isFinite(configuredSlowMs) && configuredSlowMs >= 100
    ? Math.floor(configuredSlowMs)
    : 1500;

  return function requestObservability(req, res, next) {
    const traceId = safeTraceId(req.headers?.[TRACE_HEADER]) || randomUUID();
    const startupTraceId = safeTraceId(req.headers?.[STARTUP_TRACE_HEADER]);
    const startedAtNs = process.hrtime.bigint();
    const path = requestPath(req);
    let settled = false;

    req.traceId = traceId;
    req.startupTraceId = startupTraceId;
    try { res.setHeader("X-Onlinod-Trace-Id", traceId); } catch {}

    const finish = (terminalEvent) => {
      if (settled) return;
      settled = true;
      const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
      const meta = {
        traceId,
        startupTraceId,
        method: String(req.method || "GET").toUpperCase(),
        path,
        status: Number(res.statusCode || 0) || null,
        durationMs: Math.round(durationMs * 10) / 10,
        terminalEvent,
      };
      if (durationMs >= slowRequestMs && !expectedLongRequest(path)) {
        log.warn("slow http request", meta);
      } else {
        log.debug("http request", meta);
      }
    };

    res.once("finish", () => finish("finish"));
    res.once("close", () => finish("close"));
    next();
  };
}

module.exports = {
  TRACE_HEADER,
  STARTUP_TRACE_HEADER,
  safeTraceId,
  requestPath,
  expectedLongRequest,
  createRequestObservabilityMiddleware,
};
