"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const mode = String(process.argv[2] || "source").toLowerCase();
const valid = new Set(["source", "pg", "scale", "all"]);
if (!valid.has(mode)) {
  console.error("usage: node scripts/audit/actual59-auth-lifecycle-gate.js [source|pg|scale|all]");
  process.exit(2);
}

function run(label, command, args, env = {}) {
  console.log(`\n# ACTUAL59_GATE ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`# ACTUAL59_GATE_FAIL ${label} exit=${result.status}`);
    process.exit(result.status || 1);
  }
  console.log(`# ACTUAL59_GATE_PASS ${label}`);
}

function requireDatabase(label) {
  if (!String(process.env.DATABASE_URL || "").trim()) {
    console.error(`# ACTUAL59_GATE_BLOCKED ${label}: DATABASE_URL is required`);
    process.exit(3);
  }
}

function sourceGate() {
  run("source-freeze-candidate", process.execPath, ["--test",
    "src/services/actual59-int59-4f-freeze-candidate.test.js",
    "src/services/actual59-int59-4c-auth-writer-matrix.test.js",
    "src/services/actual59-int59-4e-migration-activation.test.js",
    "src/services/actual59-int59-3-auth-lineage.test.js",
    "src/routes/actual59-int59-4d-auth-rolling-http.test.js",
    "src/middleware/auth-device-logout-v20-21.test.js",
    "src/services/actual59-team-authorization-generation-closure.test.js",
    "src/services/team-performance-authorization-generation-int2-6.test.js",
    "src/services/team-telemetry-provenance-v13.test.js",
  ]);
}

function pgGate() {
  requireDatabase("pg");
  if (process.env.ONLINOD_ACTUAL59_GATE_MIGRATE === "1") {
    run("prisma-migrate-deploy", process.platform === "win32" ? "npx.cmd" : "npx", ["prisma", "migrate", "deploy"]);
  }
  run("postgres-forced-interleavings", process.execPath, ["--test", "src/services/actual59-team-authorization-generation-postgres.integration.test.js"], {
    ONLINOD_POSTGRES_INTEGRATION: "1",
  });
}

function scaleGate() {
  requireDatabase("scale");
  run("postgres-telemetry-scale", process.execPath, ["--test", "src/services/actual59-int59-4f-telemetry-scale-postgres.integration.test.js"], {
    ONLINOD_ACTUAL59_SCALE_INTEGRATION: "1",
  });
}

if (mode === "source" || mode === "all") sourceGate();
if (mode === "pg" || mode === "all") pgGate();
if (mode === "scale" || mode === "all") scaleGate();
