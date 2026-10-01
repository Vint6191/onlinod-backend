"use strict";
const definitions = require("./analytics-traffic-index-contract.json");
const { normalizePredicate } = require("./phase7-legacy-storage-indexes");
const q = s => '"' + s.replaceAll('"', '""') + '"';
const normalizeKeys = s => String(s || "").replace(/[\s"]/g, "");
const fail = (code, name) => Object.assign(new Error(`${code}:${name}`), { code, index: name });
async function state(db, spec) {
  const rows = await db.$queryRawUnsafe(`SELECT t.relname AS table,i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,
    am.amname AS method,pg_get_expr(i.indpred,i.indrelid) AS predicate,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true)
      || CASE WHEN (i.indoption[n-1] & 1)=1 THEN ' DESC' ELSE '' END
      || CASE WHEN (i.indoption[n-1] & 3)=1 THEN ' NULLS LAST'
              WHEN (i.indoption[n-1] & 3)=2 THEN ' NULLS FIRST' ELSE '' END
      FROM generate_series(1,i.indnkeyatts) n ORDER BY n) AS keys
    FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace ns ON ns.oid=x.relnamespace JOIN pg_am am ON am.oid=x.relam
    WHERE ns.nspname=current_schema() AND x.relname=$1`, spec.name);
  const row = rows[0];
  return { exists: Boolean(row), valid: Boolean(row && row.valid && row.ready && row.table === spec.table && row.unique === spec.unique
    && row.method === "btree" && normalizeKeys(row.keys.join(",")) === normalizeKeys(spec.expression)
    && normalizePredicate(row.predicate) === normalizePredicate(spec.where)) };
}
async function ensureIndexes(db, { create = false } = {}) {
  // Called on an autocommit connection. These are large existing fact tables;
  // migration transactions only add metadata and never build their indexes.
  for (const spec of definitions) {
    let current = await state(db, spec);
    if (current.valid) continue;
    if (current.exists) throw fail("ANALYTICS_TRAFFIC_INDEX_INVALID", spec.name);
    if (!create) throw fail("ANALYTICS_TRAFFIC_INDEX_REQUIRED", spec.name);
    await db.$executeRawUnsafe(`CREATE ${spec.unique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${q(spec.name)} ON ${q(spec.table)} (${spec.expression})${spec.where ? " WHERE " + spec.where : ""}`);
    current = await state(db, spec);
    if (!current.valid) throw fail("ANALYTICS_TRAFFIC_INDEX_BUILD_INVALID", spec.name);
  }
  return { ready: true, contracts: definitions.length };
}
module.exports = { definitions, state, ensureIndexes };
if (require.main === module) {
  require("dotenv").config();
  const { PrismaClient } = require("@prisma/client");
  const url = new URL(process.env.DATABASE_URL); url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  (async () => {
    await db.$executeRawUnsafe("SET lock_timeout='5s'");
    await db.$executeRawUnsafe("SET statement_timeout='10min'");
    await db.$executeRawUnsafe("SELECT pg_advisory_lock(hashtextextended('analytics-traffic-indexes-v2',0))");
    return ensureIndexes(db, { create: process.argv.includes("--create") });
  })().then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
}
