#!/usr/bin/env node
"use strict";

const prisma = require("../../src/prisma");
const {
  TEAM_CONTROL_PLANE_GENERATION,
  TEAM_CONTROL_PLANE_SCOPE,
  teamControlPlaneActivationDiagnostics,
  activateTeamControlPlaneAfterDrain,
} = require("../../src/services/phase2-release-compatibility-authority-service");

async function main() {
  const before = await teamControlPlaneActivationDiagnostics(prisma);
  const stateBefore = String(before?.row?.activationState || "").toUpperCase();
  if (!before?.dbFence?.ready) {
    throw Object.assign(new Error("A20 temporary runtime has an incomplete Team control-plane DB fence"), {
      code: "A20_TEAM_CONTROL_PLANE_DB_FENCE_INCOMPLETE",
      details: before?.dbFence || null,
    });
  }
  if (before?.row?.requiredGeneration !== TEAM_CONTROL_PLANE_GENERATION) {
    throw Object.assign(new Error("A20 temporary runtime has an unexpected Team control-plane generation"), {
      code: "A20_TEAM_CONTROL_PLANE_GENERATION_MISMATCH",
      details: before?.row || null,
    });
  }
  if (stateBefore === "DRAINING") await activateTeamControlPlaneAfterDrain(prisma);
  else if (stateBefore !== "ACTIVE") {
    throw Object.assign(new Error(`A20 temporary runtime has unsupported Team control-plane state ${stateBefore || "MISSING"}`), {
      code: "A20_TEAM_CONTROL_PLANE_STATE_UNSUPPORTED",
      details: before?.row || null,
    });
  }

  const after = await teamControlPlaneActivationDiagnostics(prisma);
  const stateAfter = String(after?.row?.activationState || "").toUpperCase();
  if (after?.row?.requiredGeneration !== TEAM_CONTROL_PLANE_GENERATION || stateAfter !== "ACTIVE" || !after?.dbFence?.ready) {
    throw Object.assign(new Error("A20 temporary runtime failed Team control-plane operationalization"), {
      code: "A20_TEAM_CONTROL_PLANE_OPERATIONALIZATION_FAILED",
      details: after,
    });
  }
  console.log(`# A20_RUNTIME_OPERATIONALIZATION_PASS ${JSON.stringify({
    scope: TEAM_CONTROL_PLANE_SCOPE,
    generation: TEAM_CONTROL_PLANE_GENERATION,
    stateBefore,
    stateAfter,
    blockerAgencyCount: Array.isArray(after.blockerAgencyIds) ? after.blockerAgencyIds.length : null,
  })}`);
}

main()
  .catch((error) => {
    console.error(`# A20_RUNTIME_OPERATIONALIZATION_FAIL ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch (_) {}
  });
