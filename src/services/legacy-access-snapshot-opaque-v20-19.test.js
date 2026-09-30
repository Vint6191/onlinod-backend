"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('Phase7 retired legacy-access-snapshot-opaque-v20-19 implementation cannot be imported',()=>{
 assert.equal(fs.existsSync(path.join(__dirname,'legacy-access-snapshot-policy.js')),false);
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 assert.match(source,/createLegacyGoneRouter/);
 assert.doesNotMatch(source,/require\(["'].*legacy\-access\-snapshot\-opaque\-policy/);
});

test("legacy creator-connect/import AccessSnapshot writers are physically retired", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "../routes/creator-connect.js")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "../routes/creator-import.js")), false);
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.doesNotMatch(server, /creator-connect|creator-import|dev-migration\/import-local/);
});

test("legacy proxy migration cannot decrypt SERVER_V1 credentials after opaque enforcement", () => {
 const service=require('./creator-network-profile-service');
 assert.equal(service.migrateProxyCredentialsToOpaque,undefined);
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'creator-network-profile-service.js'),'utf8'),/decryptServerProxyCredentials/);
});
test("generic plaintext proxy creation remains retired before any credential or database access", async () => {
 const service=require('./creator-network-profile-service');let reads=0;
 const db=new Proxy({},{get(){reads++;throw Error('unexpected database access');}});
 await assert.rejects(service.createProxyEndpoint({db,agencyId:'a',input:{host:'localhost',password:'fixture'}}),{code:'PROXY_POOL_CREATE_RETIRED',status:410});
 assert.equal(reads,0);
});
