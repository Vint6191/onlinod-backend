"use strict";

const { createHash } = require("node:crypto");
const logger = require("../utils/logger");
const DIAGNOSTIC_VERSION = "recovery-170-v1";
const PRIVATE_KEY = /token|secret|password|authorization|cookie|payload|^(?:params|continuation|headers|body|raw|stack)$/i;

// Callers must construct allowlisted metadata, never pass request/job objects.
// This second fence bounds output and removes credentials even if a future
// caller accidentally adds a nested private field.
function safeDiagnosticValue(value, depth = 0, budget = { left: 1500 }) {
  if (--budget.left < 0 || depth > 8) return "[bounded]";
  if (value == null || typeof value === "boolean") return value ?? null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return value.slice(0, 240);
  if (value instanceof Date) return Number.isFinite(+value) ? value.toISOString() : null;
  if (Array.isArray(value)) return value.slice(0, 40).map(row => safeDiagnosticValue(row, depth + 1, budget));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 48).map(([key, row]) => [
    key.slice(0, 100), PRIVATE_KEY.test(key) ? "[redacted]" : safeDiagnosticValue(row, depth + 1, budget),
  ]));
  return null;
}

function diagnosticError(error) {
  const text = String(error?.message || error || "");
  const code = String(error?.code || "");
  const databaseCode = String(error?.meta?.code || error?.cause?.code || "");
  return {
    code: /^[A-Z][A-Z0-9_]{1,100}$/.test(code) ? code : "UNCLASSIFIED_ERROR",
    ...(/^[0-9A-Z]{5}$/.test(databaseCode) ? { databaseCode } : {}),
    fingerprint: createHash("sha256").update(text).digest("hex").slice(0, 16),
  };
}

function createRuntimeDiagnosticEmitter({ log = logger, now = Date.now, capacity = 1024, maxPerMinute = 120 } = {}) {
  const recent = new Map();
  const bound = Math.max(1, Math.min(4096, capacity));
  let windowStart = null, emitted = 0, suppressed = 0;
  return function emit(event, key, details, { level = "warn", intervalMs = 60_000 } = {}) {
    try {
      const at = now(), identity = `${event}:${key}`;
      if (windowStart === null || at < windowStart || at - windowStart >= 60_000) {
        windowStart = at; emitted = 0;
      }
      const previous = recent.get(identity);
      if (previous !== undefined && at >= previous && at - previous < Math.max(1000, intervalMs)) return false;
      if (emitted >= maxPerMinute) { suppressed++; return false; }
      if (recent.has(identity)) recent.delete(identity);
      else if (recent.size >= bound) recent.delete(recent.keys().next().value);
      recent.set(identity, at); emitted++;
      log[["info", "warn", "error"].includes(level) ? level : "warn"](event, {
        diagnosticVersion: DIAGNOSTIC_VERSION,
        ...safeDiagnosticValue(details || {}),
        ...(suppressed ? { diagnosticRateLimited: suppressed } : {}),
      });
      suppressed = 0;
      return true;
    } catch { return false; } // Observability can never change a lease outcome.
  };
}

const emitRuntimeDiagnostic = createRuntimeDiagnosticEmitter();
module.exports = { DIAGNOSTIC_VERSION, safeDiagnosticValue, diagnosticError, createRuntimeDiagnosticEmitter, emitRuntimeDiagnostic };
