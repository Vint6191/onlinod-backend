"use strict";

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const rows = await db.$queryRawUnsafe(`
      SELECT
        current_database() AS "database",
        current_schema() AS "schema",
        current_setting('server_version') AS "serverVersion",
        current_setting('server_version_num') AS "serverVersionNum",
        current_setting('default_transaction_isolation') AS "defaultTransactionIsolation"
    `);
    const row = Array.isArray(rows) ? rows[0] || null : null;
    if (!row) throw new Error("PostgreSQL fingerprint query returned no row");
    const safe = {
      database: String(row.database || ""),
      schema: String(row.schema || ""),
      serverVersion: String(row.serverVersion || ""),
      serverVersionNum: String(row.serverVersionNum || ""),
      defaultTransactionIsolation: String(row.defaultTransactionIsolation || ""),
    };
    console.log(`# ACTUAL60_POSTGRES_FINGERPRINT_JSON ${JSON.stringify(safe)}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(`# ACTUAL60_POSTGRES_FINGERPRINT_FAIL ${error?.stack || error?.message || error}`);
  process.exit(1);
});
