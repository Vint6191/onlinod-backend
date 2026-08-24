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
    agencyMember:{ async findUnique(){ return structuredClone(revokedManager); } },
    agencyCryptoRoot:{ async findUnique(){ return null; } },
    agencyProxyEndpoint:{
      async create({data}){ return { id:"proxy-new", version:1, createdAt:new Date(), updatedAt:new Date(), hasCredentials:false, encryptionMode:"SERVER_V1", ...structuredClone(data) }; },
      async findFirst({where}){ if (where.ownerCreatorId) return null; return { id:"proxy-1", agencyId:"agency-1", label:"P1", type:"SOCKS5", host:"proxy.test", port:1080, enabled:true, version:1, hasCredentials:false, encryptionMode:"SERVER_V1", ownerCreatorId:null }; },
      async findUnique(){ return { id:"proxy-1", agencyId:"agency-1", label:"P1", type:"SOCKS5", host:"proxy.test", port:1080, enabled:true, version:2, hasCredentials:false, encryptionMode:"SERVER_V1", ownerCreatorId:null }; },
      async updateMany(){ return {count:1}; }, async deleteMany(){ return {count:1}; },
    },
    creatorAccount:{ async findFirst(){ return { id:"creator-1", agencyId:"agency-1", displayName:"A", username:"a", status:"READY", deletedAt:null }; } },
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

test("V20.19 generic proxy creation rechecks live creators.manage inside the write transaction", async()=>{
  const db=txDb();
  await expectManagementRevoked(createProxyEndpoint({db,agencyId:"agency-1",actorUserId:"user-1",actorMember:staleManager,input:{label:"P",type:"SOCKS5",host:"proxy.test",port:1080}}));
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
