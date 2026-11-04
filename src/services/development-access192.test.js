'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {randomUUID}=require('node:crypto');
const {createMemoryDb}=require('../../scripts/test-support/admin-command-memory-db');
const {setAdminBillingPolicy}=require('./admin-billing-access-command-service');
const {accessFromRow}=require('./billing-execution-access-service');
test('development access creates the missing subscription through the audited command and preserves expired trial and hold',async()=>{
 const m=createMemoryDb();m.state.subscriptions=[];m.state.agencies[0].trialEndsAt=new Date('2026-01-01');
 const trial=+m.state.agencies[0].trialEndsAt;
 const input={db:m.db,actor:{adminId:'admin-a',sessionId:'session-a',accessEpoch:1},commandId:randomUUID(),agencyId:'agency-a',payload:{expectedRevision:1,reason:'Internal development and beta testing',billingMode:'FREE_INTERNAL'}};
 const result=await setAdminBillingPolicy(input);assert.equal(result.statusCode,200);assert.equal(result.body.policy.billingMode,'FREE_INTERNAL');assert.equal(m.state.subscriptions.length,1);assert.equal(+m.state.agencies[0].trialEndsAt,trial);assert.equal(m.state.entitlements.length,0);assert.equal(m.state.audit.length,1);
 assert.equal((await setAdminBillingPolicy(input)).replayed,true);assert.equal(m.state.subscriptions.length,1);
 const row={authorityNow:new Date('2035-01-01'),billingMode:m.state.subscriptions[0].billingMode,trialEndsAt:m.state.agencies[0].trialEndsAt};
 assert.equal(accessFromRow(row).allowed,true);assert.equal(accessFromRow({...row,billingSupportHold:true}).allowed,false);assert.equal(accessFromRow({...row,billingMode:'MANUAL'}).allowed,false);
});
test('the visible development control submits the shown agency, revision, explicit return mode and reason',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../public/admin/modules/admin-billing/admin-development-access.js'),'utf8');
 for(const [mode,next] of [['MANUAL','FREE_INTERNAL'],['FREE_INTERNAL','CRYPTO']]) {
   let open,options,body,reloads=0;
   const form={elements:{reason:{value:' agency beta access '},returnMode:{value:next}}};
   const window={NodAdminState:{agencyDetail:{sel:{lastLoadedAt:33}}},NodAdminRouter:{escapeHtml:String},NodAdminUI:{drawer:()=>({sheet:{querySelector:()=>form},close(){}}),commandForm:o=>{options=o;}},NodAdminApi:{patchSubscription:async(id,payload)=>{assert.equal(id,'sel');body=payload;return {ok:true};}}};
   vm.runInNewContext(source,{window});const root={querySelector:()=>({addEventListener:(_e,fn)=>{open=fn;}})},agency={id:'sel',name:'AAA',subscriptions:[{billingMode:mode}],billingPolicyRevision:7};
   assert.match(window.NodAdminDevelopmentAccess.render(agency),mode==='MANUAL'?/Включить режим разработки/:/Выключить режим разработки/);
   window.NodAdminDevelopmentAccess.bind(root,agency,()=>reloads++);open();await options.send(options.build());options.reload();
   assert.deepEqual(JSON.parse(JSON.stringify(body)),{expectedRevision:7,billingMode:next,reason:'agency beta access'});assert.equal(reloads,1);assert.equal(window.NodAdminState.agencyDetail.sel.lastLoadedAt,0);
 }
});
test('switching development on/off preserves per-model periods and never grants another agency or bypasses hold',async()=>{
 const m=createMemoryDb(),a=m.state.agencies[0];m.state.agencies.push({...a,id:'agency-b'});
 m.state.subscriptions.push({...m.state.subscriptions[0],id:'sub-b',agencyId:'agency-b',billingMode:'STRIPE'});
 m.state.entitlements.push({agencyId:a.id,creatorId:'creator-a',coreValidFrom:new Date('2026-08-01'),coreValidUntil:new Date('2026-12-01'),tier:'ELITE',aiChatterValidUntil:new Date('2026-12-04'),outreachValidUntil:null});
 const before=globalThis.structuredClone(m.state.entitlements);const actor={adminId:'admin-a',sessionId:'session-a',accessEpoch:1};
 async function set(billingMode,expectedRevision=m.state.agencies[0].billingPolicyRevision){return setAdminBillingPolicy({db:m.db,actor,agencyId:a.id,commandId:randomUUID(),payload:{expectedRevision,billingMode,reason:'Scoped beta configuration'}});}
 const initialRevision=a.billingPolicyRevision;assert.equal((await set('FREE_INTERNAL')).statusCode,200);
 assert.equal((await set('CRYPTO',initialRevision)).body.code,'ADMIN_BILLING_POLICY_REVISION_CONFLICT');
 assert.equal(m.state.subscriptions.find(s=>s.agencyId===a.id).billingMode,'FREE_INTERNAL');
 assert.equal(accessFromRow({authorityNow:m.clock,billingMode:'FREE_INTERNAL',billingSupportHold:true}).reason,'BILLING_ACCESS_HELD');
 assert.equal((await set('CRYPTO')).statusCode,200);assert.deepEqual(m.state.entitlements,before);
 assert.equal(m.state.subscriptions.find(s=>s.agencyId==='agency-b').billingMode,'STRIPE');
});
