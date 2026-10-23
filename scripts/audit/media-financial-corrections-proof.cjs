"use strict";
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),{createScaleSqlRuntime}=require('../test-support/scale-sql-runtime.cjs');
const {scope}=require('./analytics-traffic/fixture.cjs'),{runRootCommit}=require(root+'/src/services/db-commit-kernel');
const {hashCanonicalJson}=require(root+'/src/services/realtime-receipt-hash');
const pass=name=>console.log('PASS',name),now=new Date(),capturedAt=now.toISOString();
function source(sourceKey,revision,facts){return {protocolVersion:2,sourceKey,sourceRevision:revision,capturedAt,
 coverage:{version:1,complete:true,localRevision:revision,messageCount:100000,oldestMessageAt:capturedAt,newestMessageAt:capturedAt},facts,
 factPage:{runId:crypto.createHash('sha256').update(JSON.stringify([sourceKey,revision])).digest('hex'),pageNumber:1,previousHash:null,pageHash:hashCanonicalJson(facts),done:true,totalFacts:facts.length}};}
function fact(messageId,mediaId,{sold=true,count=1,index=0,evidence='CANONICAL',legacy=false}={}){return {messageId,mediaId,sentCount:1,soldCount:+sold,notOpenedCount:+!sold,freeCount:0,revenueCents:sold?1000:0,uniqueBuyers:+sold,lastSoldAt:sold?capturedAt:null,...(legacy?{}:{allocationCount:count,allocationIndex:index,purchaseEvidence:evidence})};}
(async()=>{const f=await createScaleSqlRuntime();try{
 const {db}=f,s=await scope(db),own={agencyId:s.agencyId,creatorId:s.creatorId};
 require.cache[require.resolve(root+'/src/prisma')]={exports:db};
 const media=require(root+'/src/services/media-library-service'),projection=require(root+'/src/services/media-financial-projection-service'),feed=require(root+'/src/services/creator-entity-change-service');
 const commit=fn=>runRootCommit(db,({tx})=>fn(tx));
 const key=projection.sourceKey(s.creatorId,'42');
 const submit=(revision,facts)=>media.replaceUsageSources({...own,db,sources:[source(key,revision,facts)]});
 const asset=id=>db.creatorMediaAsset.findUnique({where:{creatorId_mediaId:{creatorId:s.creatorId,mediaId:id}}});
 const read=()=>commit(tx=>feed.readCurrentEntities({db:tx,...own,limit:200}));
 const sale={...own,id:'media-sale-1',eventFingerprint:'a'.repeat(64),externalTransactionId:'media-tx-1',fanOnlyFansUserIdAtEvent:'42',saleType:'MESSAGE',messageId:'11',amountCents:1000,netCents:803,transactionStatus:'done',currency:'USD',purchasedAt:now};
 async function publish(data,creating=false){await commit(async tx=>{await require(root+'/src/services/creator-fact-write-authority').lockCreatorFacts(tx,s.agencyId,s.creatorId);if(creating)await tx.creatorSale.create({data});else await tx.creatorSale.update({where:{id:sale.id},data});await feed.publishCanonicalSales({db:tx,...own,saleIds:[sale.id]});});}
 async function drain(){for(let i=0;i<80;i++){const r=await projection.runSweep({db,limit:8,maxRuntimeMs:10000});assert.equal(r.ok,true,JSON.stringify(r));const pending=await db.domainWorkItem.count({where:{workClass:projection.WORK_CLASS,isOutstanding:true}});if(!pending)return;}throw Error('MEDIA_PROJECTION_NOT_QUIESCENT');}
 await publish(sale,true);await submit('first',[fact('11','a',{count:2,index:0}),fact('11','b',{count:2,index:1})]);await drain();
 await db.creatorMediaAsset.updateMany({where:own,data:{catalogActive:true}});
 assert.equal((await asset('a')).revenueCents,402);assert.equal((await asset('b')).revenueCents,401);
 assert.equal((await media.getMediaSalesSummary({...own,db})).summary.revenueCents,803);
 assert.equal((await media.getMediaSalesSummary({...own,db})).summary.revenueComplete,true);
 const initialHead=(await read()).headRevision;await publish({netCents:803});await drain();assert.equal((await read()).headRevision,initialHead);
 pass('exact verified NET allocation conserves remainder and canonical replay does not echo');
 if(f.native){await Promise.all([publish({netCents:601}),submit('native-overlap',[fact('11','a',{legacy:true})])]);}else await publish({netCents:601});await drain();assert.equal((await asset('a')).revenueCents,301);assert.equal((await asset('b')).revenueCents,300);
 await submit('late171',[fact('11','a',{legacy:true})]);assert.equal((await asset('a')).revenueCents,301);assert.equal((await asset('b')).revenueCents,300);
 await publish({netCents:0,transactionStatus:'undo'});await drain();
 assert.equal((await asset('a')).soldCount,1);assert.equal((await asset('a')).revenueCents,0);
 let current=(await read()).entities.find(row=>row.entityType==='MESSAGE_PURCHASE'&&row.entityId==='42:11');assert.equal(current.tombstone,false);assert.equal(current.payload.opened,true);
 pass('corrected verified NET replaces saved contribution; old partial desktop cannot degrade allocation; refund changes money without unopening');
 await publish({messageId:'12',netCents:900,transactionStatus:'done'});await drain();
 current=(await read()).entities.find(row=>row.entityType==='MESSAGE_PURCHASE'&&row.entityId==='42:11');assert.equal(current.tombstone,true);
 await submit('late-positive171',[fact('11','a',{legacy:true})]);assert.equal((await asset('a')).soldCount,0);assert.equal((await asset('a')).revenueCents,0);
 await submit('independent-provider',[fact('11','a',{evidence:'PROVIDER'}),fact('12','c')]);await drain();await db.creatorMediaAsset.updateMany({where:own,data:{catalogActive:true}});
 assert.equal((await asset('a')).soldCount,1);assert.equal((await asset('a')).revenueUnknownCount,1);assert.equal((await asset('c')).revenueCents,900);
 let summary=(await media.getMediaSalesSummary({...own,db})).summary;assert.equal(summary.revenueCents,900);assert.equal(summary.revenueComplete,false);
 const sales=await media.listMediaSalesAssets({...own,db});assert.equal(sales.items.find(item=>item.mediaId==='a').revenueComplete,false);
 pass('association11→12 withdraws canonical old proof; late171 cannot resurrect it; independent provider purchase remains visibly unknown money');
 // Existing171 rows have no observedPayload or allocation metadata, and old
 // reverse positive11 survives a correction to12. Adoption must repair both.
 const legacySale={...sale,id:'legacy-sale',externalTransactionId:'legacy-tx',eventFingerprint:'b'.repeat(64),messageId:'22',netCents:777,transactionStatus:'done'};
 await commit(async tx=>{await tx.creatorSale.create({data:legacySale});await tx.creatorEarningsLedgerEntry.create({data:{...own,transactionId:'legacy-tx',occurredAt:now,observedAt:now,category:'messages',netCents:0n,status:'undo'}});
  for(const [suffix,messageId,category,status] of [['tip','24','tips','done'],['superseded','25','messages','superseded']]){
   const id='legacy-'+suffix,transactionId='legacy-'+suffix+'-tx';
   await tx.creatorSale.create({data:{...sale,id,externalTransactionId:transactionId,eventFingerprint:crypto.createHash('sha256').update(id).digest('hex'),messageId,transactionStatus:status}});
   await tx.creatorEarningsLedgerEntry.create({data:{...own,transactionId,occurredAt:now,observedAt:now,category,netCents:803n,status:'done'}});
   await feed.publishEntityChanges({db:tx,...own,changes:[{entityType:'MESSAGE_PURCHASE',entityId:'42:'+messageId,sourceIdentity:'CreatorSale:'+id,sourceVersion:'old171',payload:{dialogId:'42',messageId,opened:true,purchasedAt:capturedAt,operationId:transactionId}}]});
  }
  await feed.publishEntityChanges({db:tx,...own,changes:[{entityType:'MESSAGE_PURCHASE',entityId:'42:21',sourceIdentity:'CreatorSale:legacy-sale',sourceVersion:'old171',payload:{dialogId:'42',messageId:'21',opened:true,purchasedAt:capturedAt,operationId:'legacy-tx'}}]});
  await feed.publishEntityChanges({db:tx,...own,changes:[{entityType:'MESSAGE_PURCHASE',entityId:'42:23',sourceIdentity:'CreatorSale:missing-old-sale',sourceVersion:'orphan171',payload:{dialogId:'42',messageId:'23',opened:true,purchasedAt:capturedAt,operationId:'missing-old-tx'}}]});
  for(const [messageId,mediaId]of [['21','old-link'],['22','old-refund'],['23','old-orphan'],['24','old-tip'],['25','old-superseded']]){const payload=fact(messageId,mediaId,{legacy:true}),id='legacy-'+mediaId;
   await tx.creatorMediaAsset.create({data:{...own,id,mediaId,catalogActive:true,sentCount:1,soldCount:1,revenueCents:1000,uniqueBuyers:1}});
   await tx.creatorMediaUsageContribution.create({data:{...own,id:'contrib-'+mediaId,assetId:id,mediaId,sourceKey:key,sourceRevision:'171',sentCount:1,soldCount:1,revenueCents:1000,uniqueBuyers:1,factBaseline:payload}});
   await tx.creatorMediaUsageFact.create({data:{...own,id:'fact-'+mediaId,sourceKey:key,sourceMessageId:messageId,mediaId,payload,purchased:true,sourceRevision:'171'}});
  }
  // Frozen creator boundary emulates installation with nonempty171 data.
  await tx.maintenanceLaneState.update({where:{key:projection.ADOPTION_KEY},data:{completedAt:null,cursor:{upperId:s.creatorId,afterId:''}}});
 });
 await drain();assert.equal((await asset('old-orphan')).soldCount,0);assert.equal((await read()).entities.find(row=>row.entityType==='MESSAGE_PURCHASE'&&row.entityId==='42:23').tombstone,true);assert.equal((await asset('old-link')).soldCount,0);assert.equal((await asset('old-refund')).soldCount,1);assert.equal((await asset('old-refund')).revenueCents,0);
 current=(await read()).entities.find(row=>row.entityType==='MESSAGE_PURCHASE'&&row.entityId==='42:21');assert.equal(current.tombstone,true);
 for(const [messageId,mediaId] of [['24','old-tip'],['25','old-superseded']]){assert.equal((await asset(mediaId)).soldCount,0);assert.equal((await asset(mediaId)).revenueCents,0);assert.equal((await read()).entities.find(row=>row.entityType==='MESSAGE_PURCHASE'&&row.entityId==='42:'+messageId).tombstone,true);}
 await submit('legacy-offline-replay',[fact('21','old-link',{legacy:true}),fact('22','old-refund',{legacy:true}),fact('24','old-tip',{legacy:true}),fact('25','old-superseded',{legacy:true})]);assert.equal((await asset('old-link')).soldCount,0);assert.equal((await asset('old-refund')).revenueCents,0);assert.equal((await asset('old-tip')).soldCount,0);assert.equal((await asset('old-superseded')).soldCount,0);
 pass('nonempty171 adoption uses verified category/NET, never revives superseded Sale→Tip, repairs old reverse association and fences late offline evidence');
 // A message with >one page of media progresses across commits and no page
 // contains a per-fact/per-contribution query loop.
 await publish({messageId:'30',transactionStatus:'done',netCents:10001});
 const many=Array.from({length:1201},(_,index)=>fact('30','bulk-'+String(index).padStart(4,'0'),{count:1201,index}));
 await submit('many',many);await drain();await publish({netCents:0,transactionStatus:'undo'});
 const before=f.queries.length;await drain();const qs=f.queries.slice(before).map(x=>x.query);
 const bulk=await db.creatorMediaAsset.aggregate({where:{...own,mediaId:{startsWith:'bulk-'}},_sum:{revenueCents:true,soldCount:true}});assert.equal(bulk._sum.revenueCents,0);assert.equal(bulk._sum.soldCount,1201);
 assert(!qs.some(q=>/GROUP BY.*mediaId/i.test(q)&&/CreatorMediaUsageContribution/.test(q)),'hot projection cannot rescan all contributions');
 assert(qs.filter(q=>q.includes('UPDATE "CreatorMediaUsageContribution" c SET')).length<=4,'bounded pages must bulk update contributions');
 pass('1201-asset correction spans bounded500-row owner commits without hot all-history recompute');
 // Canonical Team gross correction is independent from verified media NET.
 const team=require(root+'/src/services/team-money-reconciliation-service');
 await db.teamSentMessageLedger.create({data:{agencyId:s.agencyId,accountId:s.creatorId,creatorId:s.creatorId,messageId:'30',dialogId:'42',fanId:'42',memberId:'member-'+s.agencyId,userId:s.userId,source:'manual',localSeed:'media-team-proof',sentAt:now}});
 await publish({transactionStatus:'done',amountCents:1250,netCents:1000});await team.reconcileCreatorSaleToTeam({db,saleId:sale.id});
 let money=await db.teamMoneyAttributionFact.findFirst({where:{creatorSaleId:sale.id}});assert.equal(money.attributionActive,true);
 const rollups=require(root+'/src/services/team-money-rollup-authority-service');await rollups.applyTeamMoneyFactToRollups({db,agencyId:s.agencyId,factId:money.id});
 await publish({transactionStatus:'unverified',netCents:null});await team.reconcileCreatorSaleToTeam({db,saleId:sale.id});money=await db.teamMoneyAttributionFact.findUnique({where:{id:money.id}});assert.equal(money.attributionActive,false);assert.equal(money.financialStatus,'unverified');await rollups.applyTeamMoneyFactToRollups({db,agencyId:s.agencyId,factId:money.id});
 let contribution=await db.teamMoneyRollupContribution.findUnique({where:{sourceFactId:money.id}});assert.equal(contribution.active,false);
 await db.teamProjectionCoverage.create({data:{agencyId:s.agencyId,responseCoverageFrom:new Date('2020-01-01'),dialogCoverageFrom:new Date('2020-01-01')}});
 await db.teamHistoricalAnalyticsCoverage.create({data:{agencyId:s.agencyId,activityCoverageFrom:new Date('2020-01-01'),moneyCoverageFrom:new Date('2020-01-01')}});
 const knownSale={...sale,id:'known-team-sale',externalTransactionId:'known-team-tx',eventFingerprint:'c'.repeat(64),messageId:'31',amountCents:500,netCents:400};
 await db.creatorSale.create({data:knownSale});await db.teamSentMessageLedger.create({data:{agencyId:s.agencyId,accountId:s.creatorId,creatorId:s.creatorId,messageId:'31',dialogId:'42',fanId:'42',memberId:'member-'+s.agencyId,userId:s.userId,source:'manual',localSeed:'known-team-seed',sentAt:now}});
 await team.reconcileCreatorSaleToTeam({db,saleId:knownSale.id});const knownFact=await db.teamMoneyAttributionFact.findFirst({where:{creatorSaleId:knownSale.id}});await rollups.applyTeamMoneyFactToRollups({db,agencyId:s.agencyId,factId:knownFact.id});
 const analytics=require(root+'/src/services/team-analytics-service');let overview=await analytics.buildTeamOverview({agencyId:s.agencyId,allowedCreatorIds:[s.creatorId]});
 assert.equal(overview.projection.historical.families.money.hasUnverifiedFinancialFacts,true);assert.equal(overview.overview.revenueAttributedCents,500);
 await publish({transactionStatus:'done',amountCents:null,netCents:1000});await team.reconcileCreatorSaleToTeam({db,saleId:sale.id});money=await db.teamMoneyAttributionFact.findUnique({where:{id:money.id}});assert.equal(money.financialStatus,'gross_unknown');assert.equal(money.attributionActive,false);
 overview=await analytics.buildTeamOverview({agencyId:s.agencyId,allowedCreatorIds:[s.creatorId]});assert.equal(overview.projection.historical.families.money.hasUnknownGross,true);assert.equal(overview.overview.revenueAttributedCents,500);await drain();assert.equal((await asset('bulk-0000')).revenueCents,1,'exact NET survives unknown gross');
 const none=await analytics.buildTeamOverview({agencyId:s.agencyId,allowedCreatorIds:[]});assert.equal(none.projection.historical.families.money.hasUnknownGross,false);assert.equal(none.projection.historical.families.money.hasUnverifiedFinancialFacts,false);
 const other=await scope(db,{agencyId:'other-agency',creatorId:'other-creator',userId:'other-user'});
 await db.teamProjectionCoverage.create({data:{agencyId:other.agencyId,responseCoverageFrom:now,dialogCoverageFrom:now}});await db.teamHistoricalAnalyticsCoverage.create({data:{agencyId:other.agencyId,activityCoverageFrom:now,moneyCoverageFrom:now}});
 const isolated=await analytics.buildTeamOverview({agencyId:other.agencyId,allowedCreatorIds:[other.creatorId]});assert.equal(isolated.projection.historical.families.money.hasUnknownGross,false);assert.equal(isolated.overview.revenueAttributedCents,0);
 const plan=await commit(async tx=>{await tx.$executeRawUnsafe('SET LOCAL enable_seqscan=off');return tx.$queryRawUnsafe('EXPLAIN SELECT 1 FROM "CreatorMediaUsageSourceState" WHERE "creatorId"=$1 AND "factProtocol"=0 LIMIT 1',s.creatorId);});assert.match(JSON.stringify(plan),/CreatorMediaUsageSourceState_legacy_pending_idx/);
 pass('Team quarantine retracts previous active money; unknown gross never becomes confirmed0; scoped public read exposes partial evidence');
 console.log(JSON.stringify({ok:true,nativePostgres:f.native,engine:f.native?'PostgreSQL':'PGlite',productionAccessed:false}));
 }finally{await f.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
