"use strict";
// Current owner paths, actual predecessor upgrade, and SQL invariants. Synthetic
// provider facts do not establish real-provider semantics or load capacity.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const root = path.resolve(__dirname, "../.."), checks = [];
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => { console.error("FINANCIAL_DISPLAY_PROOF_DEADLINE"); process.exit(2); }, 240000);
const pass = label => { checks.push(label); console.log("PASS", label); };
(async () => {
  const runtime = await createScaleSqlRuntime({ beforeMigration: "20261023000100_financial_display_authority" });
  try {
    const { db } = runtime; require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const commit = fn => require(root + "/src/services/db-commit-kernel").runRootCommit(db, ({ tx }) => fn(tx));
    const now = new Date(Math.floor(Date.now() / 1000) * 1000), day = new Date(now.toISOString().slice(0,10));
    const s = await scope(db, { agencyId: "finance172-agency", creatorId: "finance172-creator", userId: "finance172-user" });
    // Reproduce old171 contamination: published identity is800; failed scan
    // already overwrote canonical row to400 and inserted an extra900 identity.
    await commit(async tx => {
      await require(root + "/src/services/earnings-generation-service").lock(tx,s.creatorId);
      await require(root + "/src/services/creator-fact-write-authority").lockCreatorFacts(tx,s.agencyId,s.creatorId);
      await tx.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerEntry"("agencyId","creatorId","transactionId","occurredAt",category,"netCents",status,"observedAt") VALUES
        ($1,$2,'known',$3,'tips',800,'done',$3),($1,$2,'refunded',$3,'tips',1600,'undo',$3)`,s.agencyId,s.creatorId,now);
      await tx.creatorEarningsLedgerProof.create({ data: { agencyId:s.agencyId,creatorId:s.creatorId,fromAt:day,throughAt:now,generation:"old-verified" } });
      await tx.jobInstance.create({data:{id:"old-financial-job",agencyId:s.agencyId,creatorId:s.creatorId,jobKey:"financial_transactions_scan",scope:"creator",status:"PUBLISHING",params:{collectionGeneration:"old-verified"}}});
      await tx.analyticsPublication.create({data:{id:"old-financial-publication",jobId:"old-financial-job",agencyId:s.agencyId,creatorId:s.creatorId,userId:s.userId,deviceId:"old-device",leaseRevision:1,leaseTokenHash:"old",payloadHash:"old",payload:{scanRunId:"old-verified"},stage:"FINALIZE"}});
      await tx.creatorFinancialCollectionState.create({ data: { agencyId:s.agencyId,creatorId:s.creatorId,status:"PARTIAL",baselineGeneration:"old-verified",baselineVerifiedAt:now,baselineObservedAt:now,baselineRangeFrom:day,baselineRangeTo:now,sourceJobId:"old-financial-job",activeGeneration:"old-verified" } });
      await tx.analyticsPublication.update({where:{id:"old-financial-publication"},data:{state:"COMMITTED",stage:"TERMINAL",completedAt:now}});
      await tx.jobInstance.update({where:{id:"old-financial-job"},data:{status:"DONE",completedAt:now}});
      for (const [id,net] of [["known",400],["extra",900]]) {
        await tx.creatorFinancialTransaction.create({ data: { id:"finance-"+id,agencyId:s.agencyId,creatorId:s.creatorId,externalTransactionId:id,
          transactionType:id==="known"?"message":"tip",factType:id==="known"?"SALE":"TIP",projectionStatus:"PROJECTED",amountCents:1000,netCents:net,transactionStatus:"done",occurredAt:now,sourceUpdatedAt:now } });
        await tx.creatorTip.create({ data: { id:"tip-"+id,agencyId:s.agencyId,creatorId:s.creatorId,eventFingerprint:crypto.createHash("sha256").update("tip-"+id).digest("hex"),externalTransactionId:id,
          amountCents:1000,netCents:net,transactionStatus:"done",tippedAt:now,source:"ONLYFANS_API",sourceUpdatedAt:now } });
      }
      await tx.creatorSale.create({data:{id:"wrong-kind-known",agencyId:s.agencyId,creatorId:s.creatorId,eventFingerprint:crypto.createHash("sha256").update("wrong-kind-known").digest("hex"),
        externalTransactionId:"known",saleType:"MESSAGE",messageId:"wrong-old-message",fanOnlyFansUserIdAtEvent:"42",
        amountCents:1000,netCents:400,transactionStatus:"done",purchasedAt:now,source:"ONLYFANS_API",sourceUpdatedAt:now}});
    });
    for (const migration of require("../test-support/proof-migration-chain.cjs").selectProofMigrations().filter(row => !runtime.migrations.includes(row.migration))) {
      const file = path.join(root,"prisma/migrations",migration.migration,"migration.sql"), sql = fs.readFileSync(file,"utf8");
      assert.equal(crypto.createHash("sha256").update(sql).digest("hex"),migration.checksum);
      if (runtime.engine) await runtime.engine.exec(sql);
      else {
        const url = new URL(runtime.url);
        execFileSync("psql",["--no-psqlrc","--set","ON_ERROR_STOP=1","--file",file],{ env:{...process.env,
          PGHOST:url.hostname,PGPORT:url.port||"5432",PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:url.pathname.slice(1),PGSSLMODE:"disable"},stdio:"pipe" });
      }
      await db.$executeRawUnsafe('INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES($1,$2,$3,now(),1)',crypto.randomUUID(),migration.checksum,migration.migration);
    }
    const display = require(root+"/src/services/published-financial-read-repository");
    const read = () => display.readPublishedFinancialSummary({db,creatorId:s.creatorId,from:day,to:now});
    const before = await read(); assert.equal(before.finance.netCents,800); assert.equal(before.finance.grossCents,null);
    assert.equal(before.finance.transactions,1); assert.equal(before.finance.refundTransactions,1); assert.equal(before.finance.refundNetCents,1600);
    assert.equal(before.finance.refundGrossCents,null);
    pass("actual171 predecessor upgrade backfills fixed status/count aggregates; existing NET800 retained, historical gross stays unknown");
    const facts = require(root+"/src/services/analytics-fact-publication-service"), work = require(root+"/src/services/domain-work-authority-service");
    await commit(async tx=>{await require(root+"/src/services/earnings-generation-service").lock(tx,s.creatorId);
      await tx.creatorEarningsGeneration.create({data:{id:"orphan-build-172",agencyId:s.agencyId,creatorId:s.creatorId,runId:"dead-old-run",state:"BUILDING",fromAt:day,throughAt:now,snapshotAt:now,fullScan:true}});
    });
    await facts.enumerateAdoption({db}); let complete = false;
    for (let i=0;i<20;i++) {
      const claim=await work.claimDomainWorkBatch({db,workClass:facts.ADOPTION_CLASS,limit:1,perAgencyQuantum:1,perPartitionQuantum:1});
      const item=claim.items?.[0]; assert(item,JSON.stringify(claim,(_,v)=>typeof v==="bigint"?v.toString():v));
      const result=await facts.processAdoption({db,item,ownerToken:claim.ownerToken});
      if(result.completed){complete=true;break;}
    }
    assert(complete); assert.equal((await db.creatorEarningsGeneration.findUnique({where:{id:"orphan-build-172"}})).state,"RETIRED");
    const known = await db.creatorFinancialTransaction.findUnique({where:{id:"finance-known"}});
    assert.equal(known.netCents,800); assert.equal(known.amountCents,null); assert.equal(known.reasonCode,"GROSS_UNAVAILABLE");
    assert.equal(known.factType,"TIP");assert.equal(known.transactionType,"tip");
    const knownTip = await db.creatorTip.findUnique({where:{id:"tip-known"}});
    assert.equal(knownTip.netCents,800); assert.equal(knownTip.amountCents,null);
    const wrongKind=await db.creatorSale.findUnique({where:{id:"wrong-kind-known"}});
    assert.equal(wrongKind.transactionStatus,"superseded");assert.equal(wrongKind.netCents,null);assert.equal(wrongKind.amountCents,null);
    assert.equal((await db.creatorMediaSaleLink.findUnique({where:{saleId:wrongKind.id}})).proofActive,false);
    const extra = await db.creatorFinancialTransaction.findUnique({where:{id:"finance-extra"}});
    assert.equal(extra.netCents,null); assert.equal(extra.transactionStatus,"unverified"); assert.equal(extra.reasonCode,"LEGACY_FINANCIAL_UNVERIFIED");
    assert.equal((await db.creatorTip.findUnique({where:{id:"tip-extra"}})).netCents,null);
    assert.equal(await db.creatorMoneyObservation.count({where:{creatorId:s.creatorId,reason:"LEGACY_FINANCIAL_UNVERIFIED"}}),1);
    const request=await db.creatorMoneyResolutionRequest.findUnique({where:{creatorId:s.creatorId}}); assert.equal(request.queued,true);
    await db.creatorMoneyResolutionRequest.update({where:{creatorId:s.creatorId},data:{attempts:3}});
    await commit(async tx=>{await require(root+"/src/services/earnings-generation-service").lock(tx,s.creatorId);await require(root+"/src/services/financial-legacy-repair-service").repairPage({db:tx,...s,now});});
    assert.equal((await db.creatorMoneyResolutionRequest.findUnique({where:{creatorId:s.creatorId}})).attempts,3);
    assert.equal(await db.creatorMoneyObservation.count({where:{creatorId:s.creatorId}}),1);
    assert.equal((await read()).finance.netCents,800);
    pass("durable bounded adoption repairs corrupted money and wrong Sale/Tip classification from verified identities, quarantines extras, queues exact resolution once, retains retry budget");
    const generation = require(root+"/src/services/earnings-generation-service"), live = require(root+"/src/services/live-earnings-projection-service");
    const event=(net,status,revisionAt,gross=null)=>({eventKey:"known-live",moneyObservation:{version:1,transactionId:"known",transactionType:"tip",occurredAt:now.toISOString(),revisionAt:revisionAt.toISOString(),netCents:net,amountCents:gross,currency:"USD",status}});
    const emit=async e=>commit(tx=>live.ingestLive({db:tx,...s,deviceId:null,events:[e],capturedAt:new Date(+now+1000),now:new Date(+now+4000)}));
    const correction=event(1200,"done",new Date(+now+1000)); await emit(correction); await emit(correction);
    assert.equal((await read()).finance.netCents,1200); assert.equal((await read()).finance.transactions,1); assert.equal((await read()).finance.grossCents,null);
    await emit(event(800,"done",new Date(+now-1000),1000)); assert.equal((await read()).finance.netCents,1200);
    await emit(event(1200,"undo",new Date(+now+2000)));
    const refunded=await read(); assert.equal(refunded.finance.netCents,0); assert.equal(refunded.finance.transactions,0);
    assert.equal(refunded.finance.refundTransactions,2); assert.equal(refunded.finance.refundNetCents,2800);
    assert.equal(Number((await generation.activeEntry(db,s.creatorId,"known")).netCents),1200);
    pass("live exact revision, duplicate delivery, stale historical observation and reversal apply exact signed deltas without inferring unknown gross");
    const kindEvent=(kind,net,revision,gross=1000)=>({eventKey:"kind-change",moneyObservation:{version:1,transactionId:"kind-change",transactionType:kind,
      occurredAt:now.toISOString(),revisionAt:new Date(+now+revision).toISOString(),netCents:net,amountCents:gross,currency:"USD",status:"done",fanOnlyFansUserId:"42"}});
    await emit(kindEvent("message",400,1000));
    const kindWhere={creatorId_externalTransactionId:{creatorId:s.creatorId,externalTransactionId:"kind-change"}};
    const saleKind=await db.creatorSale.findUnique({where:kindWhere});
    await commit(async tx=>{
      await require(root+"/src/services/creator-fact-write-authority").lockCreatorFacts(tx,s.agencyId,s.creatorId);
      await tx.creatorSale.update({where:{id:saleKind.id},data:{messageId:"kind-message"}});
      await require(root+"/src/services/creator-entity-change-service").publishCanonicalSales({db:tx,...s,saleIds:[saleKind.id]});
    });
    const purchaseWhere={creatorId_entityType_entityId:{creatorId:s.creatorId,entityType:"MESSAGE_PURCHASE",entityId:"42:kind-message"}};
    assert.equal((await db.creatorEntityCurrent.findUnique({where:purchaseWhere})).tombstone,false);
    await emit(kindEvent("tip",600,2000));
    assert.equal((await db.creatorSale.findUnique({where:kindWhere})).transactionStatus,"superseded");
    assert.equal((await db.creatorTip.findUnique({where:kindWhere})).netCents,600);
    assert.equal((await generation.activeEntry(db,s.creatorId,"kind-change")).category,"tips");
    assert.equal((await read()).finance.netCents,600);
    const withdrawn=await db.creatorEntityCurrent.findUnique({where:purchaseWhere});assert.equal(withdrawn.tombstone,true);
    assert.equal((await db.creatorMediaSaleLink.findUnique({where:{saleId:saleKind.id}})).proofActive,false);
    await assert.rejects(()=>commit(async tx=>{
      await live.ingestLive({db:tx,...s,deviceId:null,events:[kindEvent("message",700,3000)],capturedAt:new Date(+now+1000),now:new Date(+now+4000)});
      throw new Error("ROLLBACK_TYPE_CORRECTION");
    }),/ROLLBACK_TYPE_CORRECTION/);
    assert.equal((await db.creatorSale.findUnique({where:kindWhere})).transactionStatus,"superseded");
    assert.equal((await db.creatorTip.findUnique({where:kindWhere})).netCents,600);
    assert.equal((await db.creatorEntityCurrent.findUnique({where:purchaseWhere})).revision,withdrawn.revision);
    await emit(kindEvent("message",700,3000));
    const restoredPurchase=await db.creatorEntityCurrent.findUnique({where:purchaseWhere});assert.equal(restoredPurchase.tombstone,false);
    await emit(kindEvent("message",700,3000));await emit(kindEvent("tip",600,2000));
    assert.equal((await db.creatorEntityCurrent.findUnique({where:purchaseWhere})).revision,restoredPurchase.revision);
    assert.equal((await db.creatorSale.findUnique({where:kindWhere})).netCents,700);
    assert.equal((await db.creatorTip.findUnique({where:kindWhere})).transactionStatus,"superseded");
    assert.equal((await read()).finance.netCents,700);
    await emit(kindEvent("message",0,4000,0));
    assert.equal((await db.creatorSale.findUnique({where:kindWhere})).transactionStatus,"superseded");
    assert.equal((await db.creatorEntityCurrent.findUnique({where:purchaseWhere})).tombstone,true);
    assert.equal((await read()).finance.netCents,0);
    pass("exact SALE→TIP→SALE and known-zero corrections preserve one monetary contribution, withdraw/reinstate message evidence, reject stale replay and roll back every projection together");
    const fresh=await scope(db,{agencyId:"initial172-agency",creatorId:"initial172-creator",userId:"initial172-user"});
    const initial=require(root+"/src/services/initial-collection-readiness-service");
    const status=await require(root+"/src/services/creator-overview-service").readCreatorCurrentTask({db,creatorId:fresh.creatorId});
    assert.equal(status.status,"WAITING"); assert.equal(status.progress.percent,0); assert.equal(status.initialCollection.ready,false);
    let states=await initial.loadInitialCollectionAdmission({db,creatorIds:[fresh.creatorId,s.creatorId],now});
    assert.equal(initial.initialCollectionAdmission({jobKey:"fetch_campaigns"},states.get(fresh.creatorId)).admitted,false);
    assert.equal(initial.initialCollectionAdmission({jobKey:"fetch_campaigns"},states.get(s.creatorId)).admitted,true);
    await db.creatorFinancialCollectionState.create({data:{agencyId:fresh.agencyId,creatorId:fresh.creatorId,status:"FAILED",lastErrorCode:"RETAINED_FAILURE"}});
    await db.creatorCampaignCollectionState.create({data:{agencyId:fresh.agencyId,creatorId:fresh.creatorId,status:"PARTIAL",retryAfterAt:null}});
    states=await initial.loadInitialCollectionAdmission({db,creatorIds:[fresh.creatorId],now});
    assert.equal(initial.initialCollectionAdmission({jobKey:"catchup_notifications_scan"},states.get(fresh.creatorId)).admitted,true);
    assert.equal(initial.initialCollectionAdmission({jobKey:"subscriber_directory_scan"},states.get(fresh.creatorId)).admitted,true);
    assert.equal((await initial.readInitialCollectionReadiness({db,creatorId:fresh.creatorId,now})).ready,false);
    pass("empty queue is not initial100% readiness; missing finance blocks later stages, finite retained failure releases independent sources without claiming success");
    const start=runtime.queries.length; await read();
    const queries=runtime.queries.slice(start); assert.equal(queries.length,1);
    assert(!/FROM "CreatorFinancialTransaction"|FROM "CreatorEarningsGenerationEntry"/.test(queries[0].query));
    assert(/CreatorEarningsGenerationDay/.test(queries[0].query));
    assert.equal((await display.readPublishedFinancialSummary({db,creatorId:fresh.creatorId,from:day,to:now})).finance.netCents,null);
    await assert.rejects(()=>display.readPublishedFinancialSummary({db,creatorId:s.creatorId,from:new Date(+now-400*86400000),to:now}),/RANGE_INVALID/);
    pass("Overview reads one bounded days/categories query from published authority; missing proof stays unknown and oversized range is rejected");
    console.log(JSON.stringify({ok:true,engine:runtime.native?"native PostgreSQL":"PGlite + Prisma; no concurrency/load certification",checks},null,2));
  } finally {await runtime.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearInterval(keepAlive);clearTimeout(deadline);});
