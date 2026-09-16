"use strict";

const prisma = require("../../src/prisma");
const {
  AUTH_HISTORY_PURGE_SCOPE,
  AUTH_HISTORY_PUBLISHER_GENERATION,
  authorizationHistoryActivationDiagnostics,
  activateAuthorizationHistoryPurgeAfterDrain,
} = require("../../src/services/actual60-authorization-history-rollout-service");

function has(flag) { return process.argv.slice(2).includes(flag); }

async function printDiagnostics(extra = {}) {
  const diagnostics = await authorizationHistoryActivationDiagnostics(prisma);
  console.log(JSON.stringify({
    scope: AUTH_HISTORY_PURGE_SCOPE,
    expectedGeneration: AUTH_HISTORY_PUBLISHER_GENERATION,
    ...diagnostics,
    rolloutContract: [
      "deploy migration in DRAINING",
      "deploy tombstone-aware publisher binaries to every backend replica",
      "confirm old publisher replicas are drained",
      "run this command with --activate",
      "ACTIVE DB trigger fences any old publisher that still attempts lineaged publication",
      "only ACTIVE enables raw RefreshSession retention purge",
    ],
    commands: {
      inspect: "npm run maintenance:auth-history-purge",
      activate: "npm run maintenance:auth-history-purge -- --activate",
    },
    ...extra,
  }, null, 2));
}

async function main() {
  if (has("--activate")) {
    const activation = await activateAuthorizationHistoryPurgeAfterDrain(prisma);
    await printDiagnostics({ ok: true, activation });
    return;
  }
  await printDiagnostics({ ok: true });
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, code: error?.code || "AUTH_HISTORY_PURGE_ACTIVATION_FAILED", error: error?.message || String(error), details: error?.details || null }, null, 2));
  process.exitCode = 1;
}).finally(async () => { try { await prisma.$disconnect(); } catch {} });
