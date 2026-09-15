"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const srcRoot = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(srcRoot, rel), "utf8");

function productionJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function routeBlock(source, startNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} missing`);
  const end = source.indexOf("\nrouter.", start + startNeedle.length);
  return source.slice(start, end < 0 ? source.length : end);
}

test("INT2.4 anti-map: every backend realtimeReady=true consumer is explicitly classified", () => {
  const consumers = [];
  for (const file of productionJsFiles(srcRoot)) {
    const source = fs.readFileSync(file, "utf8");
    if (/realtimeReady\s*:\s*true/.test(source)) consumers.push(path.relative(srcRoot, file).replaceAll(path.sep, "/"));
  }
  assert.deepEqual(consumers.sort(), ["routes/automation-control.js", "routes/stats.js"]);
});

test("automation runtime-event realtime capability is fenced to the receive-time member accessEpoch", () => {
  const source = read("routes/automation-control.js");
  const start = source.indexOf("async function handleBumpRuntimeEvents(req, res)");
  const end = source.indexOf('router.post("/bumps/:creatorId/events"', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const epochAt = block.indexOf("const memberAccessEpoch = req.automationMember?.accessEpoch");
  const sourceEpochAt = block.indexOf("input.accessEpoch !== memberAccessEpoch");
  const bindingHelperAt = block.indexOf("const assertRealtimeBinding = async (db)");
  const admissionAt = block.indexOf("await assertRealtimeBinding(prisma)");
  const fenceAt = block.indexOf("withRealtimeIngestGenerationFence");
  const processingAt = block.indexOf("processRuntimeEvents");
  assert.ok(epochAt >= 0 && sourceEpochAt > epochAt && bindingHelperAt > sourceEpochAt && admissionAt > bindingHelperAt && fenceAt > admissionAt && processingAt > fenceAt);
  assert.match(source, /const runtimeEventSchema = z\.object\(\{[\s\S]*accessEpoch: z\.number\(\)\.int\(\)\.min\(0\)/);
  assert.match(block, /RUNTIME_EVENT_AUTHORIZATION_GENERATION_STALE/);
  assert.match(block, /capabilityFreshnessWindow\(authorityNow, 5 \* 60_000\)/);
  assert.match(block, /status: "ACTIVE",[\s\S]{0,180}realtimeReady: true,[\s\S]{0,120}accessEpoch: input\.accessEpoch/);
  assert.match(block, /device: \{ agencyId: req\.auth\.agencyId, userId: req\.auth\.userId, lastSeenAt: freshnessWindow \}/);
  assert.match(block, /accessEpoch: input\.accessEpoch,[\s\S]*work: async \(\{ tx \}\) => \{[\s\S]*await assertRealtimeBinding\(tx\)[\s\S]*return work\(tx\)/);
  assert.match(block, /processRuntimeEvents\(\{[\s\S]*commitFence/);
  assert.match(source, /router\.post\("\/bumps\/:creatorId\/events", seniorRequired, handleBumpRuntimeEvents\)/);
  assert.match(source, /router\.post\("\/bumps\/:creatorId\/events\/current-authorized", seniorRequired, handleBumpRuntimeEvents\)/);
});

test("live notification realtime capability is fail-closed and fenced to the current member accessEpoch", () => {
  const source = read("routes/stats.js");
  const block = routeBlock(source, 'router.post("/creators/:creatorId/notifications/live"');
  const epochAt = block.indexOf("const memberAccessEpoch = ctx.member?.accessEpoch");
  const bindingHelperAt = block.indexOf("const assertLiveBinding = async (db)");
  const admissionAt = block.indexOf("device = await assertLiveBinding(prisma)");
  const commitGuardAt = block.indexOf("const commitGuard = async (tx)");
  const ingestAt = block.indexOf("ingestNotificationFacts");
  assert.ok(epochAt >= 0 && bindingHelperAt > epochAt && admissionAt > bindingHelperAt && commitGuardAt > admissionAt && ingestAt > commitGuardAt);
  assert.match(block, /if \(!Number\.isInteger\(memberAccessEpoch\)\)[\s\S]*LIVE_NOTIFICATION_AUTHORIZATION_GENERATION_REQUIRED/);
  assert.match(block, /status: "ACTIVE",[\s\S]{0,180}realtimeReady: true,[\s\S]{0,120}accessEpoch: memberAccessEpoch/);
  assert.match(block, /assertRealtimeIngestGenerationCurrent\(\{[\s\S]*db: tx[\s\S]*accessEpoch: memberAccessEpoch/);
  assert.match(block, /await assertLiveBinding\(tx\)/);
  assert.match(block, /ingestNotificationFacts\(\{[\s\S]*commitGuard/);
  assert.match(block, /withRealtimeIngestGenerationFence\(\{[\s\S]*recordNotificationSocketEvent\(\{[\s\S]*db: tx/);
  assert.doesNotMatch(block, /Number\.isInteger\(Number\(ctx\.member\?\.accessEpoch\)\)/);
});
