'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
const {fixture,scope}=require('./fixture.cjs');
const results=[];
const historyRows=Number(process.env.ONLINOD_EXTERNAL_HISTORY_ROWS||200000);
assert.ok(Number.isSafeInteger(historyRows)&&historyRows>=1000&&historyRows<=200000);
async function check(name,fn){await fn();results.push({name,passed:true});console.log('PASS',name);}
(async()=>{
 const f=await fixture();
 try {
  const {db}=f;await scope(db);
  await db.workerDevice.create({data:{id:'qa-device',agencyId:'qa-agency',userId:'qa-user'}});
  const actor={db,agencyId:'qa-agency',creatorId:'qa-creator',userId:'qa-user',memberId:'member-qa-agency',deviceId:'qa-device',accessEpoch:1};
  await db.$executeRawUnsafe(`INSERT INTO "AutomationDelivery"("id","agencyId","creatorId","actionType","status","remoteLifecycleState","remoteTargetId","remoteLifecycleObservedAt","remoteSettledAt","intentAcknowledgedAt","updatedAt") SELECT 'old-'||g,'qa-agency','qa-creator','MASS_QUEUE_CREATE','COMPLETED','SETTLED','old-queue-'||g,'2026-01-01'::timestamp,'2026-01-01'::timestamp,'2026-01-01'::timestamp,'2026-01-01'::timestamp FROM generate_series(1,${historyRows})g`);
  await check('deployment verifies physical guards and index before runtime admission',async()=>{assert.equal((await require(f.root+'/src/services/external-delivery-runtime-contract').verifyExternalDeliveryRuntime({db})).guards,5);});
  const api=require(f.root+'/src/services/mass-queue-observation-service'),retire=require(f.root+'/src/services/mass-campaign-authority-service');
  const begin=(purpose='BROWSE',more={})=>api.beginMassRemoteQueueSnapshot({...actor,protocol:'MASS_OBSERVATION_V2',snapshotRequestId:crypto.randomUUID(),purpose,...more});
  const upload=(snap,ids=[],more={})=>api.appendMassRemoteQueueSnapshot({...actor,purpose:snap.purpose,snapshotFenceToken:snap.snapshotFenceToken,page:0,queueIds:ids,snapshotItemCount:ids.length,final:true,...more});
  const step=snap=>api.reconcileMassRemoteQueueSnapshot({...actor,purpose:snap.purpose,snapshotFenceToken:snap.snapshotFenceToken});
  async function apply(snap){let out,n=0;do{out=await step(snap);assert(++n<500);}while(!out.applied);return out;}
  async function observe(ids=[],purpose='BROWSE'){const snap=await begin(purpose);await upload(snap,ids);return {snap,out:await apply(snap)};}
  const raw=async(id,data={})=>require(f.root+'/src/services/db-transaction-service').runDbTransaction(db,tx=>tx.automationDelivery.create({data:{id,agencyId:actor.agencyId,creatorId:actor.creatorId,actionType:'MASS_NATIVE_QUEUE_CREATE',originKind:'INTERACTIVE',status:'COMPLETED',intentAcknowledgedAt:new Date(),remoteLifecycleState:'PENDING',remoteTargetId:id,remoteLifecycleObservedAt:new Date(),...data}}));
  await check('legacy protocol refuses unsafe process-local fence',async()=>{await assert.rejects(api.beginMassRemoteQueueSnapshot({...actor}),{code:'MASS_QUEUE_SNAPSHOT_CLIENT_UPGRADE_REQUIRED'});});
  await check('begin identity is durable and replay-idempotent',async()=>{const id=crypto.randomUUID(),a=await begin('BROWSE',{snapshotRequestId:id}),b=await begin('BROWSE',{snapshotRequestId:id});assert.deepEqual(a,b);});
  await check('wrong purpose cannot consume the valid session',async()=>{const s=await begin();await assert.rejects(upload({...s,purpose:'RETIREMENT'}),{code:'MASS_QUEUE_SNAPSHOT_FENCE_MISMATCH'});await upload(s);await apply(s);});
  await check('page digest conflict and exact replay',async()=>{const s=await begin();await upload(s,['one']);assert.equal((await upload(s,['one'])).duplicate,true);await assert.rejects(upload(s,['two']),{code:'MASS_QUEUE_SNAPSHOT_REPLAY_CONFLICT'});await apply(s);});
  await check('empty refresh touches current debt and preserves settled history timestamps',async()=>{const out=await observe();assert.equal(out.out.settled,1);const [r]=await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AutomationDelivery" WHERE "id" LIKE 'old-%' AND "remoteSettledAt"='2026-01-01'::timestamp`);assert.equal(r.n,historyRows);});
  await check('provider reappearance reopens one observed identity',async()=>{await observe(['one']);await observe([]);await observe(['one']);const found=await db.automationDelivery.findMany({where:{actionType:'MASS_PROVIDER_QUEUE_OBSERVED',remoteTargetId:'one'}});assert.equal(found.length,1);assert.equal(found[0].remoteLifecycleState,'PENDING');await observe([]);});
  await check('later admitted state supersedes an older observation',async()=>{const s=await begin();await raw('new-queue');await assert.rejects(upload(s),{code:'MASS_QUEUE_SNAPSHOT_SUPERSEDED'});assert.equal((await db.automationDelivery.findUnique({where:{id:'new-queue'}})).remoteLifecycleState,'PENDING');await observe([]);});
  await check('late publication cannot manufacture fresh retirement evidence',async()=>{const s=await begin('RETIREMENT');await db.$executeRawUnsafe(`UPDATE "MassQueueObservation" SET "fenceAt"="fenceAt"-interval '55 minutes' WHERE "id"=$1`,s.snapshotFenceToken);await assert.rejects(upload(s),{code:'MASS_QUEUE_SNAPSHOT_OBSERVATION_STALE'});await api.releaseMassRetirement({...actor,retirementId:s.retirementId});});
  await check('expiry checked inside transaction after scope admission',async()=>{const s=await begin();await db.$executeRawUnsafe(`UPDATE "MassQueueObservation" SET "expiresAt"=clock_timestamp() AT TIME ZONE 'UTC'-interval '1 minute' WHERE "id"=$1`,s.snapshotFenceToken);await assert.rejects(upload(s),{code:'MASS_QUEUE_SNAPSHOT_FENCE_EXPIRED'});});
  await check('retirement proves empty state and physically blocks new native/programmatic CREATE',async()=>{const {snap,out}=await observe([],'RETIREMENT');assert.equal(out.retirementProven,true);assert.equal(out.observedAt,snap.fenceAt);await retire.assertCreatorMassCampaignRetirable({...actor});await assert.rejects(raw('forbidden-create'),e=>String(e.message).includes('MASS_CREATOR_RETIREMENT_IN_PROGRESS'));await db.$disconnect();await db.$connect();assert.equal((await step(snap)).duplicate,true);await api.releaseMassRetirement({...actor,retirementId:snap.retirementId});await assert.rejects(retire.assertCreatorMassCampaignRetirable({...actor}),{code:'CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED'});});
  await check('source revision catches mutation between bounded apply pages',async()=>{const s=await begin();await upload(s,['batch-a','batch-b']);const first=await step(s);assert.equal(first.applied,false);await raw('during-apply');await assert.rejects(step(s),{code:'MASS_QUEUE_SNAPSHOT_SUPERSEDED'});await observe([]);});
  await check('terminal UNKNOWN logical result is preserved when empty observation drains remote debt',async()=>{await raw('unknown',{status:'FAILED',failureCode:'outcome_unresolved_do_not_retry',remoteLifecycleState:'UNKNOWN',remoteTargetId:null,result:{outcomeState:'UNRESOLVED_DO_NOT_RETRY'}});await observe([]);const r=await db.automationDelivery.findUnique({where:{id:'unknown'}});assert.equal(r.status,'FAILED');assert.equal(r.result.outcomeState,'UNRESOLVED_DO_NOT_RETRY');assert.equal(r.remoteLifecycleState,'SETTLED');});
  await check('unresolved cancel settles only with an exact absent target',async()=>{await raw('cancel-absent',{actionType:'MASS_NATIVE_QUEUE_CANCEL',targetId:'absent',remoteTargetId:null,status:'COMMITTING',writeCommitAt:new Date()});await observe([]);assert.equal((await db.automationDelivery.findUnique({where:{id:'cancel-absent'}})).status,'COMPLETED');});
  await check('current debt cannot be purged by historical cleanup',async()=>{await raw('not-deletable');await assert.rejects(db.automationDelivery.delete({where:{id:'not-deletable'}}),e=>String(e.message).includes('MASS_CURRENT_DEBT_NOT_DELETABLE'));await db.$disconnect();await db.$connect();await observe([]);await db.automationDelivery.delete({where:{id:'not-deletable'}});});
  await check('large observation is uploaded and applied in bounded transactions',async()=>{const ids=Array.from({length:1201},(_,i)=>'q'+String(i).padStart(5,'0')),s=await begin();for(let page=0;page<3;page++)await upload(s,ids.slice(page*500,(page+1)*500),{page,final:page===2,snapshotItemCount:ids.length});const out=await apply(s);assert.equal(out.pending,1201);assert.equal(out.remainingDebt,1201);await observe([]);});
  const tx=fn=>require(f.root+'/src/services/db-transaction-service').runDbTransaction(db,async t=>{await t.$queryRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true),set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");return fn(t);});
  const reconnect=async()=>{await db.$disconnect();await db.$connect();};
  await check('retirement ownership is stable; a second observer cannot auto-release the first hold',async()=>{
    const a=await begin('RETIREMENT'),b=await begin('RETIREMENT');assert.equal(a.retirementCreated,true);assert.equal(b.retirementCreated,false);assert.equal(a.retirementId,b.retirementId);
    assert.equal((await api.releaseMassRetirement({...actor,retirementId:a.retirementId,abortOwnPreparation:true})).released,false);
    await assert.rejects(api.releaseMassRetirement({...actor,retirementId:crypto.randomUUID()}),{code:'MASS_RETIREMENT_CHANGED'});
    await api.releaseMassRetirement({...actor,retirementId:a.retirementId});await assert.rejects(upload(b),{code:'MASS_QUEUE_SNAPSHOT_SUPERSEDED'});
  });
  await check('incomplete and overlapping pages cannot become an empty proof; BROWSE never prepares retirement',async()=>{
    const snap=await begin();await assert.rejects(upload(snap,[],{snapshotItemCount:1}),{code:'MASS_QUEUE_SNAPSHOT_IDENTITY_INCOMPLETE'});
    await assert.rejects(upload(snap,['same','same']),{code:'MASS_QUEUE_SNAPSHOT_PAGE_INVALID'});await upload(snap);await apply(snap);
    assert.equal(await retire.creatorMassProviderSnapshotProof(actor),null);
  });
  await check('device, actor and epoch are rechecked on every durable page',async()=>{
    const snap=await begin();
    await db.workerDevice.create({data:{id:'qa-device-2',agencyId:actor.agencyId,userId:actor.userId}});
    await assert.rejects(upload(snap,[],{deviceId:'qa-device-2'}),{code:'MASS_QUEUE_SNAPSHOT_FENCE_MISMATCH'});
    await assert.rejects(upload(snap,[],{accessEpoch:2}));
    await scope(db,{agencyId:'other',creatorId:'other-creator',userId:'other-user'});
    await assert.rejects(upload(snap,[],{agencyId:'other',creatorId:'other-creator',userId:'other-user',memberId:'member-other'}));
    await upload(snap);await apply(snap);
  });
  await check('transaction rollback preserves the page cursor, membership and revision; module reload replays',async()=>{
    const snap=await begin();await upload(snap,['rollback-queue']);
    const [before]=await db.$queryRawUnsafe('SELECT * FROM "MassQueueObservation" WHERE id=$1',snap.snapshotFenceToken);
    const broken={$transaction:(fn,options)=>db.$transaction(async t=>{await fn(t);throw Error('controlled rollback');},options)};
    await assert.rejects(api.reconcileMassRemoteQueueSnapshot({...actor,db:broken,purpose:snap.purpose,snapshotFenceToken:snap.snapshotFenceToken}),/controlled rollback/);
    const [after]=await db.$queryRawUnsafe('SELECT * FROM "MassQueueObservation" WHERE id=$1',snap.snapshotFenceToken);assert.deepEqual(after,before);
    delete require.cache[require.resolve(f.root+'/src/services/mass-queue-observation-service')];
    const restarted=require(f.root+'/src/services/mass-queue-observation-service');await restarted.reconcileMassRemoteQueueSnapshot({...actor,purpose:snap.purpose,snapshotFenceToken:snap.snapshotFenceToken});await apply(snap);await observe([]);
  });
  await check('newer applied observation excludes the older identical-revision empty observation',async()=>{
    const old=await begin(),newer=await begin();await upload(old);await upload(newer);await apply(newer);await assert.rejects(step(old),{code:'MASS_QUEUE_SNAPSHOT_SUPERSEDED'});
  });
  await check('retirement read capability is bound to exact GET and current actor without a subscription',async()=>{
    const snap=await begin('RETIREMENT'),member=await db.agencyMember.findUnique({where:{id:actor.memberId}});
    const input={...actor,member,capability:'read',operation:'messages.queue.list',retirementSnapshot:{snapshotFenceToken:snap.snapshotFenceToken},physicalRequest:{method:'GET',path:'/api2/v2/messages/queue?limit=100&offset=0'}};
    assert.equal((await api.assertMassRetirementRead(input)).allowed,true);
    const billing=require(f.root+'/src/services/billing-execution-access-service');
    assert.equal((await billing.assertProviderBillingAccess(input)).allowed,true);
    for(const change of [{creatorId:'other-creator'},{deviceId:'qa-device-2'},{capability:'write'},
      {physicalRequest:{method:'POST',path:'/api2/v2/messages/queue?limit=100&offset=0'}},
      {physicalRequest:{method:'GET',path:'/api2/v2/messages/queue?limit=100&offset=0&filter=x'}},
      {member:{...member,accessEpoch:member.accessEpoch+1}}]) await assert.rejects(api.assertMassRetirementRead({...input,...change}),{code:'MASS_RETIREMENT_READ_INVALID'});
    await upload(snap);await assert.rejects(api.assertMassRetirementRead(input),{code:'MASS_RETIREMENT_READ_INVALID'});
    await apply(snap);const state=await api.listMassRetirementState(actor);assert.equal(state.canManage,true);assert.equal(state.creators.find(c=>c.creatorId===actor.creatorId).prepared,true);
    await api.releaseMassRetirement({...actor,retirementId:snap.retirementId});
  });
  await check('physical creator and agency delete/soft-retire require proof even for an old caller',async()=>{
    for(const sql of [`UPDATE "CreatorAccount" SET "deletedAt"=now() WHERE id='qa-creator'`,`DELETE FROM "CreatorAccount" WHERE id='qa-creator'`,`UPDATE "Agency" SET "deletedAt"=now() WHERE id='qa-agency'`]){
      await assert.rejects(tx(t=>t.$executeRawUnsafe(sql)),e=>/MASS_.*RETIREMENT|MASS_PROVIDER_SNAPSHOT/.test(e.message));await reconnect();
    }
    const {snap}=await observe([],'RETIREMENT');await retire.assertAgencyMassCampaignRetirable({db,agencyId:actor.agencyId});
    await tx(t=>t.$executeRawUnsafe(`UPDATE "CreatorAccount" SET "remoteId"='changed' WHERE id='qa-creator'`));
    await assert.rejects(retire.assertCreatorMassCampaignRetirable(actor),{code:'CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED'});
    await tx(t=>t.$executeRawUnsafe(`UPDATE "CreatorAccount" SET "remoteId"='qa-creator' WHERE id='qa-creator'`));await api.releaseMassRetirement({...actor,retirementId:snap.retirementId});
  });
  await check('partial retention tombstones observation before deleting its first500 memberships',async()=>{
    const snap=await begin(),ids=Array.from({length:501},(_,i)=>'ret'+String(i).padStart(4,'0'));
    await upload(snap,ids.slice(0,500),{final:false,snapshotItemCount:501});await upload(snap,ids.slice(500),{page:1,final:true,snapshotItemCount:501});
    await db.$executeRawUnsafe(`UPDATE "MassQueueObservation" SET "retainUntil"=now()-interval '8 days' WHERE id=$1`,snap.snapshotFenceToken);
    const out=await api.runMassObservationRetention({db});assert.equal(out.items,500);assert.equal(out.done,0);
    await assert.rejects(step(snap),{code:'MASS_QUEUE_SNAPSHOT_FENCE_EXPIRED'});assert.equal((await api.runMassObservationRetention({db})).done,1);
  });
  await check('logical MASS exact receipt survives lease loss and UNKNOWN; replay and wrong binding cannot change it',async()=>{
    const authority=require(f.root+'/src/services/programmatic-of-write-authority-service');
    const token=crypto.randomBytes(32).toString('hex');
    await raw('logical-receipt',{actionType:'MASS_QUEUE_CREATE',status:'FAILED',failureCode:'outcome_unresolved_do_not_retry',remoteLifecycleState:'UNKNOWN',remoteTargetId:null,writeCommitAt:new Date(),writeCommitRevision:3,idempotencyKey:'mass:qa-creator:receipt',
      result:{programmaticWriteKind:'MASS_QUEUE_CREATE',massSettlementTokenHash:crypto.createHash('sha256').update(token).digest('hex'),massSettlementDeviceId:'qa-device'}});
    const proof={writeId:'logical-receipt',kind:'MASS_QUEUE_CREATE',deviceId:'qa-device',settlementToken:token,requestKey:'mass:qa-creator:receipt',writeCommitRevision:3,queueId:'provider-exact'};
    for(const bad of [{kind:'MASS_QUEUE_CANCEL'},{deviceId:'qa-device-2'},{writeCommitRevision:2},{requestKey:'wrong'},{settlementToken:'bad'}])await assert.rejects(authority.completeMassWriteWithSettlementToken({...proof,...bad}),{code:'MASS_SETTLEMENT_BINDING_INVALID'});
    const held=await observe([],'RETIREMENT');assert.equal(held.out.retirementProven,true);
    await authority.completeMassWriteWithSettlementToken(proof);
    await assert.rejects(retire.assertCreatorMassCampaignRetirable(actor),{code:'CREATOR_HAS_ACTIVE_MASS'});
    await api.releaseMassRetirement({...actor,retirementId:held.snap.retirementId});
    assert.equal((await authority.completeMassWriteWithSettlementToken(proof)).duplicate,true);
    await assert.rejects(authority.completeMassWriteWithSettlementToken({...proof,queueId:'different'}),{code:'MASS_SETTLEMENT_CONFLICT'});
    const row=await db.automationDelivery.findUnique({where:{id:proof.writeId}});assert.equal(row.remoteTargetId,'provider-exact');assert.equal(row.status,'COMPLETED');await observe([]);
  });
  await check('retention partition protects legacy NULL MASS debt and agrees with physical predicate',async()=>{
    const c=require(f.root+'/src/services/mass-delivery-contract');
    const rows=[];for(const actionType of [...c.CREATE_ACTIONS,...c.CANCEL_ACTIONS,'OTHER'])for(const status of [...c.ACTIVE,'COMPLETED','FAILED','CANCELED'])for(const remoteLifecycleState of [null,'PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED','SETTLED'])for(const failureCode of [null,'outcome_unresolved_do_not_retry'])rows.push({actionType,status,remoteLifecycleState,failureCode});
    const matches=await db.$queryRawUnsafe(`SELECT x.*,(${c.CURRENT_PREDICATE}) AS expected FROM jsonb_to_recordset($1::jsonb) AS x("actionType" text,"status" text,"remoteLifecycleState" text,"failureCode" text)`,JSON.stringify(rows));
    for(const row of matches)assert.equal(c.hasMassCurrentDebt(row),row.expected===true);
    const partition=await require(f.root+'/src/services/automation-delivery-hard-delete-guard').partitionAutomationDeliveryHardDeleteCandidates({db,rows:[{actionType:'MASS_QUEUE_CREATE',status:'COMPLETED',remoteLifecycleState:null},{actionType:'MASS_QUEUE_CREATE',status:'COMPLETED',remoteLifecycleState:'SETTLED'}]});assert.equal(partition.protected.length,1);assert.equal(partition.deletable.length,1);
  });
  await check('4000 sequentially prepared creators retain independent proofs; one invalidation blocks only that agency',async()=>{
    await scope(db,{agencyId:'scale',creatorId:'scale-0000',userId:'scale-user'});
    for(let first=1;first<=3999;first+=100)await tx(t=>t.$executeRawUnsafe(`INSERT INTO "CreatorAccount"(id,"agencyId","displayName","remoteId","status","updatedAt") SELECT 'scale-'||lpad(g::text,4,'0'),'scale','Scale','scale-'||lpad(g::text,4,'0'),'READY',now() FROM generate_series($1::int,$2::int)g`,first,Math.min(first+99,3999)));
    await db.$executeRawUnsafe(`INSERT INTO "MassCreatorDeliveryState"("creatorId","agencyId","sourceRevision","retirementId","retirementProofId","retirementProofRevision","retirementProofObservedAt","retirementProviderId") SELECT id,'scale',1,'held:'||id,'proof:'||id,1,now()-(row_number()over(ORDER BY id)*interval '700 milliseconds'),"remoteId" FROM "CreatorAccount" WHERE "agencyId"='scale'`);
    await retire.assertAgencyMassCampaignRetirable({db,agencyId:'scale'});
    await db.$executeRawUnsafe(`UPDATE "MassCreatorDeliveryState" SET "sourceRevision"=2 WHERE "creatorId"='scale-2000'`);
    await assert.rejects(retire.assertAgencyMassCampaignRetirable({db,agencyId:'scale'}),{code:'AGENCY_MASS_PROVIDER_SNAPSHOT_REQUIRED'});
    const {snap}=await observe([],'RETIREMENT');await retire.assertAgencyMassCampaignRetirable({db,agencyId:actor.agencyId});await api.releaseMassRetirement({...actor,retirementId:snap.retirementId});
  });
  await check('never-connected draft can retire without a provider observation',async()=>{
    await scope(db,{agencyId:'draft-agency',creatorId:'draft-creator',userId:'draft-user'});
    await tx(t=>t.$executeRawUnsafe(`UPDATE "CreatorAccount" SET "remoteId"=NULL,"status"='DRAFT' WHERE id='draft-creator'`));
    await retire.assertCreatorMassCampaignRetirable({db,agencyId:'draft-agency',creatorId:'draft-creator'});
    await tx(t=>t.$executeRawUnsafe(`UPDATE "CreatorAccount" SET "deletedAt"=now() WHERE id='draft-creator'`));
  });
  await check('prepared agency retires and creator cleanup cascades observation state',async()=>{
    await db.workerDevice.create({data:{id:'other-device',agencyId:'other',userId:'other-user'}});
    const owner={db,agencyId:'other',creatorId:'other-creator',userId:'other-user',memberId:'member-other',deviceId:'other-device',accessEpoch:1};
    const snap=await api.beginMassRemoteQueueSnapshot({...owner,protocol:'MASS_OBSERVATION_V2',snapshotRequestId:crypto.randomUUID(),purpose:'RETIREMENT'});
    await api.appendMassRemoteQueueSnapshot({...owner,purpose:snap.purpose,snapshotFenceToken:snap.snapshotFenceToken,page:0,queueIds:[],snapshotItemCount:0,final:true});
    let out;do{out=await api.reconcileMassRemoteQueueSnapshot({...owner,purpose:snap.purpose,snapshotFenceToken:snap.snapshotFenceToken});}while(!out.applied);
    assert.equal(out.retirementProven,true);
    await tx(t=>t.$executeRawUnsafe(`UPDATE "Agency" SET "deletedAt"=now() WHERE id='other'`));
    // Phase2 retires the agency first, then cleans each creator before the final
    // agency identity. Direct live Agency DELETE is intentionally not this path.
    await tx(t=>t.$executeRawUnsafe(`DELETE FROM "CreatorAccount" WHERE id='other-creator'`));
    assert.equal(await db.creatorAccount.findUnique({where:{id:'other-creator'}}),null);
    const [remaining]=await db.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "MassCreatorDeliveryState" WHERE "agencyId"='other')::int AS states,(SELECT count(*) FROM "MassQueueObservation" WHERE "agencyId"='other')::int AS observations`);
    assert.deepEqual(remaining,{states:0,observations:0});
  });
  await check('Telegram physical guard blocks old/retiring new sends but preserves accepted confirmation',async()=>{
    await db.agencyTelegramMtprotoAccount.create({data:{id:'qa-tg',agencyId:actor.agencyId,apiId:1,encryptedPayload:'fixture',iv:'fixture',tag:'fixture'}});
    await db.telegramDeliveryIntent.create({data:{id:'qa-tg-send',agencyId:actor.agencyId,creatorId:actor.creatorId,customOrderId:'fixture-order',accountId:'qa-tg',kind:'TASK',logicalKey:'qa-tg-send',payloadFingerprint:'fixture',state:'CLAIMED',claimRevision:1}});
    const begin=async(generation=true)=>tx(async t=>{
      if(generation)await t.$queryRawUnsafe("SELECT set_config('onlinod.telegram_send_generation','external_delivery_v2',true)");
      return t.telegramDeliveryIntent.update({where:{id:'qa-tg-send'},data:{state:'COMMITTING',commitStartedAt:new Date()}});
    });
    await assert.rejects(begin(false),e=>e.message.includes('TELEGRAM_SEND_RUNTIME_UPGRADE_REQUIRED'));await reconnect();
    await db.agencyTelegramMtprotoAccount.update({where:{id:'qa-tg'},data:{lifecycleState:'RETIRING'}});
    await assert.rejects(begin(),e=>e.message.includes('TELEGRAM_EXECUTION_NEW_SEND_FORBIDDEN'));await reconnect();
    await db.agencyTelegramMtprotoAccount.update({where:{id:'qa-tg'},data:{lifecycleState:'ACTIVE'}});await begin();
    await db.agencyTelegramMtprotoAccount.update({where:{id:'qa-tg'},data:{lifecycleState:'RETIRING'}});
    await tx(t=>t.telegramDeliveryIntent.update({where:{id:'qa-tg-send'},data:{state:'CONFIRMED',remoteMessageId:42,confirmedAt:new Date()}}));
    await assert.rejects(begin(),e=>e.message.includes('TELEGRAM_SEND_REPLAY_NOT_ALLOWED'));await reconnect();
  });
  await check(`current-debt plan avoids${historyRows} settled history rows`,async()=>{
    await raw('scale-current');await db.$executeRawUnsafe('ANALYZE "AutomationDelivery"');
    const predicate=require(f.root+'/src/services/mass-delivery-contract').CURRENT_PREDICATE;
    const plan=await db.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM "AutomationDelivery" WHERE ${predicate} AND "agencyId"=$1 AND "creatorId"=$2 AND id>$3 ORDER BY id LIMIT 500`,actor.agencyId,actor.creatorId,'');
    const text=JSON.stringify(plan);assert.match(text,/AutomationDelivery_mass_current_v2_idx/);assert.doesNotMatch(text,/Seq Scan/);if(process.env.ONLINOD_PROOF_OUTPUT)fs.writeFileSync(require('node:path').join(process.env.ONLINOD_PROOF_OUTPUT,'mass-scale-plan.json'),JSON.stringify(plan,null,2));await observe([]);
  });
  console.log(JSON.stringify({cases:results.length,pass:results.length}));
 } finally {await f.close();if(process.env.ONLINOD_PROOF_OUTPUT)fs.writeFileSync(require('node:path').join(process.env.ONLINOD_PROOF_OUTPUT,'mass-sql-proof.json'),JSON.stringify(results,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
