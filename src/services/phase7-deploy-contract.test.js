'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {validateEvidence}=require('./phase7-contract-evidence');
const {GENERATION}=require('./phase7-legacy-storage-service');
const {PRE,POST}=require('../../scripts/database/phase7-deploy');
test('Phase7 deploy retains every preflight and postflight in the production wrapper',()=>{
 assert.deepEqual(POST[0], ["analytics-traffic-indexes.js", "--create"]);
 assert(POST.some(([script]) => script === "provider-capacity-catalog-postflight.js"));
 assert.equal(PRE.length,8);
 assert.deepEqual(POST.map(([script]) => script), [
  "analytics-traffic-indexes.js", "campaign-observation-postflight.js", "campaign-bounded-postflight.js",
  "campaign-traversal-postflight.js", "campaign-value-refresh-postflight.js", "traffic-projection-postflight.js",
  "provider-capacity-catalog-postflight.js", "phase3-domain-work-claim-online-rollout.js",
  "phase3-subscriber-publication-schema-online-postflight.js", "phase3-analytics-legacy-snapshot-online-postflight.js",
  "actual60-refreshsession-online-index-preflight.js"
 ]);
 const source=fs.readFileSync(path.join(__dirname,'../../scripts/database/phase7-deploy.js'),'utf8');
 assert(source.indexOf('if(hooks&&!plan.fresh)')<source.indexOf("'migrate','deploy'"));
 assert(source.indexOf("'migrate','deploy'")<source.indexOf('if(hooks){if(plan.fresh)'));
 assert.match(source,/contract&&!plan.purged/);assert.match(source,/phase7-role-preflight/);
});
test('Phase7 contract refuses absent, expired, mismatched or incomplete operator evidence',()=>{
 const release={backendHash:'a'.repeat(64),desktopHash:'b'.repeat(64),baseBackendHash:'c'.repeat(64),baseDesktopHash:'d'.repeat(64)};
 const now=Date.parse('2026-09-30T12:00:00Z'),iso=n=>new Date(n).toISOString();
 const good={version:1,generation:GENERATION,...release,operator:'fixture',noOldBinariesRemain:true,rollbackMode:'restore_database_and_matching_sources',rollbackWindow:{openedAt:iso(now-10000),closedAt:iso(now)},
 stoppedBinaries:[['backend',release.baseBackendHash],['desktop',release.baseDesktopHash]].map(([component,sourceHash])=>({component,sourceHash,scope:'fixture',stoppedAt:iso(now-1000)})),
 archive:{durability:'persistent_backup',exportRoot:'e'.repeat(64),restoreRoot:'f'.repeat(64),backupId:'fixture',restoredAt:iso(now),retentionUntil:iso(now+86400000)}};
 assert.match(validateEvidence(good,release,{now}).evidenceHash,/^[a-f0-9]{64}$/);
 for(const update of [x=>x.noOldBinariesRemain=false,x=>x.backendHash='0'.repeat(64),x=>x.stoppedBinaries.pop(),x=>x.rollbackWindow.closedAt=iso(now-20000),x=>x.archive.retentionUntil=iso(now),x=>x.archive.restoreRoot=x.archive.exportRoot]){
  const bad=structuredClone(good);update(bad);assert.throws(()=>validateEvidence(bad,release,{now}),e=>e.code.startsWith('PHASE7_'));
 }
});
test('Phase7 jobs HTTP boundary refuses old Desktop before claim authority is invoked',async()=>{
 const routes=new Map(),calls=[];const router={use(){},post(p,h){routes.set(p,h);},get(){}};
 const lease=new Proxy({JobLeaseError:class extends Error{},claimJob:async input=>{calls.push(input);return {job:null};}},{get:(t,k)=>t[k]||(()=>{})});
 const source=fs.readFileSync(path.join(__dirname,'../routes/jobs.js'),'utf8');
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,require:id=>id==='express'?{Router:()=>router}:id==='zod'?require('zod'):id.includes('job-lease-service')?lease:id.includes('middleware/auth')?{requireAuthDevice(){}}:{},console});
 const handler=routes.get('/claim');assert.equal(typeof handler,'function');
 const invoke=async body=>{const result={status:200};const res={status(n){result.status=n;return this;},json(x){result.body=x;return x;}};await handler({body,auth:{userId:'user-1'}},res,e=>{throw e;});return result;};
 const old=await invoke({jobKeys:['creator_campaigns_scan'],deviceId:'device-1'});assert.equal(old.status,426);assert.equal(calls.length,0);
 const fresh=await invoke({jobKeys:['creator_campaigns_scan'],deviceId:'device-1',capabilities:{legacyStorageRetirementV1:true}});assert.equal(fresh.status,200);assert.equal(calls.length,1);assert.equal(fresh.body.serverCapabilities.legacyStorageRetirementV1,true);
});
