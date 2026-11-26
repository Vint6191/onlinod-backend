"use strict";
const { configuration } = require("../../src/services/conversation-storage/databases");
const { schema, readCatalog, assertCatalog, assertReceipt } = require("../../src/services/conversation-storage/schema-contract");
const { fail } = require("../../src/services/conversation-storage/common");
const { PrismaClient } = require("@prisma/client");
const { annotateFailure, reportFailure, preservePrimaryFailure } = require("./install-diagnostics");

async function inspect(db, domain) {
  const spec = schema(domain), catalog = await readCatalog(db);
  const hasReceiptTable = catalog.tables.some((row) => row.name === "conversation_schema_version");
  if (hasReceiptTable) {
    assertCatalog(spec.catalog, catalog, true);
    const rows = await db.$queryRawUnsafe('SELECT domain,version,checksum FROM "public"."conversation_schema_version"');
    if (rows.length) {
      assertReceipt(rows, spec);
      assertCatalog(spec.catalog, catalog);
      return { domain, version: 1, fresh: false };
    }
  }
  if (catalog.tables.some((row) => row.name !== "conversation_schema_version")) {
    throw fail("EMPTY_CONVERSATION_DATABASE_REQUIRED", 503);
  }
  const access = (await db.$queryRawUnsafe(`SELECT has_schema_privilege(n.oid,'USAGE') AS usage,
    has_schema_privilege(n.oid,'CREATE') AS create,
    current_setting('transaction_read_only')='off' AS writable
    FROM pg_namespace n WHERE n.nspname='public'`))[0];
  if (!access) throw fail("CONVERSATION_PUBLIC_SCHEMA_REQUIRED", 503);
  if (!access.usage || !access.create || !access.writable) throw fail("DATABASE_ACCESS_DENIED", 503);
  if (hasReceiptTable && !(await db.$queryRawUnsafe(
    `SELECT has_table_privilege('public.conversation_schema_version','INSERT') AS allowed`
  ))[0].allowed) throw fail("DATABASE_ACCESS_DENIED", 503);
  return { domain, version: 1, fresh: true };
}

async function install(db, domain) {
  try {
    const spec = schema(domain);
    return await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(180001)");
      const installation = await inspect(tx, domain);
      if (!installation.fresh) {
        // Verification is read-only. A known CRLF receipt is retained verbatim
        // and never authorizes repairing unknown DDL.
        return installation;
      }
      for (const statement of spec.source.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean)) {
        await tx.$executeRawUnsafe(statement);
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO "public"."conversation_schema_version"(domain,version,checksum) VALUES($1,1,$2)',
        domain, spec.checksum
      );
      // A new receipt and all DDL share this transaction. Catalog mismatch or
      // any SQL failure rolls both back; existing user data is never reset.
      assertCatalog(spec.catalog, await readCatalog(tx));
      return { domain, version: 1, fresh: true };
    }, { timeout: 60000, maxWait: 10000 });
  } catch (error) {
    throw annotateFailure(error, { phase: "CONVERSATION_INSTALL", domain });
  }
}

async function inDomain(config, domain, phase, work) {
  let db, primary;
  try {
    db = new PrismaClient({ datasources: { db: { url: config[domain] } } });
    // Prisma 5 exposes stable initialization codes on explicit connect; lazy
    // first-query failures can omit errorCode and must not be parsed as text.
    await db.$connect();
    return await work(db);
  } catch (error) {
    primary = annotateFailure(error, { phase, domain });
    throw primary;
  } finally {
    if (db) try { await db.$disconnect(); } catch (cleanup) {
      const failure = preservePrimaryFailure(primary, cleanup, { phase: "DATABASE_DISCONNECT", domain });
      if (!primary) throw failure;
    }
  }
}

async function preflight({ config = configuration() } = {}) {
  const results = [];
  for (const domain of ["dialogs", "crm"]) {
    results.push(await inDomain(config, domain, "CONVERSATION_PREFLIGHT", (db) => inspect(db, domain)));
  }
  return results;
}

async function main({ onDomainComplete } = {}) {
  let config;
  try { config = configuration(); }
  catch (error) { throw annotateFailure(error, { phase: "CONFIGURATION", domain: "conversation" }); }
  for (const domain of ["dialogs", "crm"]) {
    await inDomain(config, domain, "CONVERSATION_INSTALL", async (db) => {
      const result = await install(db, domain);
      onDomainComplete?.(domain);
      console.log(`${domain}: schema 1 ${result.fresh ? "installed" : "verified"}`);
    });
  }
}
if (require.main === module) main().catch((error) => { reportFailure(error); process.exitCode = 1; });
module.exports = { inspect, preflight, install, main };
