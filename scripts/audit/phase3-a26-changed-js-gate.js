#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Linter } = require("eslint");
const { inspectRepository } = require("./phase3-prisma-source-contract");

const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_FILES = Object.freeze([
  "dedupe-deliveries.js",
  "purge-stuck-deliveries.js",
  "scripts/audit/phase3-a20-postgres-proof.js",
  "scripts/audit/phase3-a26-changed-js-gate.js",
  "scripts/audit/phase3-a26-render-disposable.js",
  "scripts/audit/phase3-a29-render-gate.js",
  "scripts/audit/phase3-postgres-identifier-lint.js",
  "scripts/audit/phase3-prisma-source-contract.js",
  "scripts/test-support/phase3-interleaved-transactions.js",
  "scripts/test-support/phase3-postgres-lock-wait.js",
  "scripts/maintenance/phase3-subscriber-maintenance-signals.js",
  "scripts/maintenance/dedupe-deliveries.js",
  "scripts/maintenance/purge-stuck-deliveries.js",
  "src/server.js",
  "src/routes/admin.js",
  "src/routes/admin-data.js",
  "src/services/bump-service.js",
  "src/services/audit17-shared-origin-isolation-closure.test.js",
  "src/services/automation-delivery-hard-delete-guard.js",
  "src/services/automation-history-service.js",
  "src/services/automation-history-service.test.js",
  "src/services/campaign-fan-refresh-queue-service.js",
  "src/services/creator-lifecycle-authority-service.js",
  "src/services/domain-work-authority-service.js",
  "src/services/execution-commit-authority-closure4.test.js",
  "src/services/follow-back-service.js",
  "src/services/follow-automation-service.js",
  "scripts/audit/phase3-a26-fixture-leak-snapshot.js",
  "scripts/audit/phase3-postgres-proof-fixture-authority.js",
  "scripts/test-support/phase2-postgres-integration-authority.js",
  "scripts/database/phase3-a29-maintenance-check-online-preflight.js",
  "scripts/database/phase3-domain-work-claim-online-rollout.js",
  "scripts/database/phase3-subscriber-publication-schema-online-postflight.js",
  "src/middleware/automation-permissions.js",
  "src/services/custom-content-submissions-service.js",
  "src/services/domain-work-authority-service.test.js",
  "src/services/job-result-service.js",
  "src/services/job-scheduler.js",
  "src/services/analytics-collection-planner.js",
  "src/services/analytics-recurring-planning-service.js",
  "src/services/analytics-recurring-planning-service.test.js",
  "src/services/analytics-demand-planning-service.test.js",
  "src/services/analytics-demand-planning-service.js",
  "src/services/job-planning-repository.js",
  "src/services/analytics-collection-planner.test.js",
  "src/services/job-scheduler-daily-cycle.test.js",
  "src/services/job-scheduler-idempotency.test.js",
  "src/services/job-scheduler-pagination.test.js",
  "src/services/likes-service.js",
  "src/services/phase2-work-coverage-authority-service.js",
  "src/services/notification-facts-schema.test.js",
  "src/services/fan-data-authority-service.js",
  "src/services/fan-data-authority-cutover.test.js",
  "src/services/fan-observation-clock-activation-service.js",
  "src/services/phase3-observation-clock-bridge-int5-7a-2.test.js",
  "src/services/phase3-postgres-proof-contract.test.js",
  "src/services/subscriber-directory-service.js",
  "src/services/subscriber-directory-maintenance-service.js",
  "src/services/subscriber-directory-maintenance-signal-service.js",
  "src/services/phase3-a20-proof-runtime-contract.test.js",
  "src/services/phase3-a31-physical-proof-subscriber-lease-authority.test.js",
  "src/services/phase3-a32-durable-derived-planning-proof-authority.test.js",
  "src/services/phase3-a33-scheduler-admin-end-to-end.test.js",
  "src/services/phase3-a34-source-scale-closure.integration.test.js",
  "src/services/phase3-a34-source-scale-closure.test.js",
  "src/services/phase3-automation-delivery-hard-delete-guard.test.js",
  "src/services/phase3-provider-capacity-postgres-int5-9a-15.integration.test.js",
  "src/services/phase2-actual53-domain-work-scale-generation.test.js",
  "src/services/phase2-actual54-root-a-g-closure.test.js",
  "src/services/phase2-actual55-root-e-closure.test.js",
  "src/services/phase2-actual56-final-closure-c1.test.js",
  "src/services/phase2-actual56-final-closure-c2-postgres.integration.test.js",
  "src/services/phase2-actual56-final-closure-m1.test.js",
  "src/services/phase2-actual56-final-closure-m1-postgres.integration.test.js",
  "src/services/phase2-actual56-final-closure-m1-team-activation-postgres.integration.test.js",
  "src/services/phase2-actual56-final-closure-pg-scale.integration.test.js",
  "src/services/phase2-destructive-delete-authority-service.js",
  "src/services/phase2-release-compatibility-authority-service.js",
  "src/services/phase3-analytics-final-authority-cutover.integration.test.js",
  "src/services/phase3-analytics-final-authority-cutover.test.js",
  "src/services/phase3-campaign-closure-a20-3.integration.test.js",
  "src/services/phase3-campaign-closure-a20-4.integration.test.js",
  "src/services/phase3-campaign-closure-a20-4.test.js",
  "src/services/phase3-campaign-closure-a20-5.integration.test.js",
  "src/services/phase3-campaign-closure-a20-11.test.js",
  "src/services/phase3-campaign-closure-a20-12.integration.test.js",
  "src/services/phase3-campaign-closure-a20-6.test.js",
  "src/services/phase3-campaign-closure-a20-7.test.js",
  "src/services/phase3-subscriber-maintenance-a26.test.js",
  "src/services/phase3-subscriber-publication-scale-final.test.js",
  "src/services/settings-service.js",
  "src/services/team-dialog-projection-authority-service.js",
  "src/services/team-money-reconciliation-service.js",
  "src/services/actual59-int59-4f-telemetry-scale-postgres.integration.test.js",
  "src/services/actual59-team-authorization-generation-postgres.integration.test.js",
]);

