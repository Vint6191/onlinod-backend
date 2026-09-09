"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const accountAuthority = fs.readFileSync(path.join(__dirname, "telegram-account-reference-authority-service.js"), "utf8");
const settings = fs.readFileSync(path.join(__dirname, "settings-service.js"), "utf8");
const delivery = fs.readFileSync(path.join(__dirname, "telegram-delivery-authority-service.js"), "utf8");
const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
const executionRuntime = fs.readFileSync(path.join(__dirname, "telegram-execution-runtime.js"), "utf8");
const providerRetention = fs.readFileSync(path.join(__dirname, "custom-provider-thread-retention-authority-service.js"), "utf8");
const revisionBinding = fs.readFileSync(path.join(__dirname, "custom-revision-provider-binding-authority-service.js"), "utf8");

function modelBlock(name) {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `${name} must exist in current Prisma schema`);
  const end = schema.indexOf("\nmodel ", start + 8);
  return schema.slice(start, end > start ? end : undefined);
}

function functionBlock(source, name, nextName = null) {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = nextName ? source.indexOf(`async function ${nextName}`, start + 1) : -1;
  return source.slice(start, end > start ? end : undefined);
}

test("Telegram account lifecycle runtime matches current non-null Prisma schema", () => {
  const model = modelBlock("AgencyTelegramMtprotoAccount");
  assert.match(model, /lifecycleState\s+String\s+@default\("ACTIVE"\)/);
  assert.doesNotMatch(model, /lifecycleState\s+String\?/);

  const helperStart = accountAuthority.indexOf("function activeLifecycleWhere");
  const helperEnd = accountAuthority.indexOf("async function", helperStart);
  const helper = accountAuthority.slice(helperStart, helperEnd > helperStart ? helperEnd : helperStart + 700);
  assert.match(helper, /return \{ lifecycleState: "ACTIVE" \}/);
  assert.doesNotMatch(helper, /lifecycleState:\s*null|OR:\s*\[/);

  assert.doesNotMatch(settings, /OR:\s*\[\s*\{\s*lifecycleState:\s*"ACTIVE"\s*\},\s*\{\s*lifecycleState:\s*null/);
  assert.match(settings, /where:\s*\{\s*id,\s*agencyId,\s*lifecycleState:\s*"ACTIVE"/);

  // Current Prisma rows are NOT NULL. Production runtime must not silently
  // resurrect nullable-era rows as ACTIVE when a test double or malformed row
  // omits lifecycleState. Missing/unknown state is fail-closed.
  const currentRuntimeSources = [accountAuthority, settings, delivery, executionRuntime, providerRetention, revisionBinding];
  for (const source of currentRuntimeSources) {
    assert.doesNotMatch(source, /lifecycleState\s*\|\|\s*["']ACTIVE["']/);
    assert.doesNotMatch(source, /lifecycleState\s*\?\?\s*["']ACTIVE["']/);
  }
  assert.match(accountAuthority, /function telegramLifecycleState/);
  assert.match(accountAuthority, /return state === "ACTIVE" \|\| state === "RETIRING" \? state : null/);
});

test("TelegramDeliveryIntent convergence never filters impossible null customOrderId", () => {
  const model = modelBlock("TelegramDeliveryIntent");
  assert.match(model, /customOrderId\s+String\b/);
  assert.doesNotMatch(model, /customOrderId\s+String\?/);

  const repair = functionBlock(delivery, "repairCustomModelCommunicationConvergence", "markTelegramDeliveryProvenNotSent");
  const retry = functionBlock(delivery, "repairPrecommitProviderBlockedIntents", "listTelegramDeliveryWork");
  assert.match(repair, /repairPrecommitProviderBlockedIntents/);
  assert.match(repair, /ensureAutomaticReminderIntents/);
  assert.match(retry, /telegramDeliveryIntent\.findMany/);
  assert.doesNotMatch(repair, /customOrderId:\s*\{\s*not:\s*null\s*\}/);
  assert.doesNotMatch(retry, /customOrderId:\s*\{\s*not:\s*null\s*\}/);

  // Do not ban this shape globally: other models, such as CustomContentSubmission,
  // legitimately keep nullable customOrderId and may use a non-null filter.
  const submission = modelBlock("CustomContentSubmission");
  assert.match(submission, /customOrderId\s+String\?/);
});

test("Telegram/custom convergence isolates one agency failure from later agencies", () => {
  const marker = "async function runTelegramConfirmedProjectionSweep";
  const start = scheduler.indexOf(marker);
  assert.ok(start >= 0, "scheduler convergence sweep must exist");
  const end = scheduler.indexOf("\nasync function ", start + marker.length);
  const block = scheduler.slice(start, end > start ? end : undefined);
  assert.match(block, /agencyFailures/);
  assert.match(block, /for \(const agency of agencies \|\| \[\]\)/);
  assert.match(block, /try\s*\{/);
  assert.match(block, /catch \(error\)/);
  assert.match(block, /agencyFailures\.push/);
});


test("retention production log includes auditable per-item deletion breakdown", () => {
  assert.match(scheduler, /function retentionBreakdown\(/);
  assert.match(scheduler, /items:\s*Object\.fromEntries/);
  assert.match(scheduler, /breakdown=\$\{breakdown\}/);
  assert.match(scheduler, /analyticsExecution/);
});
