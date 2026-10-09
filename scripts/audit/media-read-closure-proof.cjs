"use strict";
// Disposable retained-schema SQL; no external database is contacted.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const root = process.env.N4_PROOF_BACKEND ? path.resolve(process.env.N4_PROOF_BACKEND) : path.resolve(__dirname, '../..');
const load = file => require(path.join(root, file));
(async () => {
  const f = await load('scripts/test-support/admin-sql-runtime.cjs').createAdminSqlRuntime({runtimePath:process.env.N4_PROOF_RUNTIME});
  const {db,queries} = f, cases=[];
  const check=async(name,work)=>{await work();cases.push({name,status:'PASS'});console.log(JSON.stringify(cases.at(-1)));};
  const baseline=process.env.N4_PROOF_BASELINE==='1';
  require.cache[require.resolve(path.join(root,'src/prisma'))]={exports:db};
  require.cache[require.resolve(path.join(root,'src/services/job-scheduler'))]={exports:{scheduleJobNow:async()=>{throw Error('not used');}}};
  try {
    const {agency,creator,other} = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
      const user=await tx.user.create({data:{email:'n4-proof@example.test',passwordHash:'fixture'}});
      const agency=await tx.agency.create({data:{name:'N4 media SQL'}});
      await tx.agencyMember.create({data:{agencyId:agency.id,userId:user.id,role:'OWNER',roleKey:'owner',assignedCreators:'all'}});
      const creator=await tx.creatorAccount.create({data:{agencyId:agency.id,displayName:'N4 media SQL',status:'READY'}});
      const other=await tx.creatorAccount.create({data:{agencyId:agency.id,displayName:'Other',status:'READY'}});
      return {agency,creator,other};
    });
    const scope={agencyId:agency.id,creatorId:creator.id,db};
    assert.equal(await db.agency.count({where:{id:agency.id}}),1,'SQL fixture agency commit must be durable');
    assert.equal(await db.creatorAccount.count({where:{id:creator.id}}),1,'SQL fixture creator commit must be durable');
    await db.$executeRawUnsafe(`INSERT INTO "CreatorMediaAsset" (id,"agencyId","creatorId","mediaId","catalogActive","storylineName","storylineRole","storylineOrder","mediaType","lastSeenAt","updatedAt")
      SELECT 'asset-'||n,$1,$2,'media-'||LPAD(n::text,6,'0'),true,' Story ', CASE WHEN n % 2 = 0 THEN 'main' ELSE 'additional' END,n,'photo','2026-10-07'::timestamp,'2026-10-07'::timestamp FROM generate_series(1,100003) n`,agency.id,creator.id);
    await db.creatorMediaAsset.update({where:{id:'asset-1'},data:{soldCount:100003,revenueCents:12345,sentCount:1,lastSoldAt:new Date('2026-10-07')}});
    await db.$executeRawUnsafe(`INSERT INTO "CreatorMediaUsageContribution" (id,"agencyId","creatorId","assetId","mediaId","sourceKey","sourceRevision","soldCount","updatedAt")
      SELECT 'usage-'||n,$1,$2,'asset-1','media-000001','opaque-'||n,'1',1,now() FROM generate_series(1,100003) n`,agency.id,creator.id);
    const service=load('src/services/media-library-service');
    await check(baseline?'BASELINE reproduces storyline truncation at 100000':'storyline aggregation includes all 100003 assets',async()=>{
      const r=await service.listStorylines(scope);assert.equal(r.storylines.length,1);assert.equal(r.storylines[0].mediaCount,baseline?100000:100003);
      if(!baseline){assert.equal(r.storylines[0].mainCount,50001);assert.equal(r.storylines[0].additionalCount,50002);assert.equal(r.storylines[0].minOrder,1);assert.equal(r.storylines[0].maxOrder,100003);}
    });
    await check(baseline?'BASELINE reproduces distinct buyer cap':'exact distinct opaque sources beyond 100000',async()=>{
      const r=await service.getMediaSalesSummary(scope);assert.equal(r.summary.uniqueBuyers,baseline?100000:100003);assert.equal(r.summary.revenueCents,12345);
    });
    await check(baseline?'BASELINE reproduces silent deep offset clamp':'source offset 10000001 is preserved',async()=>{
      const r=await service.searchMediaLibrary({...scope,offset:10000001,limit:40});assert.equal(r.offset,baseline?10000000:10000001);assert.equal(r.count,100003);assert.equal(r.items.length,0);assert.equal(r.hasMore,false);
    });
    const never=load('src/services/vault-never-used-service');
    await db.dialogScanRun.create({data:{id:'n4-discovery',agencyId:agency.id,creatorId:creator.id,dialogId:'__dialog_discovery__',mode:'discovery',status:'COMPLETED',generation:7,pagesProcessed:1,progress:{hasMore:false,pages:1}}});
    await db.$executeRawUnsafe(`INSERT INTO "DialogScanState" (id,"agencyId","creatorId","dialogId",generation,"initialScanComplete",status,"pagesProcessed","messagesProcessed","updatedAt")
      SELECT 'ds-'||LPAD(n::text,6,'0'),$1,$2,'dialog-'||LPAD(n::text,6,'0'),7,n<=100000,CASE WHEN n<=100000 THEN 'COMPLETED' ELSE 'PLANNED' END,1,2,'2026-10-07'::timestamp FROM generate_series(1,100003) n`,agency.id,creator.id);
    await check(baseline?'BASELINE dialog plan hides a pending tail beyond 100000':'dialog plan includes the pending tail beyond 100000',async()=>{
      const r=await never.dialogPipelineState(db,agency.id,creator.id);assert.equal(r.discovered,baseline?100000:100003);assert.equal(r.pending,baseline?0:3);assert.equal(r.initialComplete,100000);
      if(!baseline){assert.equal(r.messagesCommitted,200006);assert.equal(r.pagesCommitted,100003);}
    });
    if(baseline) return;
    await check('dialog plan scope, generation and latest failure are exact',async()=>{
      await db.dialogScanState.create({data:{id:'old-plan',agencyId:agency.id,creatorId:creator.id,dialogId:'old',generation:6,status:'FAILED',lastError:'old failure'}});
      await db.dialogScanState.update({where:{id:'ds-100003'},data:{status:'FAILED',lastError:'tail failure',updatedAt:new Date('2099-01-02')}});
      const hostZone=process.env.TZ;
      try {
        for(const zone of ['UTC','Europe/Berlin','America/New_York']) {
          process.env.TZ=zone;
          await db.$queryRawUnsafe("SELECT set_config('TimeZone',$1,false)",zone);
          const r=await never.dialogPipelineState(db,agency.id,creator.id);
          assert.equal(r.discovered,100003);assert.equal(r.pending,2);assert.equal(r.failed,1);
          assert.equal(r.lastFailure.dialogId,'dialog-100003');
          assert.equal(r.lastFailure.updatedAt,'2099-01-02T00:00:00.000Z',`failure timestamp in ${zone}`);
        }
      } finally {
        if(hostZone===undefined)delete process.env.TZ;else process.env.TZ=hostZone;
        await db.$queryRawUnsafe("SELECT set_config('TimeZone','UTC',false)");
      }
      assert.equal((await never.dialogPipelineState(db,agency.id,other.id)).discovered,0);
      await db.dialogScanState.update({where:{id:'ds-100003'},data:{status:'PLANNED',lastError:null}});
    });

    await check('Prisma and PostgreSQL preserve offsets beyond signed 32-bit',async()=>{
      for(const offset of [2147483648,Number.MAX_SAFE_INTEGER-500]) {
        const r=await service.searchMediaLibrary({...scope,offset});assert.equal(r.offset,offset);assert.equal(r.nextOffset,offset);assert.equal(r.hasMore,false);
      }
    });
    await check('pages and exact count use one repeatable-read snapshot',async()=>{
      queries.length=0;
      const r=await service.searchMediaLibrary({...scope,offset:100000,limit:10});assert.equal(r.count,100003);assert.equal(r.items.length,3);assert.equal(r.nextOffset,100003);assert.equal(r.hasMore,false);
      assert.ok(queries.some(q=>/REPEATABLE READ/.test(q.query)));assert.ok(queries.some(q=>/COMMIT/.test(q.query)));
    });
    await check('stable tied timestamps across adjacent and empty pages',async()=>{
      const a=await service.searchMediaLibrary({...scope,offset:99998,limit:3});const b=await service.searchMediaLibrary({...scope,offset:a.nextOffset,limit:3});
      assert.equal(new Set([...a.items,...b.items].map(x=>x.mediaId)).size,5);assert.equal(a.hasMore,true);assert.equal(b.hasMore,false);
      assert.deepEqual(b.items.map(x=>x.mediaId),['media-000002','media-000001']);
    });
    await check('search metadata-only visibility, folder and type count are aligned',async()=>{
      await db.creatorMediaAsset.create({data:{id:'placeholder',agencyId:agency.id,creatorId:creator.id,mediaId:'placeholder',description:'metadata needle',metadataUpdatedAt:new Date(),mediaType:'video'}});
      let r=await service.searchMediaLibrary({...scope,query:'needle',scope:'description'});assert.equal(r.count,1);assert.equal(r.items[0].mediaId,'placeholder');
      r=await service.searchMediaLibrary({...scope,query:'needle',folderId:'f'});assert.equal(r.count,0);
      await db.creatorMediaAsset.update({where:{id:'asset-2'},data:{folderIds:['f'],mediaType:'video',manualTags:['blue']}});
      r=await service.searchMediaLibrary({...scope,query:'blue',scope:'tags',folderId:'f',mediaType:'video'});assert.equal(r.count,1);assert.equal(r.items[0].mediaId,'media-000002');
    });
    await check('normalization merges storyline case and whitespace, ignores inactive rows',async()=>{
      await db.creatorMediaAsset.update({where:{id:'asset-3'},data:{storylineName:'story'}});
      const r=await service.listStorylines(scope);assert.equal(r.storylines.length,1);assert.equal(r.storylines[0].mediaCount,100003);
    });
    await check('sales rows, empty creator and scoped aggregates agree',async()=>{
      const r=await service.listMediaSalesAssets({...scope,limit:1});assert.equal(r.count,1);assert.equal(r.items[0].soldCount,100003);assert.equal(r.nextOffset,1);assert.equal(r.hasMore,false);
      const empty=await service.getMediaSalesSummary({...scope,creatorId:other.id});assert.equal(empty.summary.uniqueBuyers,0);assert.equal(empty.summary.totalSales,0);assert.equal(empty.summary.lastSaleAt,null);
      await assert.rejects(service.getMediaSalesSummary({...scope,agencyId:'wrong-agency'}),{code:'CREATOR_NOT_FOUND'});
    });
    const unsorted=load('src/services/vault-unsorted-service'), directory=load('src/services/vault-directory-service');
    await check('unsorted preserves deep offsets and counts the complete catalog',async()=>{
      const r=await unsorted.listVaultUnsortedMedia({...scope,offset:1000001});assert.equal(r.offset,1000001);assert.equal(r.total,100003);assert.equal(r.hasMore,false);
    });
    await check('Never Used counts aggregate once and observe deletion without cached totals',async()=>{
      await db.creatorMediaAsset.update({where:{id:'asset-5'},data:{updatedAt:new Date('2099-01-01')}});
      let r=await never.projectionCounts(db,agency.id,creator.id);assert.equal(r.catalogMedia,100003);assert.equal(r.usedCreatorMedia,1);assert.equal(r.neverUsed,100002);assert.equal(r.catalogByType.video,1);assert.equal(r.byType.photo,100001);
      assert.equal(r.rebuiltAt,'2099-01-01T00:00:00.000Z');
      await db.creatorMediaAsset.update({where:{id:'asset-4'},data:{catalogActive:false}});
      r=await never.projectionCounts(db,agency.id,creator.id);assert.equal(r.catalogMedia,100002);assert.equal(r.neverUsed,100001);
    });
    await check('directory and sales totals agree for the same active catalog',async()=>{
      const d=await directory.getVaultDirectoryIntelligence({...scope,includePipeline:false,mediaIds:['media-000001']});const sales=await service.getMediaSalesSummary(scope);
      assert.equal(d.summary.protectedMediaCount,100002);assert.equal(d.summary.revenueCents,sales.summary.revenueCents);assert.equal(d.summary.soldAssets,1);assert.equal(d.analytics.length,1);
    });
    await check('distinct buyer sources are deduplicated and inactive assets excluded',async()=>{
      await db.creatorMediaUsageContribution.create({data:{agencyId:agency.id,creatorId:creator.id,assetId:'asset-2',mediaId:'media-000002',sourceKey:'opaque-1',sourceRevision:'1',soldCount:1}});
      assert.equal((await service.getMediaSalesSummary(scope)).summary.uniqueBuyers,100003);
      await db.creatorMediaAsset.update({where:{id:'asset-1'},data:{catalogActive:false}});
      assert.equal((await service.getMediaSalesSummary(scope)).summary.uniqueBuyers,1);
    });
    await check('invalid offsets and rounded aggregates fail explicitly',async()=>{
      const {mediaOffset,exactMediaCount}=load('src/services/media-read-page');
      for(const value of [-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>mediaOffset(value),{code:'MEDIA_OFFSET_INVALID'});
      assert.throws(()=>exactMediaCount(9007199254740993n),{code:'MEDIA_COUNT_OUT_OF_RANGE'});
    });
  } finally {
    if(process.env.N4_PROOF_OUTPUT)fs.writeFileSync(process.env.N4_PROOF_OUTPUT,JSON.stringify({runtime:process.version,engine:'PGlite 0.5.8 + Prisma 5.22.0; serialized one-connection fixture',migrations:f.migrations.length,baseline,cases},null,2));
    await f.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
