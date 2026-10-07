"use strict";
const { state } = require("./analytics-traffic-indexes");
const definitions = Object.freeze([
  { name: "FanObservationToken_expiry_id_idx", table: "FanObservationToken", expression: '"createdAt","id"', unique: false },
  { name: "OfProviderRequestGateWaiter_expiry_id_idx", table: "OfProviderRequestGateWaiter", expression: '"leaseUntil","waiterId"', unique: false },
  { name: "OfProviderRequestGateWaiter_bucket_ticket_idx", table: "OfProviderRequestGateWaiter", expression: '"priority","category","ticket"', unique: false },
  require("../../src/services/notification-identity-recovery-contract.json"),
].map(Object.freeze));
async function ensureIndexes(db, { create = false } = {}) {
  for (const spec of definitions) {
    let current = await state(db, spec);
    if (current.valid) continue;
    if (current.exists) throw new Error(`MAINTENANCE_INDEX_INVALID:${spec.name}`);
    if (!create) throw new Error(`MAINTENANCE_INDEX_REQUIRED:${spec.name}`);
    await db.$executeRawUnsafe(`CREATE INDEX CONCURRENTLY "${spec.name}" ON "${spec.table}" (${spec.expression})${spec.where ? " WHERE " + spec.where : ""}`);
    current = await state(db, spec);
    if (!current.valid) throw new Error(`MAINTENANCE_INDEX_BUILD_INVALID:${spec.name}`);
  }
  return { ready: true, contracts: definitions.length };
}
module.exports = { definitions, ensureIndexes };
if (require.main === module) {
  require("dotenv").config();
  const { PrismaClient } = require("@prisma/client");
  const url = new URL(process.env.DATABASE_URL); url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  (async () => {
    await db.$executeRawUnsafe("SET lock_timeout='5s'");
    await db.$executeRawUnsafe("SET statement_timeout='10min'");
    await db.$executeRawUnsafe("SELECT pg_advisory_lock(hashtextextended('background-maintenance-indexes-v1',0))");
    return ensureIndexes(db, { create: process.argv.includes("--create") });
  })().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
}
