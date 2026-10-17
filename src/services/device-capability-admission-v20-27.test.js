"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("heartbeat keeps liveness distinct from capability while committing agency-scoped device state under current membership", () => {
  const source = read("routes/devices.js");
  const heartbeatStart = source.indexOf('router.post("/heartbeat"');
  const block = source.slice(heartbeatStart);
  const authDeviceAt = block.indexOf("requireAuthDevice(req, input.deviceId");
  const generationAt = block.indexOf("const capabilityCommit = await withHeartbeatMemberGeneration");
  const upsertAt = block.indexOf("tx.workerDevice.upsert", generationAt);
  const scopeAt = block.indexOf("allowedCreatorScope({ agencyId, member, db: tx })", upsertAt);
  const syncAt = block.indexOf("syncDeviceCreatorBindings({", scopeAt);
  assert.ok(authDeviceAt >= 0 && generationAt > authDeviceAt, "device identity must be bound before the membership generation transaction");
  assert.ok(upsertAt > generationAt, "agency-scoped device liveness mutation must occur inside current membership generation");
  assert.ok(scopeAt > upsertAt && syncAt > scopeAt, "creator capability telemetry follows current member scope in the same transaction");
  assert.match(block.slice(generationAt, syncAt + 400), /currentAccessEpoch: accessEpoch[\s\S]*db: tx/);
  assert.match(source, /syncBindings/);
});

test("DeviceCreatorBinding is presence + typed capability telemetry, not universal READY", async () => {
  const source = read("services/device-heartbeat-batch-service.js");
  const schema = fs.readFileSync(path.resolve(root, "../prisma/schema.prisma"), "utf8");
  for (const field of ["sessionReadReady", "sessionWriteReady", "realtimeReady", "pageLocalReady", "browserMaterialized", "browserPresentable", "sessionProofEpoch", "canonicalRevision", "networkRevision", "lastCapabilityAt"]) {
    assert.match(source, new RegExp(field));
    assert.match(schema, new RegExp(`\\b${field}\\b`));
  }
  const writes=[];
  const result=await require("./device-heartbeat-batch-service").syncBindings({agencyId:"a",deviceId:"d",now:new Date(),currentAccessEpoch:2,
    allowedCreatorIds:new Set(["allowed"]),accounts:[
      {creatorId:"allowed",accessEpoch:2,sessionReadReady:true,sessionWriteReady:false},
      {creatorId:"denied",accessEpoch:2,sessionReadReady:true,sessionWriteReady:true},
      {creatorId:"allowed",accessEpoch:2,sessionReadReady:true,sessionWriteReady:true},
    ],db:{
      $queryRawUnsafe:async()=>[{i:0,id:"allowed"},{i:1,id:"denied"},{i:2,id:"allowed"}],
      $executeRawUnsafe:async(sql,...args)=>{writes.push({sql,args});return 1;},
    }});
  assert.equal(result.accepted,1);assert.equal(result.rejected,2);
  const [binding]=JSON.parse(writes.find(x=>x.sql.includes('INSERT INTO "DeviceCreatorBinding"')).args[2]);
  assert.equal(binding.creatorId,"allowed");assert.equal(binding.sessionReadReady,true);
  assert.equal(binding.sessionWriteReady,false);assert.equal(binding.realtimeReady,false);
  const stale=writes.find(x=>x.sql.includes("SET status='STALE'"));
  assert.deepEqual(stale.args[2],["allowed"]);
  for(const field of ["sessionReadReady","sessionWriteReady","realtimeReady","pageLocalReady","browserMaterialized","browserPresentable"])
    assert.ok(stale.sql.includes(`"${field}"=false`));
});

test("readonly leases require SESSION_READ while automation actions require SESSION_WRITE", () => {
  const jobs = read("services/job-lease-service.js");
  const actions = read("services/automation-action-delivery-service.js");
  assert.match(jobs, /sessionReadReady: true/);
  assert.doesNotMatch(jobs, /sessionWriteReady: true/);
  assert.match(actions, /sessionWriteReady: true/);
  assert.match(jobs, /Current member access is checked independently above/);
});

test("jobs and automation device ids are fenced to the authenticated token device", () => {
  const jobs = read("routes/jobs.js");
  const automation = read("routes/automation-control.js");
  assert.match(jobs, /requireAuthDevice\(req, suppliedDeviceId/);
  assert.match(jobs, /JOB_DEVICE_IDENTITY_MISMATCH/);
  assert.match(automation, /requireAuthDevice\(req, suppliedDeviceId/);
  assert.match(automation, /AUTOMATION_DEVICE_IDENTITY_MISMATCH/);
});

test("OF request gate independently checks creator access on every request and uses binding only for SESSION_READ capability", () => {
  const route = read("routes/of-request-gate.js");
  const service = read("services/of-request-gate-service.js");
  assert.equal((route.match(/requireAuthDevice\(req, input\.deviceId/g) || []).length, 3);
  assert.match(route, /OF_GATE_DEVICE_IDENTITY_MISMATCH/);
  const requireGateStart = service.indexOf("async function requireGateAccess");
  const gateBlock = service.slice(requireGateStart, service.indexOf("function waitUntil", requireGateStart));
  const creatorAccessAt = gateBlock.indexOf("requireCreatorAccess");
  const cacheAt = gateBlock.indexOf("accessCache.get");
  assert.ok(creatorAccessAt >= 0 && cacheAt > creatorAccessAt, "member access must be rechecked before capability cache");
  assert.match(gateBlock, /sessionReadReady: true/);
  assert.match(gateBlock, /DeviceCreatorBinding is capability telemetry only and can never grant creator access/);
});

test("realtime event ingest requires REALTIME capability rather than generic binding activity", () => {
  const automation = read("routes/automation-control.js");
  assert.match(automation, /status: "ACTIVE",[\s\S]{0,120}realtimeReady: true/);
});




test("stats realtime reporter is token-device bound and retired daily reporter cannot re-enter current telemetry", () => {
  const stats = read("routes/stats.js");
  const liveStart = stats.indexOf('router.post("/creators/:creatorId/notifications/live"');
  assert.ok(liveStart >= 0);
  const liveEnd = stats.indexOf("\nrouter.", liveStart + 1);
  const live = stats.slice(liveStart, liveEnd === -1 ? stats.length : liveEnd);
  assert.match(live, /requireAuthDevice\(req, input\.deviceId/);
  assert.match(live, /realtimeReady: true/);
  assert.match(stats, /router\.post\("\/creators\/:creatorId\/messages-daily", legacyStatsGone\)/);
});
