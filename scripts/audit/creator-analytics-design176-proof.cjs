"use strict";
// Real isolated PostgreSQL-compatible queries; never uses an application DB.
const assert=require("node:assert/strict");
const {createScaleSqlRuntime}=require("../test-support/scale-sql-runtime.cjs");
const {scope}=require("./analytics-traffic/fixture.cjs");
const {runRootCommit}=require("../../src/services/db-commit-kernel");
const {displayRangeBounds,previousDisplayRange}=require("../../src/services/analytics-range-contract");
const repo=require("../../src/services/home-read-repository");
const results=[];
function pass(name){results.push(name);console.log("PASS",name);}
(async()=>{
  const f=await createScaleSqlRuntime();
  try {
    const {db}=f,sc=await scope(db,{agencyId:"design176",creatorId:"c000",userId:"design176-owner"});
    const other=await scope(db,{agencyId:"foreign176",creatorId:"foreign176",userId:"foreign176-owner"});
    const now=new Date(),today=new Date(now.toISOString().slice(0,10)),from=new Date(+today-200*86400000);
    const member=await db.agencyMember.findUnique({where:{id:"member-"+sc.agencyId}});
    const tx=fn=>runRootCommit(db,async({tx})=>{
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true),set_config('onlinod.earnings_writer_generation','v7',true),set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true)");
      return fn(tx);
    });
    const input={db,...sc,member:{...member,broad:true},billing:true,money:true,manage:true,now,
      range:displayRangeBounds("7d",now),previous:previousDisplayRange("7d",now)};
    await tx(async t=>{
      await t.agency.updateMany({where:{id:{in:[sc.agencyId,other.agencyId]}},data:{trialEndsAt:new Date("2099-01-01Z")}});
      await t.creatorAccount.createMany({data:Array.from({length:129},(_,i)=>({id:"c"+String(i+1).padStart(3,"0"),agencyId:sc.agencyId,
        remoteId:"remote"+(i+1),displayName:i+1===3?"100%_real":"Creator "+(i+1),username:"model"+(i+1),status:"READY"}))});
      await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGeneration"(id,"agencyId","creatorId","runId",state,phase,"fromAt","throughAt","snapshotAt","fullScan","publishedAt")
        SELECT 'g-'||id,"agencyId",id,'fixture','ACTIVE','READY',$2,$3,$3,true,$3 FROM "CreatorAccount" WHERE "agencyId"=$1`,sc.agencyId,from,now);
      await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation,"activeGeneration")
        SELECT id,"agencyId",$2,$3,'fixture','g-'||id FROM "CreatorAccount" WHERE "agencyId"=$1`,sc.agencyId,from,now);
      await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGenerationDay"(generation,date,category,"netCents","financialMetrics","observedAt")
        SELECT 'g-'||id,$2::date,'tips',CASE WHEN substring(id,2)::integer%3=0 THEN 200 WHEN substring(id,2)::integer%3=1 THEN 50 ELSE 100 END,
          '{"done_count":2,"done_net":100}'::jsonb,$3 FROM "CreatorAccount" WHERE "agencyId"=$1
        UNION ALL SELECT 'g-'||id,$2::date-7,'tips',100,'{"done_count":4,"done_net":100}'::jsonb,$3 FROM "CreatorAccount" WHERE "agencyId"=$1`,sc.agencyId,today,now);
    });
    let after="",all=[],pages=0;const queryStart=f.queries.length;
    do {
      const page=await repo.readHomeCreatorPage({...input,after,limit:10,trend:"increasing",includeRevenuePoints:true});
      assert(page.creators.length<=10);for(const c of page.creators){assert.equal(c.comparisonReady,true);assert.equal(c.revenueDeltaCents,100);assert.equal(c.revenueDeltaPct,100);assert.equal(c.revenuePoints.length,7);assert.equal(c.revenuePoints.reduce((n,p)=>n+p.valueCents,0),200);}
      all.push(...page.creators.map(x=>x.id));after=page.nextCursor;pages++;assert(pages<20);
    } while(after);
    assert.equal(all.length,44);assert.equal(new Set(all).size,44);assert.equal(pages,5);
    assert.equal(f.queries.length-queryStart,5,"one statement per global filtered page, no N+1");
    pass("130 creators: global Increasing filter finds all 44 results across five bounded pages with real 7-day sparklines");
    const literal=await repo.readHomeCreatorPage({...input,search:"%_",limit:10});assert.deepEqual(literal.creators.map(x=>x.id),["c003"]);
    const byUser=await repo.readHomeCreatorPage({...input,search:"MODEL129",trend:"increasing",limit:10});assert.deepEqual(byUser.creators.map(x=>x.id),["c129"]);
    const missing=await repo.readHomeCreatorPage({...input,search:"not found",trend:"declining",limit:10});assert.deepEqual(missing.creators,[]);assert.equal(missing.nextCursor,null);
    pass("global literal name/username search, escaped percent/underscore, case folding and empty final page");
    const totals=await repo.readHomeTotals(input);assert.equal(totals.totalCents,15250);assert.equal(totals.medianCreatorRevenueCents,100);
    pass("workspace median includes every authorized creator and proven zero days, not the visible UI page");
    await tx(async t=>{
      await t.$executeRawUnsafe(`UPDATE "CreatorEarningsGenerationDay" SET "netCents"=CASE WHEN date=$1::date THEN -20 ELSE -100 END WHERE generation='g-c000'`,today);
      await t.$executeRawUnsafe(`UPDATE "CreatorEarningsGenerationDay" SET "netCents"=CASE WHEN date=$1::date THEN 100 ELSE 0 END WHERE generation='g-c003'`,today);
      await t.$executeRawUnsafe(`UPDATE "CreatorEarningsGenerationDay" SET "netCents"=0 WHERE generation='g-c006'`);
    });
    const signed=await repo.readHomeCreatorPage({...input,limit:10});
    assert.equal(signed.creators[0].revenueDeltaPct,80);assert.equal(signed.creators[3].revenueDeltaPct,null);assert.equal(signed.creators[3].revenueDeltaCents,100);assert.equal(signed.creators[6].revenueDeltaPct,0);
    pass("signed losses and zero baselines compare without division errors or invented infinite growth");
    await tx(t=>t.$executeRawUnsafe(`UPDATE "CreatorEarningsLedgerProof" SET "throughAt"=$1 WHERE "creatorId"='c009'`,new Date(+now-10*60000)));
    const stale=await repo.readHomeCreatorPage({...input,search:"model9",trend:"increasing",limit:100});assert(!stale.creators.some(c=>c.id==="c009"));
    assert.equal((await repo.readHomeTotals(input)).medianCreatorRevenueCents,null);
    await tx(t=>t.$executeRawUnsafe(`UPDATE "CreatorEarningsLedgerProof" SET "throughAt"=$1 WHERE "creatorId"='c009'`,now));
    await tx(t=>t.$executeRawUnsafe(`UPDATE "CreatorEarningsLedgerProof" SET "fromAt"=$1 WHERE "creatorId"='c012'`,input.range.startAt));
    const partial=await repo.readHomeCreatorPage({...input,search:"model12",limit:100});assert.equal(partial.creators.find(c=>c.id==="c012").comparisonReady,false);
    const hidden=await repo.readHomeCreatorPage({...input,money:false,trend:"increasing",includeRevenuePoints:true});assert.deepEqual(hidden.creators,[]);
    pass("stale delivery, uncovered previous ranges and no-money permission suppress comparisons/median");
    await tx(t=>t.$executeRawUnsafe(`DELETE FROM "CreatorEarningsLedgerProof" WHERE "creatorId"='c128'`));
    const fallback=await repo.readHomeCreatorPage({...input,trend:"increasing",limit:100});assert(fallback.creators.length>30);assert(!fallback.creators.some(x=>x.id==="c128"));
    pass("mixed proof availability uses the canonical proof-joined fallback without inventing missing financial values");
    const comparison=require("../../src/services/creator-overview-comparison"),published=require("../../src/services/published-financial-read-repository");
    const current=await published.readPublishedFinancialSummary({db,creatorId:"c003",from:input.range.startAt,to:now});
    const profile=await comparison.readCreatorFinancialComparison({db,creatorId:"c003",range:"7d",now,current});
    assert.equal(profile.ready,true);assert.equal(profile.netCents,0);assert.equal(profile.netDeltaCents,100);assert.equal(profile.transactions,4);assert.equal(profile.netDeltaPct,null);
    const missingProfile=await comparison.readCreatorFinancialComparison({db,creatorId:"c012",range:"7d",now,current:await published.readPublishedFinancialSummary({db,creatorId:"c012",from:input.range.startAt,to:now})});
    assert.equal(missingProfile.ready,false);assert.equal(missingProfile.netCents,null);
    pass("profile comparison uses published financial metrics and actual prior coverage, not old raw transaction rows");
    const foreign=await repo.readHomeCreatorPage({...input,search:"foreign176",trend:"increasing",limit:100});assert.deepEqual(foreign.creators,[]);
    const revoked=await repo.readHomeCreatorPage({...input,member:{...input.member,accessEpoch:input.member.accessEpoch+1},trend:"increasing",limit:100});assert.deepEqual(revoked.creators,[]);
    pass("foreign agency and stale membership epoch cannot expose creator comparisons");
    let restricted;
    await tx(async t=>{
      await t.user.create({data:{id:'restricted176',email:'restricted176@example.test',passwordHash:'fixture'}});
      restricted=await t.agencyMember.create({data:{id:'restricted176',agencyId:sc.agencyId,userId:'restricted176',role:'OPERATOR',roleKey:'operator',assignedCreators:['c003','c001'],permissions:{}}});
      for(const creatorId of ['c003','c001'])await t.agencyMemberCreatorAccessCurrent.upsert({
        where:{memberId_creatorId:{memberId:restricted.id,creatorId}},create:{agencyId:sc.agencyId,memberId:restricted.id,creatorId,accessEpoch:restricted.accessEpoch,claimShard:0},update:{accessEpoch:restricted.accessEpoch,claimShard:0}});
    });
    const restrictedInput={...input,member:{...restricted,broad:false}};
    assert.deepEqual((await repo.readHomeCreatorPage({...restrictedInput,trend:'increasing',limit:100})).creators.map(x=>x.id),['c003']);
    assert.deepEqual((await repo.readHomeCreatorPage({...restrictedInput,trend:'declining',limit:100})).creators.map(x=>x.id),['c001']);
    assert.equal((await repo.readHomeTotals(restrictedInput)).medianCreatorRevenueCents,75);
    pass('restricted membership filters and median use exactly its two assigned creators');
    const subscribers=require('../../src/services/published-subscriber-summary');
    async function subscriberHead(creatorId,agencyId,count){
      const runId='sub-'+creatorId;
      await tx(async t=>{
        await t.subscriberScanRun.create({data:{id:runId,creatorId,agencyId,status:'PUBLISHED',sourceType:'all',hasMore:false,
          scannedCount:count,fanProjectionCount:count,fanProjectionStatus:'COMPLETE',nextOffset:count,fanProjectionCursorOffset:count,
          publicationGeneration:1,publicationStatus:'COMPLETE',publishedAt:now,completedAt:now,publicationCompletedAt:now}});
        await t.subscriberDirectoryState.create({data:{creatorId,agencyId,currentRunId:runId,status:'READY',totalCount:count,
          publicationGeneration:1,publishedGeneration:1,publishedAt:now,nextScanAt:new Date(+now+7*86400000)}});
      });
    }
    await subscriberHead('c001',sc.agencyId,100);await subscriberHead('c003',sc.agencyId,0);await subscriberHead('foreign176',other.agencyId,900);
    const subPage=await repo.readHomeCreatorPage({...restrictedInput,limit:100});
    assert.deepEqual(subPage.creators.map(c=>c.subscriberCount),[100,0]);
    assert.equal((await subscribers.readCreatorAudience({db,creatorId:'c000',now})).subscriberCount,null);
    assert.equal((await subscribers.readCreatorAudience({db,creatorId:'c003',now})).subscriberCount,0);
    assert.equal((await subscribers.readHomeAudience(input)).totalSubscribers,null);
    assert.equal((await subscribers.readHomeAudience(input)).coverage.reportingCreators,2);
    assert.equal((await subscribers.readHomeAudience(restrictedInput)).totalSubscribers,100);
    pass('subscriber count is unknown until publication; verified zero is zero; workspace totals require every scoped head');
    await tx(t=>t.subscriberDirectoryState.update({where:{creatorId:'c001'},data:{status:'SCANNING',publicationGeneration:2}}));
    const oldHead=await subscribers.readCreatorAudience({db,creatorId:'c001',now});assert.equal(oldHead.subscriberCount,100);assert.equal(oldHead.stale,true);assert.equal(oldHead.publishedAt,now.toISOString());
    assert.equal((await subscribers.readHomeAudience(restrictedInput)).coverage.staleCreators,1);
    await tx(t=>t.subscriberDirectoryState.update({where:{creatorId:'c001'},data:{publishedGeneration:2}}));
    assert.equal((await subscribers.readCreatorAudience({db,creatorId:'c001',now})).subscriberCount,null);
    await tx(t=>t.subscriberDirectoryState.update({where:{creatorId:'c001'},data:{publishedGeneration:1,currentRunId:'sub-foreign176'}}));
    assert.equal((await subscribers.readCreatorAudience({db,creatorId:'c001',now})).subscriberCount,null);
    await tx(t=>t.subscriberDirectoryState.update({where:{creatorId:'c001'},data:{currentRunId:'sub-c001',totalCount:999}}));
    assert.equal((await subscribers.readCreatorAudience({db,creatorId:'c001',now})).subscriberCount,null);
    await tx(async t=>{await t.subscriberDirectoryState.update({where:{creatorId:'c001'},data:{totalCount:100}});await t.subscriberScanRun.update({where:{id:'sub-c001'},data:{fanProjectionCount:99}});});
    assert.equal((await subscribers.readCreatorAudience({db,creatorId:'c001',now})).subscriberCount,null);
    pass('next scan keeps last published count/asof, while mismatched generation, agency, count or source-projection proof suppress it');
    // Sparse wide scope: thousands of proven zero-value creators add metadata,
    // never one zero fact per creator per day to the global trend query.
    await tx(t=>t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation,"activeGeneration") VALUES ('c128',$1,$2,$3,'fixture','g-c128')`,sc.agencyId,from,now));
    for(let first=1;first<=4000;first+=100)await tx(async t=>{
      const last=Math.min(4000,first+99),lower='scale-'+String(first).padStart(4,'0'),upper='scale-'+String(last).padStart(4,'0');
      await t.$executeRawUnsafe(`INSERT INTO "CreatorAccount"(id,"agencyId","displayName","remoteId",status,"updatedAt")
        SELECT 'scale-'||lpad(i::text,4,'0'),$1,'Zero creator '||i,'scale-remote-'||i,'READY',$2 FROM generate_series($3::integer,$4::integer)i`,sc.agencyId,now,first,last);
      await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsGeneration"(id,"agencyId","creatorId","runId",state,phase,"fromAt","throughAt","snapshotAt","fullScan","publishedAt")
        SELECT 'g-'||id,"agencyId",id,'fixture','ACTIVE','READY',$2,$3,$3,true,$3 FROM "CreatorAccount" WHERE "agencyId"=$1 AND id BETWEEN $4 AND $5`,sc.agencyId,from,now,lower,upper);
      await t.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation,"activeGeneration")
        SELECT id,"agencyId",$2,$3,'fixture','g-'||id FROM "CreatorAccount" WHERE "agencyId"=$1 AND id BETWEEN $4 AND $5`,sc.agencyId,from,now,lower,upper);
    });
    const queryCalls=[];
    const measuredDb={$queryRawUnsafe:async(sql,...params)=>{const result=await db.$queryRawUnsafe(sql,...params);queryCalls.push({sql,params,fastReady:result[0]?.fastReady});return result;}};
    const start=performance.now();
    const large=await repo.readHomeCreatorPage({...input,db:measuredDb,trend:'increasing',limit:20});
    assert.equal(large.creators.length,20);assert.equal(queryCalls.length,1,JSON.stringify(queryCalls.map(x=>({fastReady:x.fastReady}))));
    const largeMs=Math.round(performance.now()-start);
    if(process.env.ONLINOD_ANALYTICS_QUERY_DEBUG==='1' && largeMs>1000){
      const explain=await db.$queryRawUnsafe('EXPLAIN (ANALYZE, FORMAT JSON) '+queryCalls[0].sql,...queryCalls[0].params);
      const plan=explain[0]['QUERY PLAN'][0];
      const out=[];function walk(node,depth=0){out.push({depth,node:node['Node Type'],relation:node['Relation Name'],cte:node['CTE Name'],join:node['Join Type'],rows:node['Actual Rows'],loops:node['Actual Loops'],ms:node['Actual Total Time'],removed:node['Rows Removed by Join Filter'],filter:node['Join Filter']||node['Filter']});for(const child of node.Plans||[])walk(child,depth+1);}walk(plan.Plan);
      console.log('QUERY_PLAN',JSON.stringify(out));
    }
    const summaryStart=performance.now(),largeSummary=await repo.readHomeTotals(input);
    assert.equal(largeSummary.totalCreators,4130);assert.equal(largeSummary.medianCreatorRevenueCents,0);
    const summaryMs=Math.round(performance.now()-summaryStart);
    pass('4,130 creators: global trend is one bounded-result query; median includes 4,000 proven zero-value creators');
    console.log(JSON.stringify({groups:results.length,native:f.native,creators:4130,globalTrendMs:largeMs,summaryMs},null,2));
  } finally {await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
