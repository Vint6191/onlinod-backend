#!/usr/bin/env node
"use strict";

const prisma = require("../src/prisma");
const {
  refreshProviderCapacityDebtSnapshot,
  readProviderCapacityDebtSnapshot,
} = require("../src/services/provider-capacity-debt-authority-service");
const { providerScaleContract } = require("../src/services/provider-capacity-sla-service");

async function main() {
  const command = String(process.argv[2] || "diagnostics").trim().toLowerCase();
  if (!new Set(["diagnostics", "refresh"]).has(command)) {
    throw new Error("usage: npm run phase3:provider-capacity -- [diagnostics|refresh]");
  }
  if (command === "refresh") {
    const result = await refreshProviderCapacityDebtSnapshot({ db: prisma });
    console.log(JSON.stringify({ command, ok: result.ok === true, skipped: result.skipped === true, reason: result.reason || null, processed: result.processed, scanned: result.scanned, projectionComplete: result.projectionComplete, snapshot: result.snapshot || result.computed || null, scaleContract: providerScaleContract() }, (_key, value) => typeof value === "bigint" ? String(value) : value, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  const snapshot = await readProviderCapacityDebtSnapshot({ db: prisma });
  console.log(JSON.stringify({ command, snapshot, scaleContract: providerScaleContract() }, (_key, value) => typeof value === "bigint" ? String(value) : value, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}).finally(async () => {
  try { await prisma.$disconnect(); } catch (_) {}
});
