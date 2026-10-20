"use strict";

// This identifies temporary DATABASE failures only. It says nothing about
// whether an operation is safe to repeat: callers must own a replayable SQL
// transaction or resume from an authoritative durable cursor. Never use this
// to resend a provider write with an unknown outcome.
const TRANSIENT_DATABASE_CODES = Object.freeze([
  "P1001", "P1002", "P1008", "P1017", "P2024", "P2034",
  "08000", "08001", "08003", "08006", "08007",
  "40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03", "53300",
  "DB_COMMIT_DEADLINE_EXCEEDED",
]);
const transientCodes = new Set(TRANSIENT_DATABASE_CODES);

function connectionDiagnostic(message) {
  let text = String(message || "").trim();
  // Prisma 5 initialization failures raised by a query can have neither code
  // nor errorCode. Its invocation envelope is presentation, not a domain cause.
  // Accept only a terminal, exact connection diagnostic within that envelope.
  if (/^Invalid `[^`\r\n]+` invocation(?: in)?(?::|\s)/.test(text)) {
    const diagnostic = /(?:^|\n\s*\n)(Timed out fetching a new connection from the connection pool\.[\s\S]*|Can't reach database server at [^\r\n]+(?:\r?\n\s*Please make sure your database server is running at [^\r\n]+\.)?|Server has closed the connection\.?)$/.exec(text);
    if (!diagnostic) return null;
    text = diagnostic[1];
  }
  if (/^Timed out fetching a new connection from the connection pool\./.test(text)) return { code: "P2024" };
  if (/^Can't reach database server at [^\r\n]+(?:\r?\n\s*Please make sure your database server is running at [^\r\n]+\.)?$/.test(text)) return { code: "P1001" };
  if (/^Server has closed the connection\.?$/.test(text)) return { code: "P1017" };
  return null;
}

function expiredTransaction(message) {
  const text = String(message || "");
  return /Unable to start a transaction in the given time\b/i.test(text)
    || (/cannot be executed on an expired transaction\b/i.test(text)
      && /The timeout for this transaction was \d+ ms, however \d+ ms passed\b/i.test(text));
}

function classifyDatabaseFailure(error, ancestors = new Set()) {
  const seen = new Set(ancestors);
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current.retryable === false || Number(current.status) >= 400 && Number(current.status) < 500) return null;
    const code = String(current.code || (current.name === "PrismaClientInitializationError" ? current.errorCode : "") || "");
    if (transientCodes.has(code)) return { code };
    if (code === "P2028") return expiredTransaction(current.meta?.error || current.message) ? { code } : null;
    if (code === "P2010") {
      const sqlCode = String(current.meta?.code || "");
      return transientCodes.has(sqlCode) ? { code: sqlCode } : null;
    }
    if (!code && current.name === "PrismaClientInitializationError") return connectionDiagnostic(current.message);
    if (current.name === "AggregateError" && Array.isArray(current.errors) && current.errors.length) {
      // The recurring planner combines independent SQL substeps. Every failed
      // step must have a known database cause; one contract error still stops it.
      const causes = current.errors.map(cause => classifyDatabaseFailure(cause, seen));
      return causes.every(Boolean) ? { code: "DB_TRANSIENT_AGGREGATE" } : null;
    }
    // Do not let a historical cause override a deliberate domain rejection or
    // a different Prisma error (e.g. a missing column / invalid transaction).
    if ((code && code !== "DB_TIME_AUTHORITY_QUERY_FAILED")
      || ["TypeError", "ReferenceError", "SyntaxError", "PrismaClientValidationError", "ZodError"].includes(current.name)) return null;
    current = current.cause;
  }
  return null;
}

function isTransientDatabaseError(error) { return Boolean(classifyDatabaseFailure(error)); }

function classifyStoredDatabaseFailure({ code = null, message = "" } = {}) {
  const text = String(message || "");
  const normalized = String(code || "");
  // Only a writer that already classified an actual error creates this prefix.
  const classified = /^\[TRANSIENT_DB:([A-Z0-9_]+)\] /.exec(text);
  if (classified && (transientCodes.has(classified[1]) || ["P2028", "DB_TRANSIENT_AGGREGATE"].includes(classified[1]))) return { code: classified[1] };
  if (transientCodes.has(normalized)) return { code: normalized };
  if ((normalized === "P2028" || !normalized) && expiredTransaction(text)) return { code: "P2028" };
  if (normalized === "P2010" || !normalized) {
    const sql = /Raw query failed\. Code: [`'"]([0-9A-Z]{5})[`'"]/.exec(text);
    if (sql && transientCodes.has(sql[1])) return { code: sql[1] };
  }
  // Historical Subscriber signals retained only Prisma's message. Recognize
  // its specific connection/pool diagnostics, not arbitrary 'timeout' text.
  if (!normalized) return connectionDiagnostic(text);
  return null;
}

function describeDatabaseFailure(error, maxLength = 2000) {
  const classified = classifyDatabaseFailure(error);
  const message = String(error?.message || error || "DATABASE_FAILURE");
  return (classified ? `[TRANSIENT_DB:${classified.code}] ${message}` : message).slice(0, Math.max(100, maxLength));
}

module.exports = { TRANSIENT_DATABASE_CODES, classifyDatabaseFailure, isTransientDatabaseError, classifyStoredDatabaseFailure, describeDatabaseFailure };
