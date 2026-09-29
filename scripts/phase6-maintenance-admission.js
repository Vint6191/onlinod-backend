#!/usr/bin/env node
"use strict";
const prisma = require('../src/prisma');
const { readMaintenanceAdmissionProgress } = require('../src/services/phase2-maintenance-admission-service');
async function main() {
  if (process.argv[2] && process.argv[2] !== 'diagnostics') throw new Error('usage: npm run phase6:maintenance-admission -- [diagnostics]');
  const result = await readMaintenanceAdmissionProgress({ db: prisma });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(error?.code || error?.message || error); process.exitCode = 1; })
  .finally(async () => { try { await prisma.$disconnect(); } catch (_) {} });
