#!/usr/bin/env node
"use strict";

const { PrismaClient } = require("@prisma/client");

async function main({ db = new PrismaClient(), ownsDb = true } = {}) {
  try {
    const present = await db.$queryRawUnsafe(`
      SELECT to_regclass(format('%I.%I', current_schema(), 'SubscriberDirectoryMaintenanceSignal')) IS NOT NULL AS present
    `);
    if (!present?.[0]?.present) {
      const result = { ok: true, present: false, repaired: 0, reason: "table_not_present" };
      console.log(`# PHASE3_A29_MAINTENANCE_CHECK_PREFLIGHT ${JSON.stringify(result)}`);
      return result;
    }

    const repaired = await db.$executeRawUnsafe(`
      UPDATE "SubscriberDirectoryMaintenanceSignal"
      SET "kind" = CASE WHEN "kind" IN ('RECOVERY','RETENTION') THEN "kind" ELSE 'RECOVERY' END,
          "reason" = CASE WHEN "kind" IN ('RECOVERY','RETENTION') THEN "reason" ELSE 'A31_PREFLIGHT_KIND_REPAIR' END,
          "dueAt" = CASE WHEN "kind" IN ('RECOVERY','RETENTION') THEN "dueAt" ELSE LEAST("dueAt", clock_timestamp()) END,
          "revision" = GREATEST(COALESCE("revision", 0), 1),
          "attempts" = GREATEST(COALESCE("attempts", 0), 0),
          "claimToken" = CASE
            WHEN "kind" IN ('RECOVERY','RETENTION') AND COALESCE("revision",0) > 0 AND COALESCE("attempts",0) >= 0 THEN "claimToken"
            ELSE NULL
          END,
          "claimUntil" = CASE
            WHEN "kind" IN ('RECOVERY','RETENTION') AND COALESCE("revision",0) > 0 AND COALESCE("attempts",0) >= 0 THEN "claimUntil"
            ELSE NULL
          END,
          "updatedAt" = clock_timestamp()
      WHERE "kind" NOT IN ('RECOVERY','RETENTION')
         OR COALESCE("revision",0) <= 0
         OR COALESCE("attempts",0) < 0
    `);
    const result = { ok: true, present: true, repaired: Number(repaired || 0) };
    console.log(`# PHASE3_A29_MAINTENANCE_CHECK_PREFLIGHT ${JSON.stringify(result)}`);
    return result;
  } finally {
    if (ownsDb) await db.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`# PHASE3_A29_MAINTENANCE_CHECK_PREFLIGHT_FAIL ${JSON.stringify({ code: error?.code || null, message: String(error?.message || error).slice(0, 1000) })}`);
    process.exitCode = 3;
  });
}

module.exports = { main };
