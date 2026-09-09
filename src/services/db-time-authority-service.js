"use strict";

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * PostgreSQL is the cross-replica clock authority for durable ordering/leases.
 * Prisma and TransactionClient both expose $queryRawUnsafe in production.
 * Small unit-test doubles frequently do not; only those doubles may use the
 * explicit fallback passed by the caller. If a real DB clock query exists but
 * fails or returns an invalid value, fail closed instead of silently trusting
 * process wall time.
 */
async function dbAuthorityNow({ db, fallbackNow = null } = {}) {
  if (typeof db?.$queryRawUnsafe === "function") {
    let rows;
    try {
      rows = await db.$queryRawUnsafe('SELECT clock_timestamp() AS "authorityNow"');
    } catch (cause) {
      const error = new Error(`DB_TIME_AUTHORITY_QUERY_FAILED:${cause?.message || cause}`);
      error.code = "DB_TIME_AUTHORITY_QUERY_FAILED";
      error.cause = cause;
      throw error;
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    const authorityNow = asDate(row?.authorityNow ?? row?.authoritynow ?? row?.clock_timestamp);
    if (!authorityNow) {
      const error = new Error("DB_TIME_AUTHORITY_INVALID");
      error.code = "DB_TIME_AUTHORITY_INVALID";
      throw error;
    }
    return authorityNow;
  }

  const fallback = asDate(fallbackNow);
  if (fallback) return fallback;
  const error = new Error("DB_TIME_AUTHORITY_CLIENT_REQUIRED");
  error.code = "DB_TIME_AUTHORITY_CLIENT_REQUIRED";
  throw error;
}

module.exports = { dbAuthorityNow, asDate };
