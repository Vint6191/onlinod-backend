"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createProxyEndpoint,
  createProxyForCreator,
  updateProxyEndpoint,
  deleteProxyEndpoint,
  setCreatorNetworkProfile,
} = require("./creator-network-profile-service");

const staleManager = { id:"m1", userId:"user-1", agencyId:"agency-1", role:"MANAGER", roleKey:"manager", assignedCreators:["creator-1"], permissions:{"creators.manage":true}, deletedAt:null, deactivatedAt:null };
const revokedManager = { ...staleManager, permissions:{"creators.manage":false} };

function txDb(extra={}) {
  const tx = {
    agency: { async findUnique(){ return {id:"agency-1",deletedAt:null}; } },
    user: { async findUnique(){ return {id:"user-1",disabledAt:null}; } },
    agencyMember:{ async findUnique(){ return structuredClone(revokedManager); }, async findFirst(){ return structuredClone(revokedManager); } },
    agencyCryptoRoot:{ async findUnique(){ return null; } },
    agencyProxyEndpoint:{
      async create({data}){ return { id:"proxy-new", version:1, createdAt:new Date(), updatedAt:new Date(), hasCredentials:false, encryptionMode:"SERVER_V1", ...structuredClone(data) }; },
      async findFirst({where}){ if (where.ownerCreatorId) return null; return { id:"proxy-1", agencyId:"agency-1", label:"P1", type:"SOCKS5", host:"proxy.test", port:1080, enabled:true, version:1, hasCredentials:false, encryptionMode:"SERVER_V1", ownerCreatorId:null }; },
      async findUnique(){ return { id:"proxy-1", agencyId:"agency-1", label:"P1", type:"SOCKS5", host:"proxy.test", port:1080, enabled:true, version:2, hasCredentials:false, encryptionMode:"SERVER_V1", ownerCreatorId:null }; },
      async updateMany(){ return {count:1}; }, async deleteMany(){ return {count:1}; },
    },
    creatorAccount:{ async findMany(){ return [{id:"creator-1"}]; }, async findFirst(){ return { id:"creator-1", agencyId:"agency-1", displayName:"A", username:"a", status:"READY", deletedAt:null }; } },
    creatorNetworkProfile:{
      async findUnique(){ return null; }, async findFirst(){ return null; }, async count(){ return 0; },
      async create({data}){ return { id:"profile-1", version:1, createdAt:new Date(), updatedAt:new Date(), ...structuredClone(data) }; },
      async updateMany(){ return {count:1}; },
    },
    ...extra,
  };
  return { ...tx, async $transaction(fn){ return fn(tx); } };
}

async function expectManagementRevoked(promise) {
  await assert.rejects(promise, e => e?.code === "PROXY_MANAGEMENT_REVOKED" && e?.status === 403);
}

test("D5 generic unowned proxy creation is retired without a write", async()=>{
  const db=txDb();
  await assert.rejects(createProxyEndpoint({db,agencyId:"agency-1",actorUserId:"user-1",actorMember:staleManager,input:{label:"P",type:"SOCKS5",host:"proxy.test",port:1080}}),e=>e.code==="PROXY_POOL_CREATE_RETIRED" && e.status===410);
});

test("V20.19 dedicated creator proxy creation rechecks live management authority before writes", async()=>{
  const db=txDb();
  await expectManagementRevoked(createProxyForCreator({db,agencyId:"agency-1",creatorId:"creator-1",actorUserId:"user-1",actorMember:staleManager,deviceId:"device-1",expectedNetworkVersion:0,input:{label:"P",type:"SOCKS5",host:"proxy.test",port:1080}}));
});

test("V20.19 proxy update rechecks live creators.manage inside the CAS transaction", async()=>{
  const db=txDb();
  await expectManagementRevoked(updateProxyEndpoint({db,agencyId:"agency-1",actorUserId:"user-1",actorMember:staleManager,proxyId:"proxy-1",expectedVersion:1,patch:{label:"changed"}}));
});

test("V20.19 proxy delete rechecks live creators.manage inside the delete transaction", async()=>{
  const db=txDb();
  await expectManagementRevoked(deleteProxyEndpoint({db,agencyId:"agency-1",actorUserId:"user-1",actorMember:staleManager,proxyId:"proxy-1",expectedVersion:1}));
});

test("V20.19 creator network assignment rechecks live management authority before profile mutation", async()=>{
  const db=txDb();
  await expectManagementRevoked(setCreatorNetworkProfile({db,agencyId:"agency-1",creatorId:"creator-1",actorUserId:"user-1",actorMember:staleManager,expectedVersion:0,mode:"DIRECT",proxyEndpointId:null}));
});

test("V20.19 network write routes propagate authenticated member into every management transaction",()=>{
  const route=fs.readFileSync(path.join(__dirname,"../routes/network-profiles.js"),"utf8");
  assert.match(route,/createProxyEndpoint\([\s\S]*?actorMember:\s*req\.auth\.membership/);
  assert.match(route,/deleteProxyEndpoint\([\s\S]*?actorMember:\s*req\.auth\.membership/);
  assert.match(route,/setCreatorNetworkProfile\([\s\S]*?actorMember:\s*req\.auth\.membership/);
});

for (const [name, extra, expected] of [
  ["disabled User", { user: {findUnique:async()=>({id:"user-1",disabledAt:new Date()})} }, "PROXY_MEMBER_INACTIVE"],
  ["stale epoch", { agencyMember:{findFirst:async()=>({...staleManager,accessEpoch:2})} }, "PROXY_ACCESS_STALE"],
  ["removed creator scope", { agencyMember:{findFirst:async()=>({...staleManager,assignedCreators:[]})} }, "PROXY_CREATOR_ACCESS_REVOKED"],
]) test(`D5 metadata-only proxy mutation rejects ${name} without changing proxy rows`, async()=>{
  let writes=0;
  const db=txDb({...extra,agencyProxyEndpoint:{findFirst:async()=>({id:"proxy-1",agencyId:"agency-1",ownerCreatorId:"creator-1",version:1}),updateMany:async()=>{writes++;return {count:1};}}});
  await assert.rejects(updateProxyEndpoint({db,agencyId:"agency-1",actorUserId:"user-1",actorMember:{...staleManager,accessEpoch:1},proxyId:"proxy-1",expectedVersion:1,patch:{label:"changed"}}),e=>e.code===expected);
  assert.equal(writes,0);
});
test("D5 already-deleted proxy replay still rechecks current management permission",async()=>{
  const db=txDb({agencyProxyEndpoint:{findFirst:async()=>null}});
  await expectManagementRevoked(deleteProxyEndpoint({db,agencyId:"agency-1",actorUserId:"user-1",actorMember:staleManager,proxyId:"gone",expectedVersion:1}));
});

test("D5 dedicated create uniqueness race returns 409 after transaction rollback",async()=>{
  let readsAfterFailure=0,failed=false;
  const db=txDb({agencyMember:{findFirst:async()=>staleManager},agencyProxyEndpoint:{
    findFirst:async()=>{if(failed)readsAfterFailure++;return null;},
    create:async()=>{failed=true;throw Object.assign(Error("unique creator owner"),{code:"P2002"});},
  }});
  await assert.rejects(createProxyForCreator({db,agencyId:"agency-1",creatorId:"creator-1",actorUserId:"user-1",actorMember:staleManager,deviceId:"device-1",expectedNetworkVersion:0,input:{label:"P",type:"SOCKS5",host:"proxy.test",port:1080}}),e=>e.code==="CREATOR_NETWORK_VERSION_CONFLICT"&&e.status===409);
  assert.equal(readsAfterFailure,0);
});
