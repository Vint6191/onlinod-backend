'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const work=require('./domain-work-authority-service');
const receipts=require('./notification-fact-receipt-service');
const service=require('./notification-consequence-service');
const health=require('./maintenance-health-service');

test('notification maintenance reports bounded actionable errors without raw Prisma arguments or provider data',async()=>{
 const original={claim:work.claimDomainWorkBatch,fail:work.failDomainWorkClaim,page:receipts.processPage};let selected=0;
 try{
  work.claimDomainWorkBatch=async()=>({ownerToken:'fixture-owner',items:[{id:'work-'+(++selected),workClass:'NOTIFICATION_FACT_RECEIPTS',objectType:'JobInstance',objectId:'job-'+selected,creatorId:'creator'}]});
  receipts.processPage=async()=>{throw Object.assign(new Error('Invalid db.update({text:"private-message",cookie:"secret-cookie"})'),{code:'P2010',meta:{code:'55P03',message:'PHASE2_CREATOR_LIFECYCLE_BUSY agency=a creator=creator table=NotificationFactReceipt'}});};
  work.failDomainWorkClaim=async()=>({lost:false,state:'READY',consecutiveFailures:2});
  const result=await service.runNotificationConsequenceSweep({db:{$queryRawUnsafe:async()=>[]},limit:8,maxRuntimeMs:5000});
  assert.equal(result.failed,8);assert.equal(result.reason,'PHASE2_CREATOR_LIFECYCLE_BUSY');assert.equal(result.errorDetails.length,5);
  assert.equal(result.errorDetails[0].jobId,'job-1');assert.equal(result.errorDetails[0].databaseCode,'55P03');assert.equal(result.errorDetails[0].consecutiveFailures,2);
  assert.ok(Number.isFinite(result.errorDetails[0].elapsedMs));assert.doesNotMatch(JSON.stringify(result),/private-message|secret-cookie|fixture-owner|Invalid db/);
  const reported=health.maintenanceDegradedDetails({notificationConsequences:result});assert.equal(reported.notificationConsequences.reason,result.reason);assert.equal(reported.notificationConsequences.errorDetails.length,5);
 }finally{work.claimDomainWorkBatch=original.claim;work.failDomainWorkClaim=original.fail;receipts.processPage=original.page;}
});

test('Prisma unknown request errors retain SQL state and constraint without row contents',async()=>{
 const original={claim:work.claimDomainWorkBatch,fail:work.failDomainWorkClaim,page:receipts.processPage};
 try{
  work.claimDomainWorkBatch=async()=>({ownerToken:'fixture-owner',items:[{id:'work',workClass:'NOTIFICATION_FACT_RECEIPTS',objectType:'JobInstance',objectId:'job',creatorId:'creator'}]});
  receipts.processPage=async()=>{throw Object.assign(new Error('PostgresError { code: "23514", message: "violates constraint \\"Receipt_scope_check\\"", detail: "secret-row" }'),{name:'PrismaClientUnknownRequestError'});};
  work.failDomainWorkClaim=async()=>({lost:false,state:'RECONCILE_REQUIRED',consecutiveFailures:1});
  const result=await service.runNotificationConsequenceSweep({db:{$queryRawUnsafe:async()=>[]},limit:1});
  assert.equal(result.errorDetails[0].databaseCode,'23514');assert.equal(result.errorDetails[0].constraint,'Receipt_scope_check');assert.equal(result.errorDetails[0].state,'RECONCILE_REQUIRED');assert.doesNotMatch(JSON.stringify(result),/secret-row/);
 }finally{work.claimDomainWorkBatch=original.claim;work.failDomainWorkClaim=original.fail;receipts.processPage=original.page;}
});
test('wrapped projection failure retains its specific code and original database classification',async()=>{
 const original={claim:work.claimDomainWorkBatch,fail:work.failDomainWorkClaim,page:receipts.processPage};let selected=0;
 try{
  work.claimDomainWorkBatch=async()=>({ownerToken:'private-lease',items:selected++===0?[{id:'work',workClass:'NOTIFICATION_FACT_RECEIPTS',objectId:'job',creatorId:'creator'}]:[]});
  const inner=Object.assign(Error('private-query-and-row'),{code:'P2010',meta:{code:'40001'}});
  receipts.processPage=async()=>{throw Object.assign(new Error('NOTIFICATION_BUMP_PROJECTION_FAILED:P2010',{cause:inner}),{code:'NOTIFICATION_BUMP_PROJECTION_FAILED:P2010'});};
  work.failDomainWorkClaim=async()=>({lost:false,state:'READY',consecutiveFailures:1});
  const result=await service.runNotificationConsequenceSweep({db:{$queryRawUnsafe:async()=>[]},limit:3});
  assert.equal(result.reason,'NOTIFICATION_BUMP_PROJECTION_FAILED:P2010');
  assert.equal(result.errorDetails[0].causeCode,'P2010');assert.equal(result.errorDetails[0].databaseCode,'40001');
  assert.doesNotMatch(JSON.stringify(result),/private-query|private-lease/);
 }finally{work.claimDomainWorkBatch=original.claim;work.failDomainWorkClaim=original.fail;receipts.processPage=original.page;}
});
