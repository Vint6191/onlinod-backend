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
const EXPECTED_PROOF_TEST_COUNT = 40;
const COVERAGE_PREFLIGHT = path.join(ROOT, "scripts/database/phase3-campaign-coverage-generation-online-preflight.js");
const PREFLIGHT_CONCURRENCY_PROOF = path.join(ROOT, "scripts/audit/phase3-a20-preflight-concurrency.js");
const PREFLIGHT_RUNTIME_AVAILABILITY_PROOF = path.join(ROOT, "scripts/audit/phase3-a20-preflight-runtime-availability.js");
const INDEX_LIFECYCLE_CONCURRENCY_PROOF = path.join(ROOT, "scripts/audit/phase3-a20-index-lifecycle-concurrency.js");
const OPERATIONALIZE_RUNTIME = path.join(ROOT, "scripts/audit/phase3-a20-operationalize-runtime.js");
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
  if (primary && normalizedDbIdentity(primary) === normalizedDbIdentity(audit) && process.env.ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE !== "1") {
    fail("ONLINOD_AUDIT_DATABASE_URL resolves to the primary physical database; use a disposable PostgreSQL database or explicitly opt in");
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
  u.searchParams.set("schema", schema);
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
  return deduped.slice(-limit).join("\n");
}
function run(label, command, args, env, input = undefined) {
  const startedAt = process.hrtime.bigint();
  const out = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const stdout = out.stdout || "";
  const stderr = out.stderr || "";
  const log = persistStepLog(label, stdout, stderr);
  const status = out.error ? null : out.status;
  console.log(`# PHASE3_A20_POSTGRES_STEP ${JSON.stringify({ label, durationMs: Math.round(durationMs * 100) / 100, status, logSha256: log.sha256, logBytes: log.bytes })}`);
  if (out.error || out.status !== 0) {
    const digest = failureDigest(stdout, stderr);
    if (digest) console.error(`# PHASE3_A20_POSTGRES_STEP_FAILURE_DIGEST ${label}\n${digest}`);
    console.error(`# PHASE3_A20_POSTGRES_STEP_LOG ${JSON.stringify(log)}`);
    fail(`${label} failed (${out.error?.message || `exit ${out.status}`})`, out.status || 4);
  }
  return { durationMs, stdout, stderr, log };
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
    if (!row || Number(row.queryRaw) !== 1 || !Number.isFinite(Number(row.durationMs))) {
      fail(`${label} invalid A20.4 healing metric for ${count}`);
    }
  }
  const terminal = parseJsonLines(stdout, "A20_5_POSTGRES_TERMINAL_SCALE_POINT");
  if (terminal.length !== 3) fail(`${label} expected 3 A20.5 terminal timing points, got ${terminal.length}`);
  for (const count of [1, 20, 50]) {
    const row = terminal.find((item) => Number(item?.count) === count);
    if (!row || Number(row.queryRaw) !== 3 || Number(row.executeRaw) !== 0 || !Number.isFinite(Number(row.durationMs))) {
      fail(`${label} invalid A20.5 terminal metric for ${count}`);
    }
  }
  const chunkPostProjection = parseJsonLines(stdout, "A20_7_POSTGRES_CHUNK_POST_PROJECTION");
  if (chunkPostProjection.length !== 1) fail(`${label} expected one A20.7 chunk post-projection metric, got ${chunkPostProjection.length}`);
  const chunk = chunkPostProjection[0];
  if (Number(chunk?.count) !== 50 || Number(chunk?.queryRaw) !== 0 || Number(chunk?.executeRaw) !== 0 || !Number.isFinite(Number(chunk?.durationMs))) {
    fail(`${label} invalid A20.7 chunk post-projection metric`);
  }
  return { healing, terminal, chunkPostProjection: chunk };
}
function assertNodeProof(stdout, label) {
  const summary = {
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
  ];
  if (Number(hotPlan?.debtRows) !== 4000 || Number(hotPlan?.signalRows) !== 4000
      || !requiredIndexes.every((name) => Array.isArray(hotPlan?.indexes) && hotPlan.indexes.includes(name))) {
    fail(`${label} invalid FINAL_HOT_QUERY_PLAN_PROOF: ${JSON.stringify(hotPlan)}`);
  }
  const subscriberReconcilePlans = parseJsonLines(stdout, "FINAL_SUBSCRIBER_RECONCILE_PLAN_PROOF");
  if (subscriberReconcilePlans.length !== 1) fail(`${label} expected one FINAL_SUBSCRIBER_RECONCILE_PLAN_PROOF marker, got ${subscriberReconcilePlans.length}`);
  const subscriberReconcilePlan = subscriberReconcilePlans[0] || null;
  if (Number(subscriberReconcilePlan?.historyRows) !== 4000 || Number(subscriberReconcilePlan?.debtRows) !== 200
      || subscriberReconcilePlan?.index !== "SubscriberScanRun_publication_job_reconcile_idx") {
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
function runProofTests(label, databaseUrl) {
  const out = run(label, process.execPath, ["--test", "--test-concurrency=1", ...PROOF_TESTS], { DATABASE_URL: databaseUrl, ONLINOD_POSTGRES_INTEGRATION: "1" });
  const proof = { durationMs: out.durationMs, ...assertNodeProof(out.stdout, label) };
  console.log(`# PHASE3_A20_NODE_PROOF_PASS ${JSON.stringify({ label, tests: proof.tests, pass: proof.pass, fail: proof.fail, skipped: proof.skipped, durationMs: Math.round(out.durationMs * 100) / 100 })}`);
  return proof;
}
function operationalizeRuntime(label, databaseUrl) {
  const out = run(label, process.execPath, [OPERATIONALIZE_RUNTIME], { DATABASE_URL: databaseUrl });
  if (!String(out.stdout || "").includes("A20_RUNTIME_OPERATIONALIZATION_PASS")) {
    fail(`${label} did not emit A20_RUNTIME_OPERATIONALIZATION_PASS`);
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
  if (out.status !== 0) console.warn(`# PHASE3_A20_POSTGRES_PROOF_CLEANUP_WARN ${schema}: ${out.stderr || out.stdout}`);
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
  try {
    const cleanUrl = withSchema(audit, cleanSchema);
    run("clean-current-migrate", cli, ["migrate", "deploy", "--schema", cleanSchemaFile], { DATABASE_URL: cleanUrl });
    const cleanOperationalization = operationalizeRuntime("clean-current-operationalize", cleanUrl);
    const indexAbsentConcurrency = run("clean-current-index-lifecycle-absent", process.execPath, [INDEX_LIFECYCLE_CONCURRENCY_PROOF, "absent"], { DATABASE_URL: cleanUrl });
    if (!String(indexAbsentConcurrency.stdout || "").includes("A20_12_INDEX_ABSENT_CONCURRENCY_PASS")) {
      fail("clean-current index lifecycle absent/concurrent proof did not emit PASS marker");
    }
    const preflightConcurrency = run("clean-current-preflight-concurrency", process.execPath, [PREFLIGHT_CONCURRENCY_PROOF], { DATABASE_URL: cleanUrl });
    if (!String(preflightConcurrency.stdout || "").includes("A20_9_PREFLIGHT_CONCURRENCY_PASS")) {
      fail("clean-current preflight concurrency proof did not emit PASS marker");
    }
    const cleanProof = runProofTests("clean-current-proof", cleanUrl);

    const rollingUrl = withSchema(audit, rollingSchema);
    run("rolling-a13-migrate", cli, ["migrate", "deploy", "--schema", rollingSchemaFile], { DATABASE_URL: rollingUrl });
    const rollingOperationalization = operationalizeRuntime("rolling-a13-operationalize", rollingUrl);
    addMigrationsAfter(rollingPrisma, A13_CUTOFF);
    run("rolling-a13-to-current-migrate", cli, ["migrate", "deploy", "--schema", rollingSchemaFile], { DATABASE_URL: rollingUrl });
    operationalizeRuntime("rolling-current-operationalize-verify", rollingUrl);
    const rollingProof = runProofTests("rolling-a13-to-current-proof", rollingUrl);

    const seededRollingUrl = withSchema(audit, seededRollingSchema);
    const seedEnv = {
      DATABASE_URL: seededRollingUrl,
      ONLINOD_A20_SEED_NONCE: nonce,
      ONLINOD_A20_SEED_HISTORY_ROWS: process.env.ONLINOD_A20_SEED_HISTORY_ROWS || "20000",
      ONLINOD_A20_SEED_CURRENT_ROWS: process.env.ONLINOD_A20_SEED_CURRENT_ROWS || "10000",
    };
    run("seeded-pre-a20-2-migrate", cli, ["migrate", "deploy", "--schema", seededRollingSchemaFile], { DATABASE_URL: seededRollingUrl });
    const seededOperationalization = operationalizeRuntime("seeded-pre-a20-2-operationalize", seededRollingUrl);
    run("seeded-pre-a20-2-data", process.execPath, ["scripts/audit/phase3-a20-seeded-rolling-coverage.js", "seed"], seedEnv);
    const runtimeAvailability = run("seeded-a20-11-preflight-runtime-availability", process.execPath, [PREFLIGHT_RUNTIME_AVAILABILITY_PROOF], seedEnv);
    if (!String(runtimeAvailability.stdout || "").includes("A20_11_PREFLIGHT_RUNTIME_AVAILABILITY_PASS")) {
      fail("seeded preflight runtime-availability proof did not emit PASS marker");
    }
    run("seeded-a20-2-online-preflight", process.execPath, [COVERAGE_PREFLIGHT], seedEnv);
    const indexInvalidRecovery = run("seeded-index-lifecycle-invalid-recovery", process.execPath, [INDEX_LIFECYCLE_CONCURRENCY_PROOF, "invalid"], seedEnv);
    if (!String(indexInvalidRecovery.stdout || "").includes("A20_12_INDEX_INVALID_RECOVERY_PASS")) {
      fail("seeded index lifecycle invalid recovery proof did not emit PASS marker");
    }
    addMigrationsAfter(seededRollingPrisma, PRE_A20_2_CUTOFF);
    run("seeded-a20-2-to-current-migrate", cli, ["migrate", "deploy", "--schema", seededRollingSchemaFile], { DATABASE_URL: seededRollingUrl });
    operationalizeRuntime("seeded-current-operationalize-verify", seededRollingUrl);
    const seededVerify = run("seeded-a20-2-backfill-verify", process.execPath, ["scripts/audit/phase3-a20-seeded-rolling-coverage.js", "verify"], seedEnv);
    const migrationMetrics = parseJsonLines(seededVerify.stdout, "A20_6_SEEDED_BACKFILL_EXPLAIN_METRICS");
    if (migrationMetrics.length !== 1) fail(`seeded migration proof missing A20.6 EXPLAIN metrics`);
    const migrationMetric = migrationMetrics[0];
    if (Number(migrationMetric?.currentGenerationRows) < 1000 || migrationMetric?.currentRunIndexUsed !== true) {
      fail(`seeded migration proof did not exercise a large indexed current generation: ${JSON.stringify(migrationMetric)}`);
    }
    const seededProof = runProofTests("seeded-a20-2-current-proof", seededRollingUrl);

    const proof = {
      ok: true, cleanSchema, rollingSchema, seededRollingSchema,
      a13Cutoff: A13_CUTOFF, preA20_2Cutoff: PRE_A20_2_CUTOFF,
      expectedProofTests: EXPECTED_PROOF_TEST_COUNT,
      operationalization: { clean: cleanOperationalization, rolling: rollingOperationalization, seeded: seededOperationalization },
      indexLifecycleAbsent: { pass: true, durationMs: indexAbsentConcurrency.durationMs },
      indexLifecycleInvalidRecovery: { pass: true, durationMs: indexInvalidRecovery.durationMs },
      preflightConcurrency: { pass: true, durationMs: preflightConcurrency.durationMs },
      preflightRuntimeAvailability: { pass: true, durationMs: runtimeAvailability.durationMs },
      cleanProof, rollingProof, seededProof, migrationMetrics: migrationMetric,
    };
    const output = String(process.env.ONLINOD_AUDIT_PROOF_OUTPUT || path.join(ROOT, "artifacts", "audit", "phase3-a20-postgres-proof.json")).trim();
    const resolved = path.resolve(output);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(proof, null, 2) + "\n", "utf8");
    if (!fs.existsSync(resolved) || fs.statSync(resolved).size <= 0) fail("physical proof JSON was not persisted");
    console.log(`# PHASE3_A20_POSTGRES_PROOF_FILE ${resolved}`);
    console.log(`# PHASE3_A20_POSTGRES_PROOF_JSON ${JSON.stringify(proof)}`);
  } finally {
    dropSchema(cli, audit, cleanSchema, cleanSchemaFile);
    dropSchema(cli, audit, rollingSchema, rollingSchemaFile);
    dropSchema(cli, audit, seededRollingSchema, seededRollingSchemaFile);
    fs.rmSync(temp, { recursive: true, force: true });
  }
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