function fail(message) {
  const error = new Error(String(message));
  error.code = "PHASE3_A26_CHANGED_JS_GATE_FAILED";
  throw error;
}

function main() {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : [...DEFAULT_FILES];
  const missing = files.filter((file) => !fs.existsSync(path.join(ROOT, file)));
  if (missing.length) fail(`changed-JS gate missing files: ${missing.join(", ")}`);

  const syntaxFailures = [];
  const noUndefFailures = [];
  const linter = new Linter({ configType: "flat" });
  const lintConfig = [{
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        console: "readonly", process: "readonly", Buffer: "readonly",
        __dirname: "readonly", __filename: "readonly", module: "readonly",
        require: "readonly", exports: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly",
        setImmediate: "readonly", clearImmediate: "readonly",
        URL: "readonly", URLSearchParams: "readonly", AbortController: "readonly",
        TextEncoder: "readonly", TextDecoder: "readonly", structuredClone: "readonly",
      },
    },
    rules: { "no-undef": "error" },
  }];

  for (const file of files) {
    const absolute = path.join(ROOT, file);
    const syntax = spawnSync(process.execPath, ["--check", absolute], { cwd: ROOT, encoding: "utf8" });
    if (syntax.status !== 0) syntaxFailures.push({ file, output: `${syntax.stdout || ""}${syntax.stderr || ""}`.trim() });
    const text = fs.readFileSync(absolute, "utf8");
    const messages = linter.verify(text, lintConfig, { filename: absolute }).filter((row) => row.ruleId === "no-undef" && row.severity === 2);
    if (messages.length) noUndefFailures.push({ file, messages: messages.map((row) => ({ line: row.line, column: row.column, message: row.message })) });
  }

  const prismaContracts = inspectRepository(ROOT);
  const result = { ok: syntaxFailures.length === 0 && noUndefFailures.length === 0 && prismaContracts.ok, files: files.length, syntaxFailures, noUndefFailures, prismaContracts };
  console.log(`PHASE3_A26_CHANGED_JS_GATE ${JSON.stringify(result)}`);
  if (!result.ok) fail(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}

module.exports = { DEFAULT_FILES, main };
