"use strict";

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SENSITIVE_KEY = /(?:^|[_-])(?:authorization|cookie|cookies|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|session|csrf|api[_-]?key|apikey)(?:$|[_-])/i;

function sanitizeAnalyticsRaw(value, options = {}) {
  const maxDepth = Math.max(1, Math.min(20, Number(options.maxDepth) || 8));
  const maxArrayLength = Math.max(1, Math.min(20_000, Number(options.maxArrayLength) || 5_000));
  const maxObjectKeys = Math.max(1, Math.min(5_000, Number(options.maxObjectKeys) || 1_000));
  const maxStringLength = Math.max(32, Math.min(100_000, Number(options.maxStringLength) || 10_000));
  const seen = new WeakSet();

  function visit(input, depth) {
    if (input === null) return null;
    if (typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "string") return input.slice(0, maxStringLength);
    if (typeof input === "bigint") return Number(input);
    if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.toISOString() : null;
    if (!input || typeof input !== "object" || depth > maxDepth) return undefined;
    if (seen.has(input)) return undefined;
    seen.add(input);

    if (Array.isArray(input)) {
      const result = [];
      for (const item of input.slice(0, maxArrayLength)) {
        const clean = visit(item, depth + 1);
        if (clean !== undefined) result.push(clean);
      }
      return result;
    }

    const result = {};
    let count = 0;
    for (const [key, item] of Object.entries(input)) {
      if (count >= maxObjectKeys) break;
      if (BLOCKED_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
      const clean = visit(item, depth + 1);
      if (clean === undefined) continue;
      result[key] = clean;
      count += 1;
    }
    return result;
  }

  const clean = visit(value, 0);
  return clean === undefined ? null : clean;
}

module.exports = {
  BLOCKED_KEYS,
  SENSITIVE_KEY,
  sanitizeAnalyticsRaw,
};
