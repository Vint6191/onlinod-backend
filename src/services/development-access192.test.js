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
test('development button uses real admin API, current revision and only the selected agency',async()=>{
 let action,body,calls=0,reloads=0;const button={addEventListener:(_event,fn)=>{action=fn;}};
 const main={querySelector:selector=>selector==='#admSubSave'?{addEventListener(){}}:selector==='#admSubDevelopment'?button:null};
 const window={NodAdminWorkspace:{action:async(_main,work)=>work(()=>true)},NodAdminRouter:{toast(){},escapeAttr:String,escapeHtml:String},NodAdminUtils:{timeAgo:()=>''},NodAdminAgencyDetailActions:{reloadDetail:()=>reloads++},NodAdminApi:{patchSubscription:async(id,payload)=>{calls++;assert.equal(id,'agency-selected');body=payload;return {ok:true};}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../public/admin/modules/admin-agency-detail/admin-agency-detail-tabs.js'),'utf8'),{window});
 window.NodAdminAgencyDetailTabs.bindSubscription(main,{data:{agency:{id:'agency-selected',billingPolicyRevision:7}}});await action();
 assert.equal(calls,1);assert.equal(reloads,1);assert.deepEqual(JSON.parse(JSON.stringify(body)),{expectedRevision:7,billingMode:'FREE_INTERNAL',reason:'Internal development and beta testing'});
});
