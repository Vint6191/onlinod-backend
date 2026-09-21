#!/usr/bin/env node
"use strict";

const prisma = require("../../src/prisma");
const {
  listPoisonedSubscriberMaintenanceSignals,
  requeuePoisonedSubscriberMaintenanceSignal,
} = require("../../src/services/subscriber-directory-maintenance-signal-service");

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => String(value).startsWith(prefix));
  return found ? String(found).slice(prefix.length) : null;
}

async function main() {
  const action = String(process.argv[2] || "list").replace(/^--?/, "").toLowerCase();
  if (action === "list") {
    const rows = await listPoisonedSubscriberMaintenanceSignals({ db: prisma, limit: Number(arg("limit") || 100) });
    console.log(`PHASE3_SUBSCRIBER_MAINTENANCE_POISON_LIST ${JSON.stringify({ count: rows.length, rows: rows.map((row) => ({
      id: row.id, agencyId: row.agencyId, creatorId: row.creatorId, kind: row.kind,
      attempts: row.attempts, dueAt: row.dueAt, lastError: row.lastError,
    })) })}`);
    return;
  }
  if (action === "requeue") {
    const signalId = arg("id");
    if (!signalId) throw new Error("requeue requires --id=<signalId>");
    const result = await requeuePoisonedSubscriberMaintenanceSignal({ db: prisma, signalId, reason: "OPERATOR_REQUEUE" });
    console.log(`PHASE3_SUBSCRIBER_MAINTENANCE_POISON_REQUEUE ${JSON.stringify(result)}`);
    if (!result.requeued) process.exitCode = 2;
    return;
  }
  throw new Error(`Unsupported action ${action}; use list or requeue --id=<signalId>`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect().catch(() => null));
}

module.exports = { main };
