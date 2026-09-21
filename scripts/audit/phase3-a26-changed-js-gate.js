#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Linter } = require("eslint");

const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_FILES = Object.freeze([
  "scripts/audit/phase3-a20-postgres-proof.js",
  "scripts/audit/phase3-a26-fixture-leak-snapshot.js",
  "scripts/audit/phase3-postgres-proof-fixture-authority.js",
  "scripts/database/phase3-subscriber-publication-schema-online-postflight.js",
  "src/services/job-result-service.js",
  "src/services/job-scheduler.js",
  "src/services/subscriber-directory-service.js",
  "src/services/subscriber-directory-maintenance-service.js",
  "src/services/subscriber-directory-maintenance-signal-service.js",
  "src/services/phase3-a20-proof-runtime-contract.test.js",
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

  const result = { ok: syntaxFailures.length === 0 && noUndefFailures.length === 0, files: files.length, syntaxFailures, noUndefFailures };
  console.log(`PHASE3_A26_CHANGED_JS_GATE ${JSON.stringify(result)}`);
  if (!result.ok) fail(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}

module.exports = { DEFAULT_FILES, main };
