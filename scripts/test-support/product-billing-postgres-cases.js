"use strict";
const assert=require('node:assert/strict');
module.exports=async function productBillingCases({db,check,member}) {
 const access=require('../../src/services/billing-execution-access-service');
 const writes=require('../../src/services/programmatic-of-write-authority-service');
 const product=require('../../src/services/product-billing-context-service');
 const admin=require('../../src/services/admin-billing-read-service');
 const {readCommercialPolicy}=require('../../src/services/billing-commercial-policy-service');
 const input={agencyId:'a',creatorId:'write-programmatic',userId:'owner',deviceId:'device',memberId:member.id,accessEpoch:member.accessEpoch,kind:'VAULT_CREATE_LIST',idempotencyKey:'vault-create-list:write-programmatic:readback-proof',payloadFingerprint:'readback-proof'};
 await db.creatorBillingEntitlement.update({where:{creatorId:input.creatorId},data:{coreValidUntil:new Date(Date.now()+86400000)}});
 const reserved=await writes.reserveProgrammaticWrite(input);
 const lease={...input,writeId:reserved.delivery.id,leaseToken:reserved.lease.token,leaseRevision:reserved.lease.revision};
 await writes.startProgrammaticWrite(lease); const commit=await writes.prepareProgrammaticWrite(lease);
 const actor={...input,member,capability:'read',operation:'vault.lists',operationReadback:{deliveryId:lease.writeId,leaseToken:lease.leaseToken,leaseRevision:lease.leaseRevision,writeCommitRevision:commit.writeCommitRevision},physicalRequest:{method:'GET',path:'/api2/v2/vault/lists?view=main&limit=200&offset=0'}};
 await check('exact committed readback survives hold; normal read and another target remain denied',async()=>{
  await db.agency.update({where:{id:'a'},data:{billingSupportHold:true}});
  const result=await access.assertProviderBillingAccess({db,...actor});assert.equal(result.reason,'OPERATION_READBACK');
  await assert.rejects(access.assertProviderBillingAccess({db,...actor,operationReadback:null}),{code:'BILLING_ACCESS_HELD'});
  for(const patch of [{operation:'chats.list'},{capability:'write'},{deviceId:'other'},{member:{...member,accessEpoch:member.accessEpoch+1}},{physicalRequest:{method:'GET',path:'/api2/v2/vault/lists?view=main&limit=201'}},{creatorId:'write-paid'}]) await assert.rejects(access.assertProviderBillingAccess({db,...actor,...patch}),{code:'BILLING_READBACK_INVALID'});
 });
 await check('readback rejects stale token/revision, future or historical commit and terminal operation',async()=>{
  for(const patch of [{leaseToken:'wrong'},{leaseRevision:lease.leaseRevision+1},{writeCommitRevision:commit.writeCommitRevision+1}]) await assert.rejects(access.assertProviderBillingAccess({db,...actor,operationReadback:{...actor.operationReadback,...patch}}),{code:'BILLING_READBACK_INVALID'});
  const original=await db.automationDelivery.findUnique({where:{id:lease.writeId}});
  for(const data of [{writeCommitAt:new Date(Date.now()-31*60000)},{writeCommitAt:new Date(Date.now()+60000)},{status:'COMPLETED'},{claimUntil:new Date(Date.now()-1000)}]) {
   await db.automationDelivery.update({where:{id:lease.writeId},data});
   await assert.rejects(access.assertProviderBillingAccess({db,...actor}),{code:'BILLING_READBACK_INVALID'});
   await db.automationDelivery.update({where:{id:lease.writeId},data:{writeCommitAt:original.writeCommitAt,status:original.status,claimUntil:original.claimUntil}});
  }
  await writes.completeProgrammaticWrite({...lease,result:{folderId:'readback-proof'}});
  await db.agency.update({where:{id:'a'},data:{billingSupportHold:false}});
 });
 await check('product scope filters current paid facts, future and foreign grants, while receipts retain membership scope',async()=>{
  const scope={broad:true,creatorIds:[]};
  const result=await product.withProductBilling('a',()=>product.productBillingScope({db,agencyId:'a',scope}));
  assert.equal(result.broad,false);assert.ok(result.creatorIds.includes('write-programmatic'));
  assert.equal(result.creatorIds.includes('foreign'),false);assert.equal(result.creatorIds.includes('future'),false);assert.equal(result.creatorIds.includes('write-unpaid'),false);
  assert.strictEqual(await product.productBillingScope({db,agencyId:'a',scope}),scope);
  await db.agency.update({where:{id:'a'},data:{billingSupportHold:true}});
  assert.deepEqual((await product.withProductBilling('a',()=>product.productBillingScope({db,agencyId:'a',scope}))).creatorIds,[]);
  await db.agency.update({where:{id:'a'},data:{billingSupportHold:false}});
 });
 await check('admin aggregates equal current line facts and ignore historical billing projection state',async()=>{
  const policy=await readCommercialPolicy({db}),now=new Date();
  const totals=await admin.readAgencyBillingTotals({db,agencyIds:['a','b'],policy,now});
  assert.equal(totals.get('a').modelsTotal,await db.creatorAccount.count({where:{agencyId:'a',deletedAt:null}}));
  assert.equal(totals.get('b').monthlyCents,0,'cross-agency entitlement excluded');
  const global=await admin.readGlobalBillingTotals({db,policy,now});assert.equal(global.totalAgencies,2);
  assert.equal(global.billedCents,totals.get('a').monthlyCents);
 });
 await check('online execution indexes are valid, definition-exact and idempotently reusable after all migrations',async()=>{
  await db.$executeRawUnsafe('DROP INDEX "AutomationDelivery_fair_claim_idx"');
  await require('../database/phase4-execution-indexes-online-preflight').ensureIndexes(db);
  await require('../database/phase4-execution-indexes-online-preflight').ensureIndexes(db);
 });
 await check('lease maintenance drains bounded pages rather than imposing a 10000-row horizon',async()=>{
  await db.automationDelivery.createMany({data:Array.from({length:215},(_,n)=>({id:`bounded-${n}`,agencyId:'a',creatorId:`scale-${n+1}`,originKind:'AUTOMATION',moduleKey:'billing_proof',actionType:'BILLING_PROOF',status:'CLAIMED',attempts:1,maxAttempts:1,claimUntil:new Date(Date.now()-60000)}))});
  const service=require('../../src/services/automation-action-delivery-service');
  const counts=[];for(let n=0;n<3;n++) counts.push(await service.sweepExpiredAutomationLeases({db,agencyId:'a',creatorIds:Array.from({length:215},(_,n)=>`scale-${n+1}`),now:new Date()}));
  assert.deepEqual(counts,[100,100,15]);assert.equal(await db.automationDelivery.count({where:{id:{startsWith:'bounded-'},status:'CLAIMED'}}),0);
 });
 await check('120 busy high-priority creators do not hide an eligible creator; fairness probes index history',async()=>{
  await db.$executeRawUnsafe(`INSERT INTO "AutomationDelivery" ("id","agencyId","creatorId","originKind","moduleKey","actionType","status","claimUntil","updatedAt")
    SELECT 'busy-'||n,'a','scale-'||n,'AUTOMATION','billing_proof','BILLING_PROOF','RUNNING',now()+interval '1 hour',now() FROM generate_series(216,335) n`);
  await db.$executeRawUnsafe(`INSERT INTO "AutomationDelivery" ("id","agencyId","creatorId","originKind","moduleKey","actionType","status","priority","notBefore","updatedAt")
    SELECT 'pending-'||n,'a','scale-'||n,'AUTOMATION','billing_proof','BILLING_PROOF','QUEUED',CASE WHEN n=336 THEN 1 ELSE 999 END,now()-interval '1 hour',now() FROM generate_series(216,336) n`);
  await db.$executeRawUnsafe(`INSERT INTO "AutomationDelivery" ("id","agencyId","creatorId","originKind","moduleKey","actionType","status","claimedAt","finishedAt","updatedAt")
    SELECT 'history-'||n,'a','scale-336','AUTOMATION','billing_proof','BILLING_PROOF','COMPLETED',now()-interval '2 hour',now()-interval '1 hour',now() FROM generate_series(1,10000) n`);
  await db.$executeRawUnsafe('ANALYZE "AutomationDelivery"');
  const ids=Array.from({length:121},(_,n)=>`scale-${216+n}`),args=['a',ids,['BILLING_PROOF'],new Date(),ids];
  const rows=await db.$queryRawUnsafe(require('../../src/services/automation-action-delivery-service').ACTION_FAIR_CANDIDATES_SQL,...args);assert.deepEqual(rows.map(r=>r.id),['pending-336']);
  const plan=await db.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+require('../../src/services/automation-action-delivery-service').ACTION_FAIR_CANDIDATES_SQL,...args);
  const text=JSON.stringify(plan);assert.match(text,/AutomationDelivery_fair_finish_idx/);assert.match(text,/AutomationDelivery_fair_claim_idx/);
  function inspect(value) { if (!value || typeof value!=='object') return;
    if(value['Relation Name']==='AutomationDelivery') assert.notEqual(value['Node Type'],'Seq Scan','no all-history scan');
    for(const child of Object.values(value)) inspect(child);
  } inspect(plan);
  if(process.env.PHASE4_PROOF_OUTPUT) require('node:fs').writeFileSync(require('node:path').join(process.env.PHASE4_PROOF_OUTPUT,'fairness-explain.json'),JSON.stringify(plan,null,2));
 });
 await check('creator catalog keyset traversal returns all models beyond the old 10000 horizon',async()=>{
  await db.$executeRawUnsafe(`INSERT INTO "CreatorAccount" ("id","agencyId","displayName","updatedAt") SELECT 'catalog-'||n,'a','Catalog',now() FROM generate_series(1,10005) n`);
  const rows=await require('../../src/services/desktop-bootstrap-service').listAccessibleCreatorRows({db,agencyId:'a',member});
  assert.equal(rows.length,await db.creatorAccount.count({where:{agencyId:'a',deletedAt:null}}));
  assert.equal(new Set(rows.map(c=>c.id)).size,rows.length);assert.ok(rows.some(c=>c.id==='catalog-10005'));assert.ok(rows.length>11000);
 });

};
