#!/usr/bin/env node
"use strict";

const prisma = require("../../src/prisma");

const TABLES = Object.freeze([
  "User",
  "WorkerDevice",
  "AgencyMember",
  "DeviceCreatorBinding",
  "Agency",
  "CreatorAccount",
  "JobInstance",
  "SubscriberScanRun",
  "SubscriberScanItem",
  "SubscriberDirectoryState",
  "SubscriberDirectoryMaintenanceSignal",
  "CreatorCampaign",
  "CreatorFan",
  "CreatorFanValueCurrent",
  "CreatorFanRefreshDemand",
  "CreatorCampaignFanRefreshWork",
  "CampaignFanRefreshPromotionSignal",
  "CreatorCampaignCollectionState",
]);

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT current_schema() AS "schema", current_setting('search_path') AS "searchPath"
  `);
  const schema = String(rows?.[0]?.schema || "");
  if (!schema || schema === "public") throw new Error(`A26 leak snapshot requires isolated non-public schema, got ${schema || "<none>"}`);
  const counts = {};
  const identities = {};
  for (const table of TABLES) {
    const exists = await prisma.$queryRawUnsafe(`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_name=$1 AND table_type='BASE TABLE'
      ) AS "present"
    `, table);
    if (!exists?.[0]?.present) continue;
    const snapshot = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::bigint AS "count",
             md5(COALESCE(string_agg("id", ',' ORDER BY "id"), '')) AS "identityDigest"
      FROM "${table}"
    `);
    counts[table] = Number(snapshot?.[0]?.count || 0);
    identities[table] = String(snapshot?.[0]?.identityDigest || "");
  }
  console.log(`A26_FIXTURE_LEAK_SNAPSHOT ${JSON.stringify({ schema, searchPath: rows?.[0]?.searchPath || null, counts, identities })}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect().catch(() => null); });
}
