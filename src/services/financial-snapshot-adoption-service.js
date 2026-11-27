"use strict";

// One finite upgrade pass. Retained, verified FULL receipts can rebuild their
// exact membership offline. Missing/retired or unverified evidence receives one
// coalesced full-source verification command; no receipt is rewritten.
const { createHash } = require("node:crypto");
const { runRootCommit } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const generation = require("./earnings-generation-service");
const { FINANCIAL_PROOF_POLICY_VERSION: VERSION } = require("./earnings-coverage-service");
const { FLOOR } = require("./financial-receipt-authority");
const KEY = "repair:financial-snapshot:v2";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// These are deterministic evidence failures, not database availability,
// transaction or unknown-commit outcomes. Only this closed set may advance a
// creator to source verification after a failed offline unit.
const UNRECONSTRUCTIBLE = new Set(["EARNINGS_GENERATION_PROOF_MISMATCH", "FINANCIAL_PUBLICATION_FACT_INVALID",
  "EARNINGS_PUBLICATION_TIME_INVALID", "EARNINGS_GENERATION_SCOPE_MISMATCH", "EARNINGS_DISJOINT_COVERAGE",
  "EARNINGS_GENERATION_RETIRED", "EARNINGS_GENERATION_REBUILD_REQUIRED"]);

async function pendingOfflineAdoption(db, creatorId) {
  const stored = await db.systemSetting.findUnique({where:{key:KEY},select:{value:true}});
  if (!stored?.value?.version) return true;
  const state=stored.value;
  return state.status!=="COMPLETE" && creatorId>state.cursor && creatorId<=state.upperCreatorId;
}

async function queueFullVerification(db, creator, now, targetAt=now) {
  const [proof]=await db.$queryRawUnsafe(`SELECT generation,"activeGeneration","proofPolicyVersion"
    FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1 AND "agencyId"=$2`,creator.id,creator.agencyId);
  if (proof?.proofPolicyVersion===VERSION) return 0;
  // A completed episode proves its published source, not every later legacy
  // head. During rollout an older FULL publisher can settle an accepted-source
  // obligation while still publishing the former policy. Give that new head
  // one finite repair identity; repeated/STOPPED work for the same head keeps
  // its existing retry budget and cannot be restarted by another heartbeat.
  const head=proof?.activeGeneration ? ["snapshot",proof.activeGeneration]
    : proof ? ["ledger",proof.generation] : ["missing"];
  const id = digest([KEY, creator.id, head]);
  const inserted = await db.$executeRawUnsafe(`INSERT INTO "CreatorRecoveryIntent"
    (id,"agencyId","creatorId",stream,reason,"gapFrom","targetAt","policyVersion")
    SELECT $1,$2,$3,'financial','FINANCIAL_PROOF_ADOPTION_FULL',$4,$5,2
    WHERE NOT EXISTS(SELECT 1 FROM "CreatorRecoveryIntent" WHERE "creatorId"=$3 AND stream='financial'
      AND reason='FINANCIAL_PROOF_ADOPTION_FULL' AND status IN ('PENDING','RUNNING'))
    ON CONFLICT(id) DO NOTHING`,id,creator.agencyId,creator.id,FLOOR,targetAt);
  if (inserted) await require("./domain-work-authority-service").publishDomainWork({db,
    agencyId:creator.agencyId,creatorId:creator.id,workClass:"CREATOR_RECURRING_PLANNING",objectType:"CreatorAccount",objectId:creator.id,partitionKey:creator.id});
  return Number(inserted);
}

