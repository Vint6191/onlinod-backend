#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const PRISMA_DIR = path.join(ROOT, "prisma");
const A13_CUTOFF = "20260919010000_phase3_provider_gate_durable_waiter_fairness_v1";
const PRE_A20_2_CUTOFF = "20260919113000_phase3_campaign_refresh_recovery_status_v1";
const EXPECTED_PROOF_TEST_COUNT = 44;
const COVERAGE_PREFLIGHT = path.join(ROOT, "scripts/database/phase3-campaign-coverage-generation-online-preflight.js");
const PREFLIGHT_CONCURRENCY_PROOF = path.join(ROOT, "scripts/audit/phase3-a20-preflight-concurrency.js");
const PREFLIGHT_RUNTIME_AVAILABILITY_PROOF = path.join(ROOT, "scripts/audit/phase3-a20-preflight-runtime-availability.js");
const INDEX_LIFECYCLE_CONCURRENCY_PROOF = path.join(ROOT, "scripts/audit/phase3-a20-index-lifecycle-concurrency.js");
const OPERATIONALIZE_RUNTIME = path.join(ROOT, "scripts/audit/phase3-a20-operationalize-runtime.js");
const SCHEMA_ISOLATION_PROOF = path.join(ROOT, "scripts/audit/phase3-a20-schema-isolation.js");
const SUBSCRIBER_POSTFLIGHT = path.join(ROOT, "scripts/database/phase3-subscriber-publication-schema-online-postflight.js");
const LEAK_SNAPSHOT = path.join(ROOT, "scripts/audit/phase3-a26-fixture-leak-snapshot.js");
const STEP_LOG_DIR = path.join(ROOT, "artifacts", "audit", "phase3-a20-steps");
const PROOF_TESTS = [
  path.join(ROOT, "src/services/phase3-provider-capacity-postgres-int5-9a-15.integration.test.js"),
  path.join(ROOT, "src/services/phase3-provider-topology-postgres-int5-9a-16.integration.test.js"),
  path.join(ROOT, "src/services/phase3-provider-actual-category-postgres-int5-9a-17.integration.test.js"),
  path.join(ROOT, "src/services/phase3-provider-future-debt-postgres-int5-9a-18.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a19.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a20-3.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a20-4.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a20-5.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a20-11.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a20-12.integration.test.js"),
  path.join(ROOT, "src/services/phase3-analytics-final-authority-cutover.integration.test.js"),
  path.join(ROOT, "src/services/phase3-a20-operational-runtime.integration.test.js"),
];

