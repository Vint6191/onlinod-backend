"use strict";

const prisma = require("../../src/prisma");
const {
  TEAM_CONTROL_PLANE_GENERATION,
  TEAM_CONTROL_PLANE_SCOPE,
  readTeamControlPlaneReleaseAuthority,
  activateTeamControlPlaneAfterDrain,
} = require("../../src/services/phase2-release-compatibility-authority-service");

function has(flag) {
  return process.argv.slice(2).includes(flag);
}

async function main() {
  const activate = has("--activate");
  const confirm = has("--confirm-old-binary-drained");

  if (!activate) {
    const row = await readTeamControlPlaneReleaseAuthority(prisma);
    console.log(JSON.stringify({
      scope: TEAM_CONTROL_PLANE_SCOPE,
      expectedGeneration: TEAM_CONTROL_PLANE_GENERATION,
      authority: row,
      activationCommand: "npm run phase2:team-control-plane -- --activate --confirm-old-binary-drained",
    }, null, 2));
    return;
  }

  if (!confirm) {
    const error = new Error(
      "Refusing activation: first drain every incompatible old backend binary, then rerun with --confirm-old-binary-drained",
    );
    error.code = "TEAM_CONTROL_PLANE_DRAIN_CONFIRMATION_REQUIRED";
    throw error;
  }

  const result = await activateTeamControlPlaneAfterDrain(prisma, { confirmOldBinaryDrained: true });
  console.log(JSON.stringify({
    ok: true,
    scope: TEAM_CONTROL_PLANE_SCOPE,
    expectedGeneration: TEAM_CONTROL_PLANE_GENERATION,
    ...result,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      code: error?.code || "TEAM_CONTROL_PLANE_ACTIVATION_FAILED",
      error: error?.message || String(error),
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch {}
  });
