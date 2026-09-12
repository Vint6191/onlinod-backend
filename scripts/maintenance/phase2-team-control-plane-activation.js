"use strict";

const prisma = require("../../src/prisma");
const {
  TEAM_CONTROL_PLANE_GENERATION,
  TEAM_CONTROL_PLANE_SCOPE,
  preflightTeamControlPlaneMigration,
  teamControlPlaneActivationDiagnostics,
  activateTeamControlPlaneAfterDrain,
} = require("../../src/services/phase2-release-compatibility-authority-service");

function has(flag) {
  return process.argv.slice(2).includes(flag);
}

function value(flag) {
  const args = process.argv.slice(2);
  const exact = args.find((arg) => arg.startsWith(`${flag}=`));
  if (exact) return exact.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

async function printDiagnostics(extra = {}) {
  const diagnostics = await teamControlPlaneActivationDiagnostics(prisma);
  console.log(JSON.stringify({
    scope: TEAM_CONTROL_PLANE_SCOPE,
    expectedGeneration: TEAM_CONTROL_PLANE_GENERATION,
    ...diagnostics,
    commands: {
      inspect: "npm run phase2:team-control-plane",
      preflightMigration: "npm run phase2:team-control-plane -- --preflight-migration",
      activate: "npm run phase2:team-control-plane -- --activate",
    },
    ...extra,
  }, null, 2));
}

async function main() {
  const activate = has("--activate");
  const preflightMigration = has("--preflight-migration");

  if ([activate, preflightMigration].filter(Boolean).length > 1) {
    const error = new Error("Choose exactly one maintenance action: --preflight-migration or --activate");
    error.code = "TEAM_CONTROL_PLANE_COMMAND_CONFLICT";
    throw error;
  }

  if (preflightMigration) {
    const result = await preflightTeamControlPlaneMigration(prisma);
    console.log(JSON.stringify({
      ok: true,
      action: "preflight-migration",
      scope: TEAM_CONTROL_PLANE_SCOPE,
      expectedGeneration: TEAM_CONTROL_PLANE_GENERATION,
      ...result,
    }, null, 2));
    return;
  }


  if (activate) {
    const result = await activateTeamControlPlaneAfterDrain(prisma);
    await printDiagnostics({ ok: true, activation: result });
    return;
  }

  await printDiagnostics();
}

main()
  .catch(async (error) => {
    let diagnostics = null;
    try { diagnostics = await teamControlPlaneActivationDiagnostics(prisma); } catch {}
    console.error(JSON.stringify({
      ok: false,
      code: error?.code || "TEAM_CONTROL_PLANE_MAINTENANCE_FAILED",
      error: error?.message || String(error),
      details: error?.details || null,
      diagnostics,
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch {}
  });
