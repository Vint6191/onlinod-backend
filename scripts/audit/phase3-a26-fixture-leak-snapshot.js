#!/usr/bin/env node
"use strict";

const prisma = require("../../src/prisma");

function quoteIdent(value) {
  return `"${String(value || "").replaceAll('"', '""')}"`;
}
function quoteLiteral(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

async function discoverFixtureOwnedTables() {
  const rows = await prisma.$queryRawUnsafe(`
    WITH RECURSIVE tenant_roots AS (
      SELECT DISTINCT c.oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname <> '_prisma_migrations'
        AND (
          c.relname IN ('User', 'WorkerDevice', 'Agency', 'CreatorAccount')
          OR EXISTS (
            SELECT 1
            FROM pg_attribute a
            WHERE a.attrelid = c.oid
              AND a.attnum > 0
              AND NOT a.attisdropped
              AND a.attname IN ('agencyId', 'creatorId')
          )
        )
    ), owned(oid) AS (
      SELECT oid FROM tenant_roots
      UNION
      SELECT fk.conrelid
      FROM pg_constraint fk
      JOIN owned parent ON parent.oid = fk.confrelid
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      WHERE fk.contype = 'f'
        AND child_ns.nspname = current_schema()
        AND child.relkind = 'r'
        AND child.relname <> '_prisma_migrations'
    )
    SELECT c.relname AS "table",
           EXISTS (
             SELECT 1
             FROM pg_attribute a
             WHERE a.attrelid = c.oid
               AND a.attnum > 0
               AND NOT a.attisdropped
               AND a.attname = 'id'
           ) AS "hasId"
    FROM owned o
    JOIN pg_class c ON c.oid = o.oid
    ORDER BY c.relname ASC
  `);
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ table: String(row?.table || ""), hasId: row?.hasId === true }))
    .filter((row) => row.table && row.table !== "_prisma_migrations");
}

async function snapshotTables(tables) {
  if (!tables.length) return [];
  const selects = tables.map(({ table, hasId }) => {
    const q = quoteIdent(table);
    const digestExpression = hasId
      ? `md5(COALESCE(string_agg(t."id"::text, ',' ORDER BY t."id"::text), ''))`
      : `md5(COALESCE(string_agg(md5(row_to_json(t)::text), ',' ORDER BY md5(row_to_json(t)::text)), ''))`;
    return `SELECT ${quoteLiteral(table)}::text AS "table", COUNT(*)::bigint AS "count", ${digestExpression} AS "identityDigest" FROM ${q} t`;
  });
  return prisma.$queryRawUnsafe(selects.join("\nUNION ALL\n"));
}

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT current_schema() AS "schema", current_setting('search_path') AS "searchPath"
  `);
  const schema = String(rows?.[0]?.schema || "");
  if (!schema || schema === "public") throw new Error(`A26 leak snapshot requires isolated non-public schema, got ${schema || "<none>"}`);

  const tables = await discoverFixtureOwnedTables();
  const snapshot = await snapshotTables(tables);
  const counts = {};
  const identities = {};
  for (const row of Array.isArray(snapshot) ? snapshot : []) {
    const table = String(row?.table || "");
    if (!table) continue;
    counts[table] = Number(row?.count || 0);
    identities[table] = String(row?.identityDigest || "");
  }
  console.log(`A26_FIXTURE_LEAK_SNAPSHOT ${JSON.stringify({
    schema,
    searchPath: rows?.[0]?.searchPath || null,
    trackedTables: tables.length,
    counts,
    identities,
  })}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect().catch(() => null); });
}

module.exports = { discoverFixtureOwnedTables, snapshotTables, quoteIdent, quoteLiteral };
