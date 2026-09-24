"use strict";
const { ensureIndexes, createSql, assertIndexDefinition } = require("./phase4-execution-indexes-online-preflight");
const TABLES = ["CreatorSale", "CreatorTip", "CreatorSubscriptionEvent"];
const INDEXES = TABLES.flatMap(table => [
  [`${table}_consequence_job_cursor_idx`, table, '"agencyId","creatorId","sourceJobId","id"', null],
  [`${table}_history_repair_cursor_idx`, table, '"agencyId","creatorId","createdAt","id"', null],
]);
async function ensureNotificationIndexes(db) { return ensureIndexes(db, { indexes: INDEXES, lockKey: 2026092451 }); }
async function main() {
  const { PrismaClient } = require("@prisma/client");
  const url = new URL(process.env.DATABASE_URL); url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try { await ensureNotificationIndexes(db); console.log("# PHASE5_NOTIFICATION_HISTORY_INDEXES_PASS"); }
  finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { INDEXES, createSql, assertIndexDefinition, ensureNotificationIndexes };
