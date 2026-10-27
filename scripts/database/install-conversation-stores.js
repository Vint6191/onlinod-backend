"use strict";
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { configuration } = require("../../src/services/conversation-storage/databases");
const { PrismaClient } = require("@prisma/client");
async function install(db, domain) {
  const source = readFileSync(
    join(__dirname, "../../src/services/conversation-storage/sql", `${domain}-v1.sql`),
    "utf8"
  );
  const digest = createHash("sha256").update(source).digest("hex");
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(180001)");
      await tx.$executeRawUnsafe(
        "CREATE TABLE IF NOT EXISTS conversation_schema_version (domain text PRIMARY KEY, version integer NOT NULL, checksum text NOT NULL)"
      );
      const other = await tx.$queryRawUnsafe("SELECT domain FROM conversation_schema_version WHERE domain<>$1", domain);
      if (other.length) throw new Error("CONVERSATION_DATABASES_MUST_BE_SEPARATE");
      const existing = await tx.$queryRawUnsafe("SELECT * FROM conversation_schema_version WHERE domain=$1", domain);
      if (existing.length) {
        if (existing[0].version !== 1 || existing[0].checksum !== digest)
          throw new Error("CONVERSATION_MIGRATION_CHECKSUM_MISMATCH");
        return;
      }
      const tables = await tx.$queryRawUnsafe(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'conversation_schema_version' LIMIT 1"
      );
      if (tables.length) throw new Error("EMPTY_CONVERSATION_DATABASE_REQUIRED");
      for (const statement of source
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe(
        "INSERT INTO conversation_schema_version(domain,version,checksum) VALUES($1,1,$2)",
        domain,
        digest
      );
    },
    { timeout: 60000, maxWait: 10000 }
  );
}
async function main() {
  const config = configuration();
  for (const domain of ["dialogs", "crm"]) {
    const db = new PrismaClient({ datasources: { db: { url: config[domain] } } });
    try {
      await install(db, domain);
      console.log(`${domain}: schema 1 installed`);
    } finally {
      await db.$disconnect();
    }
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
  });
module.exports = { install, main };
