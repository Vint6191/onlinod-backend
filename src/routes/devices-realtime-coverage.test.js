"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "devices.js"), "utf8");
const heartbeat = require("../services/device-heartbeat-batch-service");
const now = new Date("2026-10-17T12:00:00Z");
async function resolveAccount(account, currentAccessEpoch = 0) {
  const writes = [];
  const result = await heartbeat.syncBindings({ agencyId:"a",deviceId:"d",accounts:[{creatorId:"c",...account}],
    currentAccessEpoch,now,db:{
      $queryRawUnsafe:async()=>[{i:0,id:"c",lastRealtimeEventAt:new Date(+now-2*3600000)}],
      $executeRawUnsafe:async(sql,...args)=>{writes.push({sql,args});return 1;},
    }});
  return {result,writes,account:result.resolvedAccounts[0].account};
}

test("legacy realtime-ping cannot mutate observation coverage", () => {
  const routeStart = source.indexOf('router.post("/realtime-ping"');
  const nextRoute = source.indexOf('router.post("/commands/:id/ack"', routeStart);
  assert.ok(routeStart >= 0 && nextRoute > routeStart);
  const route = source.slice(routeStart, nextRoute);
  assert.match(route, /status\(410\)/);
  assert.match(route, /REALTIME_PING_DEPRECATED/);
  assert.doesNotMatch(route, /recordRealtimeObservationPing/);
});

test("heartbeat can fence contiguous coverage while recovery is unresolved", async () => {
  let payload;
  const result=await heartbeat.recordTeamObservations({agencyId:"a",now,preserve:id=>id==="gap",bindings:["gap","healthy"].map(creatorId=>({creatorId,
    account:{realtimeHealthy:true,lastWsFrameAt:now.toISOString()}})),
    db:{$executeRawUnsafe:async(sql,agencyId,json)=>{payload=JSON.parse(json);return 2;}}});
  assert.equal(payload.find(x=>x.creatorId==="gap").at,null);
  assert.equal(payload.find(x=>x.creatorId==="healthy").at,now.toISOString());
  assert.equal(result.realtimeCoverageFenced,1);
  assert.equal(result.realtimeCoverageAdvanced,1);
});


test("heartbeat validates the inbound frame timestamp before admitting live coverage", async () => {
  const valid={accessEpoch:0,sessionReadReady:true,realtimeHealthy:true,lastWsFrameAt:now.toISOString()};
  assert.equal((await resolveAccount(valid)).result.recoveryCandidates.length,1);
  for(const frame of [null,new Date(+now-4*60000).toISOString(),new Date(+now+60000).toISOString()]) {
    const {account,result}=await resolveAccount({...valid,lastWsFrameAt:frame});
    assert.equal(account.realtimeHealthy,false);
    assert.equal(account.lastWsFrameAt,null);
    assert.equal(result.recoveryCandidates.length,0);
    assert.equal(account.sessionReadReady,true,"API capability does not require a healthy websocket");
  }
  assert.match(source, /realtimeBindings[\s\S]*realtimeFrameSampleAt\(entry\.account, heartbeatAt\)/);
});


test("heartbeat capability publication and creator-wide coverage use commit-time AgencyMember generation fences", () => {
  assert.match(source, /withHeartbeatMemberGeneration\(\{/);
  assert.match(source, /work: async \(\{ tx, member, accessEpoch \}\) => \{/);
  assert.match(source, /syncDeviceCreatorBindings\(\{[\s\S]*currentAccessEpoch: accessEpoch,[\s\S]*db: tx/);
  assert.match(source, /expectedAccessEpoch: currentAccessEpoch/);
  assert.match(source, /recordCaptureSamples\(\{[\s\S]*db:tx[\s\S]*bindings:bindings\.resolvedAccounts/);
  assert.match(source, /recordTeamObservations\(\{[\s\S]*db:tx/);
});

test("missing/null reported accessEpoch cannot coerce to epoch zero", async () => {
  for(const accessEpoch of [null,undefined,"",-1,0.5,1]) {
    const {account}=await resolveAccount({accessEpoch,sessionReadReady:true,sessionWriteReady:true,
      realtimeHealthy:true,lastWsFrameAt:now.toISOString(),browserMaterialized:true,browserPresentable:true,pageLocalReady:true});
    for(const key of ["sessionReadReady","sessionWriteReady","realtimeHealthy","browserMaterialized","browserPresentable","pageLocalReady"])
      assert.equal(account[key],false,`${key} at epoch ${accessEpoch}`);
  }
  assert.equal((await resolveAccount({accessEpoch:0,sessionReadReady:true})).account.sessionReadReady,true);
});

test("cross-agency device-row mutation is inside the same current-membership generation transaction", () => {
  const agencySelection = source.indexOf("const agencyId = input.agencyId || input.activeAgencyId || req.auth.agencyId");
  const capabilityFence = source.indexOf("const capabilityCommit = await withHeartbeatMemberGeneration", agencySelection);
  const deviceMutation = source.indexOf("tx.workerDevice.upsert", capabilityFence);
  const scopeRead = source.indexOf("allowedCreatorScope({ agencyId, member, db: tx })", deviceMutation);
  assert.ok(agencySelection >= 0);
  assert.ok(capabilityFence > agencySelection);
  assert.ok(deviceMutation > capabilityFence, "device.agencyId must not change before current target membership is locked and reread");
  assert.ok(scopeRead > deviceMutation);
  assert.doesNotMatch(source.slice(agencySelection, capabilityFence), /workerDevice\.(upsert|update|updateMany|create)/,
    "no target-agency device mutation may occur before the generation fence");
});

test("current manifest generation fence completes before device commands are marked delivered", () => {
  const manifestFence = source.indexOf("const manifestRows = await withHeartbeatMemberGeneration");
  const commandsRead = source.indexOf("const commands = await prisma.deviceCommand.findMany");
  const commandsDelivered = source.indexOf("await prisma.deviceCommand.updateMany", commandsRead);
  const response = source.indexOf("return res.json({", commandsDelivered);
  assert.ok(manifestFence >= 0);
  assert.ok(commandsRead > manifestFence, "commands must not be consumed before the final authorization-sensitive manifest fence succeeds");
  assert.ok(commandsDelivered > commandsRead);
  assert.ok(response > commandsDelivered);
});
