"use strict";

const prisma = require("../src/prisma");
const {
  providerGateFairnessActivationDiagnostics,
  beginProviderGateFairnessDrain,
  activateProviderGateFairnessAfterDrain,
} = require("../src/services/provider-request-credit-authority-service");

function commandFromArgv(argv = process.argv.slice(2)) {
  const value = String(argv[0] || "diagnostics").trim().toLowerCase();
  if (["diagnostics", "status", "show"].includes(value)) return "diagnostics";
  if (["begin-drain", "drain", "quiesce"].includes(value)) return "begin-drain";
  if (["activate", "commit"].includes(value)) return "activate";
  const error = new Error(`Unknown provider-gate fairness command: ${value}`);
  error.code = "OF_PROVIDER_GATE_FAIRNESS_COMMAND_INVALID";
  throw error;
}

function jsonValue(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

async function main() {
  const command = commandFromArgv();
  let result;
  if (command === "begin-drain") {
    result = await beginProviderGateFairnessDrain(prisma);
  } else if (command === "activate") {
    result = await activateProviderGateFairnessAfterDrain(prisma);
  } else {
    result = await providerGateFairnessActivationDiagnostics(prisma);
  }
  console.log(jsonValue({ ok: true, command, result }));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(jsonValue({
        ok: false,
        code: error?.code || null,
        message: error?.message || String(error),
        retryable: error?.retryable === true,
        quietMs: Number.isFinite(Number(error?.quietMs)) ? Number(error.quietMs) : null,
        liveCount: Number.isFinite(Number(error?.liveCount)) ? Number(error.liveCount) : null,
      }));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}

module.exports = { commandFromArgv };
