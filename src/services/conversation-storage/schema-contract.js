"use strict";
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { fail } = require("./common");
const domains = new Set(["dialogs", "crm"]);
const categories = ["tables", "columns", "constraints", "indexes", "triggers", "rules"];
const digest = (value) => createHash("sha256").update(value).digest("hex");

// Catalog fields are read together so a readiness decision cannot combine
// metadata from different statements around a committed DDL change. Foreign
// keys use qualified object identities, not search_path-dependent deparsing;
// index keys use column/expression identities, not physical attribute numbers.
const catalogSql = `WITH relations AS (
  SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
)
SELECT jsonb_build_object(
  'tables', COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind::text,
    'persistence',c.relpersistence::text,'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity)
    ORDER BY c.relname) FROM relations c),'[]'::jsonb),
  'columns', COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,
    'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity::text,
    'generated',a.attgenerated::text,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attname)
    FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum),'[]'::jsonb),
  'constraints', COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',x.conname,
    'type',x.contype::text,'definition',CASE WHEN x.contype='f' THEN NULL ELSE pg_get_constraintdef(x.oid) END,
    'foreignKey',CASE WHEN x.contype='f' THEN jsonb_build_object(
      'columns',ARRAY(SELECT a.attname FROM unnest(x.conkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.ord),
      'schema',rn.nspname,'table',rc.relname,
      'references',ARRAY(SELECT a.attname FROM unnest(x.confkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=rc.oid AND a.attnum=k.num ORDER BY k.ord),
      'onDelete',x.confdeltype::text,'onUpdate',x.confupdtype::text,'match',x.confmatchtype::text
    ) ELSE NULL END,'validated',x.convalidated,'deferrable',x.condeferrable,'deferred',x.condeferred) ORDER BY c.relname,x.conname)
    FROM relations c JOIN pg_constraint x ON x.conrelid=c.oid
    LEFT JOIN pg_class rc ON rc.oid=x.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace
    WHERE x.contype IN ('c','f','p','u')),'[]'::jsonb),
  'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',i.relname,
    'method',m.amname,'unique',x.indisunique,'valid',x.indisvalid,'ready',x.indisready,
    'keys',(SELECT jsonb_agg(pg_get_indexdef(x.indexrelid,k,false) ORDER BY k) FROM generate_series(1,x.indnatts) k),
    'options',x.indoption::text,'keyCount',x.indnkeyatts::int,
    'expressions',pg_get_expr(x.indexprs,x.indrelid),'predicate',pg_get_expr(x.indpred,x.indrelid))
    ORDER BY c.relname,i.relname) FROM relations c JOIN pg_index x ON x.indrelid=c.oid
    JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_am m ON m.oid=i.relam),'[]'::jsonb),
  'triggers', COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,
    'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled::text) ORDER BY c.relname,t.tgname)
    FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid WHERE NOT t.tgisinternal),'[]'::jsonb),
  'rules', COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',r.rulename,
    'definition',pg_get_ruledef(r.oid)) ORDER BY c.relname,r.rulename)
    FROM relations c JOIN pg_rewrite r ON r.ev_class=c.oid WHERE r.rulename<>'_RETURN'),'[]'::jsonb)
) AS catalog`;

function schema(domain) {
  if (!domains.has(domain)) throw fail("CONVERSATION_DOMAIN_INVALID", 503);
  const contract = require("./schema-contract.json").domains[domain];
  const source = readFileSync(join(__dirname, "sql", `${domain}-v1.sql`), "utf8").replace(/\r\n/g, "\n");
  const checksum = digest(source);
  if (checksum !== contract.sourceChecksum) throw fail("CONVERSATION_MIGRATION_CHECKSUM_MISMATCH", 503);
  // Only the two known platform encodings of these exact SQL bytes are
  // compatible. An unknown historical receipt is never rewritten or adopted.
  return { domain, source, checksum, checksums: new Set([checksum, digest(source.replace(/\n/g, "\r\n"))]), catalog: contract.catalog };
}
async function readCatalog(db) {
  return (await db.$queryRawUnsafe(catalogSql))[0].catalog;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function identity(row) { return JSON.stringify(canonical(row)); }
function differences(expected, actual, onlyVersion = false) {
  const problems = [];
  for (const category of categories) {
    const select = (rows) => onlyVersion ? rows.filter((row) => (row.table || row.name) === "conversation_schema_version") : rows;
    const wanted = select(expected[category] || []), present = select(actual[category] || []);
    const available = new Set(present.map(identity));
    const accepted = new Set(wanted.map(identity));
    for (const row of wanted) if (!available.has(identity(row))) problems.push(`${category}:${row.table ? row.table + "." : ""}${row.name}`);
    // Unknown object names can contain arbitrary data. The diagnostic only
    // carries a bounded category/count, never database-supplied identifiers.
    const unexpected = present.filter((row) => !accepted.has(identity(row))).length;
    if (unexpected) problems.push(`${category}:unexpected:${unexpected}`);
  }
  return problems;
}
function assertCatalog(expected, actual, onlyVersion = false) {
  const problems = differences(expected, actual, onlyVersion);
  if (problems.length) throw Object.assign(fail("CONVERSATION_DATABASE_CONTRACT_REQUIRED", 503), { problems });
}
function assertReceipt(rows, spec) {
  if (rows.some((row) => row.domain !== spec.domain)) throw fail("CONVERSATION_DATABASES_MUST_BE_SEPARATE", 503);
  if (rows.length !== 1 || rows[0].version !== 1 || !spec.checksums.has(rows[0].checksum)) {
    throw fail("CONVERSATION_MIGRATION_CHECKSUM_MISMATCH", 503);
  }
}
async function verify(db, domain) {
  const spec = schema(domain), catalog = await readCatalog(db);
  if (!catalog.tables.some((row) => row.name === "conversation_schema_version")) throw fail("CONVERSATION_DATABASE_MIGRATION_REQUIRED", 503);
  assertCatalog(spec.catalog, catalog, true);
  const rows = await db.$queryRawUnsafe('SELECT domain,version,checksum FROM "public"."conversation_schema_version"');
  assertReceipt(rows, spec);
  assertCatalog(spec.catalog, catalog);
  return { ready: true, version: 1, domain };
}
module.exports = { schema, readCatalog, assertCatalog, assertReceipt, verify };