function fail(message, code = 3) {
  const error = new Error(String(message));
  error.exitCode = Number.isInteger(Number(code)) ? Number(code) : 3;
  throw error;
}
function normalizedDbIdentity(value) {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.hostname.toLowerCase()}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
  } catch (_) { return null; }
}
function auditUrl() {
  const audit = String(process.env.ONLINOD_AUDIT_DATABASE_URL || "").trim();
  const primary = String(process.env.DATABASE_URL || "").trim();
  if (!audit) fail("ONLINOD_AUDIT_DATABASE_URL is required; refusing to mutate the primary database implicitly");
  if (primary && normalizedDbIdentity(primary) === normalizedDbIdentity(audit)) {
    fail("ONLINOD_AUDIT_DATABASE_URL resolves to the primary physical database; A26 requires a disposable physical PostgreSQL database and has no production opt-in bypass");
  }
  return audit;
}
function localPrismaCli() {
  const bin = process.platform === "win32" ? "prisma.cmd" : "prisma";
  const file = path.join(ROOT, "node_modules", ".bin", bin);
  if (!fs.existsSync(file)) fail("local Prisma CLI is unavailable; run npm install in the Backend proof environment");
  return file;
}
function withSchema(url, schema) {
  const u = new URL(url);
  const safeSchema = String(schema || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(safeSchema)) fail(`invalid audit schema identifier: ${safeSchema || "<empty>"}`);
  u.searchParams.set("schema", safeSchema);
  // `schema=` is Prisma routing metadata. PostgreSQL trigger functions and raw SQL
  // resolve unqualified relations through the server-side search_path, so pin it
  // independently as well. The audit schema MUST be first to prevent public-schema
  // bleed when the physical proof runs inside the production database.
  const existingOptions = String(u.searchParams.get("options") || "").trim();
  const searchPathOption = `-c search_path=${safeSchema},pg_catalog`;
  u.searchParams.set("options", existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption);
  return u.toString();
}
function safeStepName(label) {
  return String(label || "step").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);
}
function persistStepLog(label, stdout, stderr) {
  fs.mkdirSync(STEP_LOG_DIR, { recursive: true });
  const file = path.join(STEP_LOG_DIR, `${safeStepName(label)}.log`);
  const body = `${stdout || ""}${stderr ? `\n--- STDERR ---\n${stderr}` : ""}`;
  fs.writeFileSync(file, body, "utf8");
  return { file, sha256: crypto.createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) };
}
function failureDigest(stdout, stderr, limit = 180) {
  const lines = `${stdout || ""}\n${stderr || ""}`.split(/\r?\n/);
  const keep = [];
  const interesting = /(not ok|FAIL|AssertionError|ConnectorError|PrismaClient|Error:|error:|expected:|actual:|location:|PHASE[0-9A-Z_:-]+.*(?:FAIL|ERROR))/i;
  for (let i = 0; i < lines.length; i += 1) {
    if (!interesting.test(lines[i])) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 8); j += 1) keep.push(lines[j]);
  }
  const deduped = [];
  for (const line of keep) if (!deduped.length || deduped[deduped.length - 1] !== line) deduped.push(line);
  if (deduped.length <= limit) return deduped.join("\n");
  const head = deduped.slice(0, Math.floor(limit / 2));
  const tail = deduped.slice(-Math.ceil(limit / 2));
  return [...head, `... ${deduped.length - head.length - tail.length} relevant lines omitted; full step log persisted ...`, ...tail].join("\n");
}
function run(label, command, args, env, input = undefined, { allowFailure = false } = {}) {
  const startedAt = process.hrtime.bigint();
  const out = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const stdout = out.stdout || "";
  const stderr = out.stderr || "";
  const log = persistStepLog(label, stdout, stderr);
  const status = out.error ? null : out.status;
  const failed = Boolean(out.error || out.status !== 0);
  const digest = failed ? failureDigest(stdout, stderr, 60) : "";
  console.log(`# PHASE3_A20_POSTGRES_STEP ${JSON.stringify({ label, durationMs: Math.round(durationMs * 100) / 100, status, logSha256: log.sha256, logBytes: log.bytes })}`);
  if (failed) {
    if (digest) console.error(`# PHASE3_A20_POSTGRES_STEP_FAILURE_DIGEST ${label}\n${digest}`);
    console.error(`# PHASE3_A20_POSTGRES_STEP_LOG ${JSON.stringify(log)}`);
    if (!allowFailure) fail(`${label} failed (${out.error?.message || `exit ${out.status}`})`, out.status || 4);
  }
  return { durationMs, stdout, stderr, log, status, failed, digest, error: out.error?.message || null };
}
function tapCount(stdout, label) {
  const match = String(stdout || "").match(new RegExp(`^# ${label} (\\d+)$`, "m"));
  return match ? Number(match[1]) : null;
}
function parseJsonLines(stdout, marker) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const raw = line.slice(index + marker.length).trim();
    try { rows.push(JSON.parse(raw)); } catch (error) { fail(`invalid ${marker} JSON: ${error.message}`); }
  }
  return rows;
}
function assertScaleMetrics(stdout, label) {
  const healingRows = parseJsonLines(stdout, "A20_4_POSTGRES_HEALING_SCALE");
  if (healingRows.length !== 1 || !Array.isArray(healingRows[0])) fail(`${label} missing A20.4 healing scale metrics`);
  const healing = healingRows[0];
  for (const count of [1, 20, 500]) {
    const row = healing.find((item) => Number(item?.count) === count);
    if (!row || Number(row.businessQueryRaw) !== 1 || Number(row.businessExecuteRaw) !== 0
        || Number(row.syncExecuteRaw) !== 1 || !Number.isFinite(Number(row.durationMs))) {
      fail(`${label} invalid A20.4 healing metric for ${count}`);
    }
  }
  const terminal = parseJsonLines(stdout, "A20_5_POSTGRES_TERMINAL_SCALE_POINT");
  if (terminal.length !== 3) fail(`${label} expected 3 A20.5 terminal timing points, got ${terminal.length}`);
  for (const count of [1, 20, 50]) {
    const row = terminal.find((item) => Number(item?.count) === count);
    if (!row || Number(row.businessQueryRaw) !== 2 || Number(row.businessExecuteRaw) !== 0
        || Number(row.syncQueryRaw) !== 2 || Number(row.syncExecuteRaw) !== 1
        || !Number.isFinite(Number(row.durationMs))) {
      fail(`${label} invalid A20.5 terminal metric for ${count}`);
    }
  }
  const chunkPostProjection = parseJsonLines(stdout, "A20_7_POSTGRES_CHUNK_POST_PROJECTION");
  if (chunkPostProjection.length !== 1) fail(`${label} expected one A20.7 chunk post-projection metric, got ${chunkPostProjection.length}`);
  const chunk = chunkPostProjection[0];
  if (Number(chunk?.count) !== 50 || Number(chunk?.businessQueryRaw) !== 0 || Number(chunk?.businessExecuteRaw) !== 0
      || Number(chunk?.syncQueryRaw) !== 0 || Number(chunk?.syncExecuteRaw) !== 1
      || !Number.isFinite(Number(chunk?.durationMs))) {
    fail(`${label} invalid A20.7 chunk post-projection metric`);
  }
  return { healing, terminal, chunkPostProjection: chunk };
}
function assertNodeProof(stdout, label, summaryOverride = null) {
  const summary = summaryOverride || {
    tests: tapCount(stdout, "tests"),
    pass: tapCount(stdout, "pass"),
    fail: tapCount(stdout, "fail"),
    skipped: tapCount(stdout, "skipped"),
  };
  if (summary.tests !== EXPECTED_PROOF_TEST_COUNT) fail(`${label} test-count drift: expected ${EXPECTED_PROOF_TEST_COUNT}, got ${summary.tests}`);
  if (summary.pass !== EXPECTED_PROOF_TEST_COUNT || summary.fail !== 0 || summary.skipped !== 0) {
    fail(`${label} is not zero-fail/zero-skip: ${JSON.stringify(summary)}`);
  }
  const metrics = assertScaleMetrics(stdout, label);
  const hotPlans = parseJsonLines(stdout, "FINAL_HOT_QUERY_PLAN_PROOF");
  if (hotPlans.length !== 1) fail(`${label} expected one FINAL_HOT_QUERY_PLAN_PROOF marker, got ${hotPlans.length}`);
  const hotPlan = hotPlans[0];
  const requiredIndexes = [
    "CreatorFanRefreshDemand_promoter_ready_idx",
    "CreatorFanRefreshDemand_recovery_order_idx",
    "CreatorFanRefreshDemand_canonical_heal_idx",
    "CampaignFanRefreshPromotionSignal_claim_due_idx",
    "SubscriberDirectoryMaintenanceSignal_due_claim_idx",
  ];
  const hotStats = hotPlan?.stats || {};
  const boundedHotStats = ["promoter", "recovery", "heal", "campaignSignal", "subscriberSignal"].every((key) => {
    const row = hotStats[key];
    return Number.isFinite(Number(row?.executionMs)) && Number(row.executionMs) >= 0 && Number(row.executionMs) <= 500
      && Number.isFinite(Number(row?.blocks)) && Number(row.blocks) >= 0 && Number(row.blocks) <= 30000;
  });
  if (Number(hotPlan?.targetDebtRows) !== 400
      || Number(hotPlan?.sameAgencyNoiseCreators) !== 999
      || Number(hotPlan?.crossAgencyNoiseCreators) !== 199
      || hotPlan?.indexEligibility !== true || !boundedHotStats) {
    fail(`${label} invalid FINAL_HOT_QUERY_PLAN_PROOF: ${JSON.stringify(hotPlan)}`);
  }
  const subscriberReconcilePlans = parseJsonLines(stdout, "FINAL_SUBSCRIBER_RECONCILE_PLAN_PROOF");
  if (subscriberReconcilePlans.length !== 1) fail(`${label} expected one FINAL_SUBSCRIBER_RECONCILE_PLAN_PROOF marker, got ${subscriberReconcilePlans.length}`);
  const subscriberReconcilePlan = subscriberReconcilePlans[0] || null;
  if (Number(subscriberReconcilePlan?.historyRows) !== 4000 || Number(subscriberReconcilePlan?.debtRows) !== 200
      || !Number.isFinite(Number(subscriberReconcilePlan?.executionMs)) || Number(subscriberReconcilePlan.executionMs) > 500
      || !Number.isFinite(Number(subscriberReconcilePlan?.blocks)) || Number(subscriberReconcilePlan.blocks) > 30000
      || Number(subscriberReconcilePlan?.deletedRuns) <= 0 || Number(subscriberReconcilePlan.deletedRuns) > 50) {
    fail(`${label} invalid FINAL_SUBSCRIBER_RECONCILE_PLAN_PROOF: ${JSON.stringify(subscriberReconcilePlan)}`);
  }
  const subscriberCursorPlans = parseJsonLines(stdout, "FINAL_SUBSCRIBER_CURSOR_PLAN_PROOF");
  if (subscriberCursorPlans.length !== 1) fail(`${label} expected one FINAL_SUBSCRIBER_CURSOR_PLAN_PROOF marker, got ${subscriberCursorPlans.length}`);
  const subscriberCursorPlan = subscriberCursorPlans[0] || null;
  if (Number(subscriberCursorPlan?.historyRuns) !== 42 || Number(subscriberCursorPlan?.rowsPerRun) !== 1000
      || Number(subscriberCursorPlan?.totalRows) !== 42000
      || subscriberCursorPlan?.index !== "SubscriberScanItem_run_id_cursor_idx"
      || !["CURRENT", "PREVIOUS"].every((phase) => Array.isArray(subscriberCursorPlan?.phases) && subscriberCursorPlan.phases.includes(phase))) {
    fail(`${label} invalid FINAL_SUBSCRIBER_CURSOR_PLAN_PROOF: ${JSON.stringify(subscriberCursorPlan)}`);
  }
  return { ...summary, ...metrics, hotPlan, subscriberReconcilePlan, subscriberCursorPlan };
}
function leakSnapshot(label, databaseUrl) {
  const out = run(label, process.execPath, [LEAK_SNAPSHOT], { DATABASE_URL: databaseUrl });
  const rows = parseJsonLines(out.stdout, "A26_FIXTURE_LEAK_SNAPSHOT");
  if (rows.length !== 1) fail(`${label} missing A26 fixture leak snapshot`);
  return rows[0];
}
function leakDiff(before, after) {
  const left = before?.counts || {};
  const right = after?.counts || {};
  const leftIdentities = before?.identities || {};
  const rightIdentities = after?.identities || {};
  const keys = [...new Set([
    ...Object.keys(left), ...Object.keys(right),
    ...Object.keys(leftIdentities), ...Object.keys(rightIdentities),
  ])].sort();
  return keys.filter((key) =>
    Number(left[key] || 0) !== Number(right[key] || 0)
    || String(leftIdentities[key] || "") !== String(rightIdentities[key] || "")
  ).map((key) => ({
    table: key,
    before: Number(left[key] || 0),
    after: Number(right[key] || 0),
    beforeIdentityDigest: String(leftIdentities[key] || ""),
    afterIdentityDigest: String(rightIdentities[key] || ""),
  }));
}
function runProofTests(label, databaseUrl) {
  const aggregate = [];
  const fileResults = [];
  let durationMs = 0;
  const summary = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  for (const file of PROOF_TESTS) {
    const short = path.basename(file, ".integration.test.js");
    const before = leakSnapshot(`${label}-${short}-leak-before`, databaseUrl);
    const out = run(`${label}-${short}`, process.execPath, ["--test", "--test-concurrency=1", file], { DATABASE_URL: databaseUrl, ONLINOD_POSTGRES_INTEGRATION: "1" }, undefined, { allowFailure: true });
    const after = leakSnapshot(`${label}-${short}-leak-after`, databaseUrl);
    const leaks = leakDiff(before, after);
    const fileSummary = {
      tests: tapCount(out.stdout, "tests") ?? 0,
      pass: tapCount(out.stdout, "pass") ?? 0,
      fail: tapCount(out.stdout, "fail") ?? (out.failed ? 1 : 0),
      skipped: tapCount(out.stdout, "skipped") ?? 0,
    };
    for (const key of Object.keys(summary)) summary[key] += Number(fileSummary[key] || 0);
    durationMs += out.durationMs;
    aggregate.push(out.stdout || "");
    const ok = !out.failed && leaks.length === 0 && fileSummary.fail === 0 && fileSummary.skipped === 0;
    const firstError = out.digest ? out.digest.split(/\r?\n/).slice(0, 16).join("\n") : null;
    const result = { file: path.relative(ROOT, file), ok, status: out.status, ...fileSummary, leaks, log: out.log, firstError };
    fileResults.push(result);
    console.log(`# PHASE3_A26_PROOF_FILE ${JSON.stringify({
      label, file: result.file, ok: result.ok, status: result.status,
      tests: result.tests, pass: result.pass, fail: result.fail, skipped: result.skipped,
      leaks: result.leaks, firstError: result.firstError,
      log: { file: result.log.file, sha256: result.log.sha256, bytes: result.log.bytes },
    })}`);
  }
  const stdout = aggregate.join("\n");
  let authority = null;
  let assertionError = null;
  try { authority = assertNodeProof(stdout, label, summary); }
  catch (error) { assertionError = error; }
  const badFiles = fileResults.filter((row) => !row.ok);
  if (assertionError || badFiles.length) {
    const error = assertionError || new Error(`${label} has ${badFiles.length} failing/leaking proof files`);
    error.proofFiles = fileResults;
    error.summary = summary;
    throw error;
  }
  const proof = { durationMs, ...authority, files: fileResults };
  console.log(`# PHASE3_A20_NODE_PROOF_PASS ${JSON.stringify({ label, tests: proof.tests, pass: proof.pass, fail: proof.fail, skipped: proof.skipped, durationMs: Math.round(durationMs * 100) / 100 })}`);
  return proof;
}
function assertSchemaIsolation(label, databaseUrl, mode = "structural") {
  const out = run(label, process.execPath, [SCHEMA_ISOLATION_PROOF, mode], { DATABASE_URL: databaseUrl });
  if (!String(out.stdout || "").includes("A20_SCHEMA_ISOLATION_PASS")) {
    fail(`${label} did not emit A20_SCHEMA_ISOLATION_PASS`);
  }
  return { durationMs: out.durationMs };
}
function operationalizeRuntime(label, databaseUrl) {
  const out = run(label, process.execPath, [OPERATIONALIZE_RUNTIME], { DATABASE_URL: databaseUrl });
  if (!String(out.stdout || "").includes("A20_RUNTIME_OPERATIONALIZATION_PASS")) {
    fail(`${label} did not emit A20_RUNTIME_OPERATIONALIZATION_PASS`);
  }
  return { durationMs: out.durationMs };
}
function assertSubscriberPostflight(label, databaseUrl) {
  const out = run(label, process.execPath, [SUBSCRIBER_POSTFLIGHT], { DATABASE_URL: databaseUrl });
  if (!/"ok"\s*:\s*true/.test(String(out.stdout || ""))) {
    fail(`${label} did not emit ok=true`);
  }
  return { durationMs: out.durationMs };
}

