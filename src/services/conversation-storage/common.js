"use strict";
const { createHash, randomUUID } = require("node:crypto");
function fail(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}
function check(ok, code, status = 409) {
  if (!ok) throw fail(code, status);
}
function text(value, max = 240) {
  check(
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"),
    "CONVERSATION_ID_INVALID",
    400
  );
  return value;
}
function platformId(value) {
  check(typeof value === "string" && /^[1-9][0-9]{0,39}$/.test(value), "PLATFORM_ID_INVALID", 400);
  return value;
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function bounded(value, max = 65536) {
  const encoded = JSON.stringify(value);
  check(typeof encoded === "string" && Buffer.byteLength(encoded) <= max, "CONVERSATION_PAYLOAD_TOO_LARGE", 413);
  return encoded;
}
function canonical(value) {
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])])
    );
  return value;
}
function hash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value ?? null)))
    .digest("hex");
}
function scopeId(agencyId, platformCreatorId) {
  return hash(["onlyfans", text(agencyId), platformId(platformCreatorId)]);
}
function integer(value, fallback = 0, max = 100000000) {
  const n = Number(value ?? fallback);
  check(Number.isSafeInteger(n) && n >= 0 && n <= max, "CONVERSATION_INTEGER_INVALID", 400);
  return n;
}
function iso(value) {
  const date = new Date(value);
  check(value != null && Number.isFinite(date.getTime()), "CONVERSATION_DATE_INVALID", 400);
  return date.toISOString();
}
function rows(db, sql, ...params) {
  return db.$queryRawUnsafe(sql, ...params);
}
async function one(db, sql, ...params) {
  return (await rows(db, sql, ...params))[0] || null;
}
function exec(db, sql, ...params) {
  return db.$executeRawUnsafe(sql, ...params);
}
function transaction(db, fn) {
  return db.$transaction(fn, { maxWait: 5000, timeout: 15000 });
}
function jsonResult(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
}
function commandId(value, { receiptReplay = false } = {}) {
  text(value, 160);
  const match = /^(?:cs1|ac1):(\d{13}):[a-f0-9-]{36}$/.exec(value);
  check(
    match && Number(match[1]) <= Date.now() + 300000 && (receiptReplay || Number(match[1]) >= Date.now() - 86400000),
    "CONVERSATION_COMMAND_EXPIRED",
    409
  );
  return value;
}
function newCommandId() {
  return `cs1:${Date.now()}:${randomUUID()}`;
}
module.exports = {
  fail,
  check,
  text,
  platformId,
  object,
  bounded,
  hash,
  scopeId,
  integer,
  iso,
  rows,
  one,
  exec,
  transaction,
  jsonResult,
  commandId,
  newCommandId,
  randomUUID,
};