async function page({ db }) {
  let attempt;
  try { return await runRootCommit(db,async({tx})=>{
    await tx.$executeRawUnsafe(`INSERT INTO "SystemSetting"(id,key,value,"updatedAt")
      VALUES($1,$1,'{}'::jsonb,clock_timestamp()) ON CONFLICT(key) DO NOTHING`,KEY);
    const [stored]=await tx.$queryRawUnsafe('SELECT * FROM "SystemSetting" WHERE key=$1 FOR UPDATE',KEY);
    const now=await dbAuthorityNow({db:tx});
    let state=stored.value;
    if (!state.version) {
      const [upper]=await tx.$queryRawUnsafe('SELECT max(id) AS id FROM "CreatorAccount"');
      state={version:VERSION,upperCreatorId:upper.id||"",cursor:"",current:null,status:"RUNNING",
        counts:{visited:0,rebuilt:0,verificationQueued:0,skipped:0}};
    }
    if (state.status==="COMPLETE") return {complete:true,processed:0,counts:state.counts};
    const save=async()=>{
      await tx.systemSetting.update({where:{id:stored.id},data:{value:state,revision:{increment:1}}});
      return {complete:state.status==="COMPLETE",processed:1,counts:state.counts};
    };
    const [creator]=await tx.$queryRawUnsafe(`SELECT c.id,c."agencyId" FROM "CreatorAccount" c JOIN "Agency" a ON a.id=c."agencyId"
      WHERE c."deletedAt" IS NULL AND a."deletedAt" IS NULL AND c.id>$1 AND c.id<=$2
      ORDER BY c.id LIMIT 1`,state.cursor,state.upperCreatorId);
    if (!creator) {state.status="COMPLETE";state.current=null;return save();}
    const finish=(kind)=>{state.cursor=creator.id;state.current=null;state.counts.visited++;state.counts[kind]++;};
    const lifecycle=await require("./agency-lifecycle-barrier-service").lockAgencyLifecycleBarrier({db:tx,agencyId:creator.agencyId});
    const currentCreator=await tx.$queryRawUnsafe('SELECT id FROM "CreatorAccount" WHERE id=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE',creator.id,creator.agencyId);
    if (!lifecycle.row || lifecycle.row.deletedAt || !currentCreator.length) {finish("skipped");return save();}
    await require("./db-transaction-service").lockDbAdvisoryXact({db:tx,key:`analytics-collector:financial:${creator.id}`});
    await generation.lock(tx,creator.id);
    const [proof]=await tx.$queryRawUnsafe('SELECT * FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1',creator.id);
    if (proof?.proofPolicyVersion===VERSION) {finish("skipped");return save();}
    const collection=await tx.creatorFinancialCollectionState.findUnique({where:{creatorId:creator.id}});
    if (!proof && !collection) {finish("skipped");return save();}
    // Provider work already owns its generation. Queue a finite obligation
    // instead of preempting an in-flight or paused source traversal.
    const active=await tx.jobInstance.findFirst({where:{creatorId:creator.id,jobKey:"financial_transactions_scan",
      status:{in:["SCHEDULED","CLAIMED","PUBLISHING","PAUSED"]}},select:{id:true,params:true}});
    if (active) {
      if(state.current?.generationId) await generation.retireUnpublished(tx,state.current.generationId);
      const accepted=await tx.financialReceiptRun.findFirst({where:{jobId:active.id,generation:active.params?.collectionGeneration||""}});
      // An already accepted complete FULL publication will rebuild through the
      // current policy. Bind its obligation to its existing proven boundary so
      // ordinary completion settles it without a redundant provider scan.
      const acceptedFull=accepted?.proof?.complete===true && accepted.windows?.length===1
        && accepted.windows[0].kind==="FULL" && accepted.windows[0].from===null && !accepted.detailsRetiredAt;
      state.counts.verificationQueued+=await queueFullVerification(tx,creator,now,
        acceptedFull?new Date(accepted.windows[0].to):now);
      finish("skipped");return save();
    }
    let source;
    if (state.current?.creatorId===creator.id) {
      const [base]=await tx.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1',state.current.baseGeneration);
      source=base;
      if (!base || proof?.activeGeneration!==base.id) {
        // A newer provider publication won. Its evidence is checked on the
        // next unit; the old repair can no longer replace that authority.
        await generation.retireUnpublished(tx,state.current.generationId);
        state.current=null;return save();
      }
      const [build]=await tx.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1',state.current.generationId);
      if (build?.state==="REPAIRING") {
        await generation.repairUnpublishedPage(tx,build.id);
        return save();
      }
      if (build?.state==="RETIRED" && !build.publishedAt) {
        // A process can resume offline adoption after its old lease expired.
        // Repaired staging is immutable history; reuse the retained receipt in
        // a deterministic fresh build instead of restoring its old cursor or
        // requiring another provider traversal.
        state.current.generationId=digest([KEY,"resumed",build.id,build.retiredAt]);
      }
    } else if (proof?.activeGeneration) {
      [source]=await tx.$queryRawUnsafe('SELECT * FROM "CreatorEarningsGeneration" WHERE id=$1',proof.activeGeneration);
    }
    const [run]=source?await tx.$queryRawUnsafe('SELECT * FROM "FinancialReceiptRun" WHERE id=$1 FOR UPDATE',source.runId):[];
    const window=run?.windows?.[0], observed=run?.proof?.windows?.[0];
    const retained=source?.fullScan && run?.agencyId===creator.agencyId && run?.creatorId===creator.id
      && !run.detailsRetiredAt && !run.compactedAt && run.proof?.complete===true
      && run.windows.length===1 && window.kind==="FULL" && window.from===null
      && observed?.exhausted===true && observed?.matched===true && observed?.rejected===0;
    if (!retained) {
      state.counts.verificationQueued+=await queueFullVerification(tx,creator,now);
      finish("skipped");return save();
    }
    const repairId=state.current?.generationId||digest([KEY,run.id,source.id]);
    state.current={creatorId:creator.id,baseGeneration:source.id,generationId:repairId,runId:run.id};
    attempt={creator,generationId:repairId,cursor:state.cursor,revision:stored.revision,state:structuredClone(state)};
    const jobExists=await tx.jobInstance.findUnique({where:{id:run.jobId},select:{id:true}});
    const job={id:jobExists?.id||null,agencyId:creator.agencyId,creatorId:creator.id,createdAt:source.snapshotAt,
      params:{collectionContractVersion:1,collectionType:"FINANCIAL",collectionMode:"full",collectionGeneration:run.generation,
        collectionRequestedAt:source.snapshotAt.toISOString(),analyticsObservationStartedAt:source.snapshotAt.toISOString()}};
    const built=await generation.preparePage(tx,job,run,{generationId:repairId,repair:true});
    if (built.ready) {
      await generation.publish(tx,job,run,{generationId:repairId,repair:true});
      await require("./creator-entity-change-service").publishEntityChanges({db:tx,agencyId:creator.agencyId,creatorId:creator.id,
        changes:["HOME","TEAM","CAMPAIGN","AUDIENCE","TRAFFIC"].map(entityType=>({entityType,entityId:creator.id,
          sourceIdentity:KEY,sourceVersion:repairId,payload:{reason:"FINANCIAL_SNAPSHOT_RECONCILED",dataVersion:repairId}}))});
      finish("rebuilt");
    }
    return save();
  },{profile:"COMMAND",timeout:15000,statementTimeoutMs:10000,authority:{kind:"FINANCIAL_SNAPSHOT_ADOPTION"}});
  } catch(error) {
    const code=error.code||error.message;
    if (!attempt || !UNRECONSTRUCTIBLE.has(code)) throw error;
    // The failed build unit rolled back. Record its classified fallback in a
    // separate commit, guarded by the exact cursor revision we attempted.
    return runRootCommit(db,async({tx})=>{
      await tx.$executeRawUnsafe(`INSERT INTO "SystemSetting"(id,key,value,"updatedAt")
        VALUES($1,$1,'{}'::jsonb,clock_timestamp()) ON CONFLICT(key) DO NOTHING`,KEY);
      const [stored]=await tx.$queryRawUnsafe('SELECT * FROM "SystemSetting" WHERE key=$1 FOR UPDATE',KEY);
      if (!stored || stored.revision!==attempt.revision || (stored.value.cursor||"")!==attempt.cursor)
        return {complete:false,processed:0,counts:stored?.value?.counts};
      const now=await dbAuthorityNow({db:tx}),state=stored.value.version?stored.value:attempt.state,creator=attempt.creator;
      const lifecycle=await require("./agency-lifecycle-barrier-service").lockAgencyLifecycleBarrier({db:tx,agencyId:creator.agencyId});
      const live=await tx.$queryRawUnsafe('SELECT id FROM "CreatorAccount" WHERE id=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE',creator.id,creator.agencyId);
      await require("./db-transaction-service").lockDbAdvisoryXact({db:tx,key:`analytics-collector:financial:${creator.id}`});
      await generation.lock(tx,creator.id);
      await generation.retireUnpublished(tx,attempt.generationId);
      if(live.length && lifecycle.row && !lifecycle.row.deletedAt)state.counts.verificationQueued+=await queueFullVerification(tx,creator,now);
      state.cursor=creator.id;state.current=null;state.counts.visited++;state.counts.skipped++;
      state.counts.unreconstructible=(state.counts.unreconstructible||0)+1;
      state.lastFailure={creatorId:creator.id,code};
      await tx.systemSetting.update({where:{id:stored.id},data:{value:state,revision:{increment:1}}});
      return {complete:false,processed:1,counts:state.counts};
    },{profile:"COMMAND",timeout:15000,statementTimeoutMs:10000,authority:{kind:"FINANCIAL_SNAPSHOT_ADOPTION"}});
  }
}

async function runSweep({db=require("../prisma"),limit=20,maxRuntimeMs=4000}={}) {
  const started=performance.now(),budget=Math.max(1,Math.min(10000,Number(maxRuntimeMs)||4000));
  let result={complete:false,processed:0};
  for(let i=0;i<Math.max(1,Math.min(20,Number(limit)||20));i++) {
    if(i>0 && performance.now()-started>=budget)break;
    const current=await page({db});result={...current,processed:result.processed+current.processed};
    if(current.complete)break;
  }
  return {ok:true,...result};
}
module.exports={KEY,queueFullVerification,pendingOfflineAdoption,page,runSweep};
