"use strict";
const c = require("./common");
const RETRY_MS = 300000;
async function readCapacity(db, domain, maxBytes) {
  const row = await c.one(db, `WITH sizes AS MATERIALIZED (
    SELECT datname,pg_database_size(oid)::bigint bytes FROM pg_database
    WHERE NOT datistemplate AND has_database_privilege(oid,'CONNECT'))
    SELECT coalesce(sum(bytes),0)::bigint bytes,
      (SELECT jsonb_agg(x) FROM (SELECT datname,bytes FROM sizes ORDER BY bytes DESC,datname LIMIT 8) x) databases
    FROM sizes`);
  const usedBytes = Number(row?.bytes);
  c.check(Number.isSafeInteger(usedBytes) && usedBytes >= 0, "CONVERSATION_CAPACITY_MEASUREMENT_INVALID", 503);
  return { at: Date.now(), domain, usedBytes, maxBytes,
    databases: (Array.isArray(row?.databases) ? row.databases : []).map(row => ({
      database: String(row.datname).slice(0, 63), bytes: Number(row.bytes),
    })).filter(row => Number.isSafeInteger(row.bytes) && row.bytes >= 0) };
}
function assertCapacity(snapshot) {
  if (snapshot.usedBytes >= snapshot.maxBytes) throw Object.assign(c.fail("CONVERSATION_DATABASE_CAPACITY", 507), {
    retryAfterMs: RETRY_MS,
    capacity: { domain: snapshot.domain, usedBytes: snapshot.usedBytes,
      maxBytes: snapshot.maxBytes, databases: snapshot.databases },
  });
}
module.exports = { RETRY_MS, readCapacity, assertCapacity };