function clonePrisma(targetRoot, cutoff = null) {
  const target = path.join(targetRoot, "prisma");
  fs.mkdirSync(path.join(target, "migrations"), { recursive: true });
  fs.copyFileSync(path.join(PRISMA_DIR, "schema.prisma"), path.join(target, "schema.prisma"));
  for (const name of fs.readdirSync(path.join(PRISMA_DIR, "migrations")).sort()) {
    if (cutoff && name > cutoff) continue;
    fs.cpSync(path.join(PRISMA_DIR, "migrations", name), path.join(target, "migrations", name), { recursive: true });
  }
  return target;
}
function addMigrationsAfter(targetPrisma, cutoff) {
  for (const name of fs.readdirSync(path.join(PRISMA_DIR, "migrations")).sort()) {
    if (name <= cutoff) continue;
    const dest = path.join(targetPrisma, "migrations", name);
    if (!fs.existsSync(dest)) fs.cpSync(path.join(PRISMA_DIR, "migrations", name), dest, { recursive: true });
  }
}
function dropSchema(cli, audit, schema, schemaFile) {
  const sql = `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`;
  const base = withSchema(audit, "public");
  const out = spawnSync(cli, ["db", "execute", "--stdin", "--schema", schemaFile], { cwd: ROOT, env: { ...process.env, DATABASE_URL: base }, input: sql, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const ok = !out.error && out.status === 0;
  const result = { schema, ok, status: out.error ? null : out.status, error: out.error?.message || null, stdout: out.stdout || "", stderr: out.stderr || "" };
  if (!ok) console.error(`# PHASE3_A26_SCHEMA_CLEANUP_FAIL ${JSON.stringify({ schema, status: result.status, error: result.error, stderr: result.stderr.slice(0, 1000) })}`);
  return result;
}

function main() {
  const audit = auditUrl();
  const cli = localPrismaCli();
  const nonce = crypto.randomBytes(5).toString("hex");
  const cleanSchema = `onlinod_a20_clean_${nonce}`;
  const rollingSchema = `onlinod_a20_roll_${nonce}`;
  const seededRollingSchema = `onlinod_a20_seeded_${nonce}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-a20-pg-"));
  const cleanRoot = path.join(temp, "clean");
  const rollingRoot = path.join(temp, "rolling");
  const seededRollingRoot = path.join(temp, "seeded-rolling");
  const cleanPrisma = clonePrisma(cleanRoot);
  const rollingPrisma = clonePrisma(rollingRoot, A13_CUTOFF);
  const seededRollingPrisma = clonePrisma(seededRollingRoot, PRE_A20_2_CUTOFF);
  const cleanSchemaFile = path.join(cleanPrisma, "schema.prisma");
  const rollingSchemaFile = path.join(rollingPrisma, "schema.prisma");
  const seededRollingSchemaFile = path.join(seededRollingPrisma, "schema.prisma");
  const failures = [];
  const scenarios = {};
  const cleanup = [];

  function serializeError(error) {
    return {
      message: String(error?.message || error),
      code: error?.code || null,
      exitCode: error?.exitCode || null,
      stack: String(error?.stack || "").split(/\r?\n/).slice(0, 80).join("\n"),
      summary: error?.summary || null,
      proofFiles: Array.isArray(error?.proofFiles) ? error.proofFiles : null,
    };
  }
  function scenario(name, work) {
    try {
      const result = work();
      scenarios[name] = { ok: true, ...result };
      return result;
    } catch (error) {
      const failure = { scenario: name, ...serializeError(error) };
      failures.push(failure);
      scenarios[name] = { ok: false, failure };
      console.error(`# PHASE3_A26_SCENARIO_FAIL ${JSON.stringify({ scenario: name, message: failure.message, code: failure.code, exitCode: failure.exitCode })}`);
      return null;
    }
  }

  try {
    scenario("clean-current", () => {
      const cleanUrl = withSchema(audit, cleanSchema);
      run("clean-current-migrate", cli, ["migrate", "deploy", "--schema", cleanSchemaFile], { DATABASE_URL: cleanUrl });
      const schemaIsolation = assertSchemaIsolation("clean-current-schema-isolation", cleanUrl);
      const operationalization = operationalizeRuntime("clean-current-operationalize", cleanUrl);
      assertSchemaIsolation("clean-current-fixture-lifecycle", cleanUrl, "runtime");
      const subscriberPostflight = assertSubscriberPostflight("clean-current-subscriber-postflight", cleanUrl);
      const indexAbsent = run("clean-current-index-lifecycle-absent", process.execPath, [INDEX_LIFECYCLE_CONCURRENCY_PROOF, "absent"], { DATABASE_URL: cleanUrl });
      if (!String(indexAbsent.stdout || "").includes("A20_12_INDEX_ABSENT_CONCURRENCY_PASS")) fail("clean-current index lifecycle absent/concurrent proof did not emit PASS marker");
      const preflight = run("clean-current-preflight-concurrency", process.execPath, [PREFLIGHT_CONCURRENCY_PROOF], { DATABASE_URL: cleanUrl });
      if (!String(preflight.stdout || "").includes("A20_9_PREFLIGHT_CONCURRENCY_PASS")) fail("clean-current preflight concurrency proof did not emit PASS marker");
      const proof = runProofTests("clean-current-proof", cleanUrl);
      return { schemaIsolation, operationalization, subscriberPostflight, indexLifecycleAbsent: { pass: true, durationMs: indexAbsent.durationMs }, preflightConcurrency: { pass: true, durationMs: preflight.durationMs }, proof };
    });

    scenario("rolling-a13-to-current", () => {
      const rollingUrl = withSchema(audit, rollingSchema);
      run("rolling-a13-migrate", cli, ["migrate", "deploy", "--schema", rollingSchemaFile], { DATABASE_URL: rollingUrl });
      assertSchemaIsolation("rolling-a13-schema-isolation", rollingUrl);
      const operationalization = operationalizeRuntime("rolling-a13-operationalize", rollingUrl);
      assertSchemaIsolation("rolling-a13-fixture-lifecycle", rollingUrl, "runtime");
      addMigrationsAfter(rollingPrisma, A13_CUTOFF);
      run("rolling-a13-to-current-migrate", cli, ["migrate", "deploy", "--schema", rollingSchemaFile], { DATABASE_URL: rollingUrl });
      const schemaIsolation = assertSchemaIsolation("rolling-current-schema-isolation", rollingUrl);
      operationalizeRuntime("rolling-current-operationalize-verify", rollingUrl);
      assertSchemaIsolation("rolling-current-fixture-lifecycle", rollingUrl, "runtime");
      const subscriberPostflight = assertSubscriberPostflight("rolling-current-subscriber-postflight", rollingUrl);
      const proof = runProofTests("rolling-a13-to-current-proof", rollingUrl);
      return { schemaIsolation, operationalization, subscriberPostflight, proof };
    });

    scenario("seeded-pre-a20-2-to-current", () => {
      const seededRollingUrl = withSchema(audit, seededRollingSchema);
      const seedEnv = {
        DATABASE_URL: seededRollingUrl,
        ONLINOD_A20_SEED_NONCE: nonce,
        ONLINOD_A20_SEED_HISTORY_ROWS: process.env.ONLINOD_A20_SEED_HISTORY_ROWS || "20000",
        ONLINOD_A20_SEED_CURRENT_ROWS: process.env.ONLINOD_A20_SEED_CURRENT_ROWS || "10000",
      };
      run("seeded-pre-a20-2-migrate", cli, ["migrate", "deploy", "--schema", seededRollingSchemaFile], { DATABASE_URL: seededRollingUrl });
      assertSchemaIsolation("seeded-pre-a20-2-schema-isolation", seededRollingUrl);
      const operationalization = operationalizeRuntime("seeded-pre-a20-2-operationalize", seededRollingUrl);
      assertSchemaIsolation("seeded-pre-a20-2-fixture-lifecycle", seededRollingUrl, "runtime");
      run("seeded-pre-a20-2-data", process.execPath, ["scripts/audit/phase3-a20-seeded-rolling-coverage.js", "seed"], seedEnv);
      const runtimeAvailability = run("seeded-a20-11-preflight-runtime-availability", process.execPath, [PREFLIGHT_RUNTIME_AVAILABILITY_PROOF], seedEnv);
      if (!String(runtimeAvailability.stdout || "").includes("A20_11_PREFLIGHT_RUNTIME_AVAILABILITY_PASS")) fail("seeded preflight runtime-availability proof did not emit PASS marker");
      run("seeded-a20-2-online-preflight", process.execPath, [COVERAGE_PREFLIGHT], seedEnv);
      const indexInvalid = run("seeded-index-lifecycle-invalid-recovery", process.execPath, [INDEX_LIFECYCLE_CONCURRENCY_PROOF, "invalid"], seedEnv);
      if (!String(indexInvalid.stdout || "").includes("A20_12_INDEX_INVALID_RECOVERY_PASS")) fail("seeded index lifecycle invalid recovery proof did not emit PASS marker");
      addMigrationsAfter(seededRollingPrisma, PRE_A20_2_CUTOFF);
      run("seeded-a20-2-to-current-migrate", cli, ["migrate", "deploy", "--schema", seededRollingSchemaFile], { DATABASE_URL: seededRollingUrl });
      const schemaIsolation = assertSchemaIsolation("seeded-current-schema-isolation", seededRollingUrl);
      operationalizeRuntime("seeded-current-operationalize-verify", seededRollingUrl);
      assertSchemaIsolation("seeded-current-fixture-lifecycle", seededRollingUrl, "runtime");
      const subscriberPostflight = assertSubscriberPostflight("seeded-current-subscriber-postflight", seededRollingUrl);
      const seededVerify = run("seeded-a20-2-backfill-verify", process.execPath, ["scripts/audit/phase3-a20-seeded-rolling-coverage.js", "verify"], seedEnv);
      const migrationMetrics = parseJsonLines(seededVerify.stdout, "A20_6_SEEDED_BACKFILL_EXPLAIN_METRICS");
      if (migrationMetrics.length !== 1) fail("seeded migration proof missing A20.6 EXPLAIN metrics");
      const migrationMetric = migrationMetrics[0];
      if (Number(migrationMetric?.currentGenerationRows) < 1000 || migrationMetric?.currentRunIndexUsed !== true) fail(`seeded migration proof did not exercise a large indexed current generation: ${JSON.stringify(migrationMetric)}`);
      const proof = runProofTests("seeded-a20-2-current-proof", seededRollingUrl);
      return { schemaIsolation, operationalization, subscriberPostflight, preflightRuntimeAvailability: { pass: true, durationMs: runtimeAvailability.durationMs }, indexLifecycleInvalidRecovery: { pass: true, durationMs: indexInvalid.durationMs }, migrationMetrics: migrationMetric, proof };
    });
  } finally {
    cleanup.push(dropSchema(cli, audit, cleanSchema, cleanSchemaFile));
    cleanup.push(dropSchema(cli, audit, rollingSchema, rollingSchemaFile));
    cleanup.push(dropSchema(cli, audit, seededRollingSchema, seededRollingSchemaFile));
    fs.rmSync(temp, { recursive: true, force: true });
  }

  for (const row of cleanup) if (!row.ok) failures.push({ scenario: "cleanup", message: `schema cleanup failed for ${row.schema}`, cleanup: row });
  const proof = {
    version: "A26",
    ok: failures.length === 0,
    cleanSchema, rollingSchema, seededRollingSchema,
    a13Cutoff: A13_CUTOFF,
    preA20_2Cutoff: PRE_A20_2_CUTOFF,
    expectedProofTestsPerScenario: EXPECTED_PROOF_TEST_COUNT,
    expectedProofTestsTotal: EXPECTED_PROOF_TEST_COUNT * 3,
    scenarios,
    cleanup: cleanup.map(({ stdout, stderr, ...row }) => row),
    failures,
  };
  const output = String(process.env.ONLINOD_AUDIT_PROOF_OUTPUT || path.join(ROOT, "artifacts", "audit", "phase3-a26-postgres-proof.json")).trim();
  const resolved = path.resolve(output);
  const failureOutput = path.resolve(process.env.ONLINOD_AUDIT_FAILURE_OUTPUT || path.join(ROOT, "artifacts", "audit", "phase3-a26-failure-manifest.json"));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.mkdirSync(path.dirname(failureOutput), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(proof, null, 2) + "\n", "utf8");
  fs.writeFileSync(failureOutput, JSON.stringify({ version: "A26", ok: failures.length === 0, failures, scenarios, cleanup: proof.cleanup }, null, 2) + "\n", "utf8");
  if (!fs.existsSync(resolved) || fs.statSync(resolved).size <= 0) fail("physical proof JSON was not persisted");
  if (!fs.existsSync(failureOutput) || fs.statSync(failureOutput).size <= 0) fail("physical proof failure manifest was not persisted");
  console.log(`# PHASE3_A26_POSTGRES_PROOF_FILE ${resolved}`);
  console.log(`# PHASE3_A26_FAILURE_MANIFEST ${failureOutput}`);
  const scenarioTotals = Object.fromEntries(Object.entries(scenarios).map(([name, row]) => [name, row?.ok
    ? { ok: true, tests: row?.proof?.tests ?? null, pass: row?.proof?.pass ?? null, fail: row?.proof?.fail ?? null, skipped: row?.proof?.skipped ?? null }
    : { ok: false, message: row?.failure?.message || null, exitCode: row?.failure?.exitCode || null }]));
  console.log(`# PHASE3_A26_POSTGRES_PROOF_JSON ${JSON.stringify({
    version: proof.version, ok: proof.ok,
    expectedProofTestsPerScenario: proof.expectedProofTestsPerScenario,
    expectedProofTestsTotal: proof.expectedProofTestsTotal,
    scenarioTotals, failureCount: failures.length,
    cleanupOk: proof.cleanup.every((row) => row.ok),
    proofFile: resolved, failureManifest: failureOutput,
  })}`);
  if (!proof.ok) fail(`A26 physical proof failed across ${failures.length} scenario/cleanup boundaries; inspect ${failureOutput}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`# PHASE3_A20_POSTGRES_PROOF_FAIL ${error?.stack || error?.message || error}`);
    process.exitCode = Number.isInteger(Number(error?.exitCode)) ? Number(error.exitCode) : 3;
  }
}

module.exports = {
  EXPECTED_PROOF_TEST_COUNT,
  PROOF_TESTS,
  tapCount,
  parseJsonLines,
  assertScaleMetrics,
  assertNodeProof,
  withSchema,
};
