"use strict";
const { state } = require("./analytics-traffic-indexes");
const { CURRENT_PREDICATE } = require("../../src/services/mass-delivery-contract");
const definitions = [{ name: "AutomationDelivery_mass_current_v2_idx", table: "AutomationDelivery", expression: '"agencyId","creatorId","id"', unique: false, where: CURRENT_PREDICATE }];
async function ensureIndexes(db, { create = false } = {}) {
  for (const spec of definitions) {
    let current = await state(db, spec);
    if (current.valid) continue;
    if (current.exists) throw new Error(`EXTERNAL_DELIVERY_INDEX_INVALID:${spec.name}`);
    if (!create) throw new Error(`EXTERNAL_DELIVERY_INDEX_REQUIRED:${spec.name}`);
    await db.$executeRawUnsafe(`CREATE INDEX CONCURRENTLY "${spec.name}" ON "${spec.table}" (${spec.expression}) WHERE ${spec.where}`);
    current = await state(db, spec);
    if (!current.valid) throw new Error(`EXTERNAL_DELIVERY_INDEX_BUILD_INVALID:${spec.name}`);
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
    await db.$executeRawUnsafe("SELECT pg_advisory_lock(hashtextextended('external-delivery-indexes-v2',0))");
    return ensureIndexes(db, { create: process.argv.includes("--create") });
  })().then(result => console.log(JSON.stringify(result))).catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
}
