#!/usr/bin/env node
'use strict';
require('dotenv').config();
const path=require('node:path');const {COHORTS,storageState,failure,runDbTransaction}=require('../../src/services/phase7-legacy-storage-service');
const runner=require('../../src/services/phase7-retirement-runner');const finalizer=require('../../src/services/phase7-retirement-finalizer');
function args(argv){const o={command:argv[0]||'status'};for(const arg of argv.slice(1)){if(!arg.startsWith('--'))throw failure('PHASE7_UNKNOWN_ARGUMENT');const [k,...v]=arg.slice(2).split('=');o[k]=v.length?v.join('='):true;}return o;}
const json=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v);
async function main({db=require('../../src/prisma'),options=args(process.argv.slice(2)),emit=x=>console.log(json(x))}={}){
 const o=options,steps=Math.max(1,Math.min(100,Number(o.steps)||1));
 if(o.command==='status'){const result={...await storageState(db),partitions:await db.phase7RetirementPartition.findMany({where:{...(o.after?{id:{gt:o.after}}:{}),...(o.state?{state:o.state}:{})},orderBy:{id:'asc'},take:51})};result.hasMore=result.partitions.length>50;result.partitions=result.partitions.slice(0,50);result.nextCursor=result.hasMore?result.partitions.at(-1).id:null;emit(result);return result;}
 if(o.command==='indexes'){const result=await require('../database/phase7-legacy-storage-indexes').ensureIndexes(db,{create:!!o.create});emit(result);return result;}
 if(o.command==='resume'){if(!o.id)throw failure('PHASE7_PARTITION_ID_REQUIRED');const r=await runner.resumePartition({db,id:o.id});emit(r);return r;}
 if(o.command==='prepare-contract'){const release=await finalizer.readRelease(path.resolve(__dirname,'../..'));const {evidence}=await require('../../src/services/phase7-contract-evidence').readEvidence(o['operator-evidence'],release);const r=await finalizer.prepareContract({db,release,closeRollback:o['close-rollback']===true,operatorEvidence:evidence});emit(r);return r;}
 if(!['run','enumerate','verify','handoff'].includes(o.command))throw failure('PHASE7_UNKNOWN_COMMAND');
 await require('../database/phase7-legacy-storage-indexes').ensureIndexes(db);
 if(o.command==='run'&&!o['archive-dir'])throw failure('PHASE7_ARCHIVE_DIRECTORY_REQUIRED');
 if(o.command==='verify'&&!o['restore-dir'])throw failure('PHASE7_RESTORE_DIRECTORY_REQUIRED');
 let blocked=0;
 for(let step=0;step<steps;step++){
  if(['run','enumerate'].includes(o.command))for(const cohortId of COHORTS)emit({cohortId,...await runner.enumerateCohort({db,cohortId,budget:8})});
  if(o.command==='run'){const partition=await runner.claimPartition(db);if(!partition){emit({idle:true});break;}try{emit(await runner.processPartition({db,partition,directory:o['archive-dir'],limit:100}));}catch(error){blocked++;emit({ok:false,partitionId:partition.id,code:error.code||error.message});}}
  if(o.command==='verify'){const p=await db.phase7RetirementPartition.findFirst({where:{state:'EXPORTED'},orderBy:[{updatedAt:'asc'},{id:'asc'}],select:{id:true}});if(!p){emit({idle:true});break;}emit(await runner.verifyPartitionPage({db,partitionId:p.id,directory:o['restore-dir']}));}
  if(o.command==='handoff'){
   const cohort=await db.phase7RetirementCohort.findUnique({where:{id:'automation_job'}});
   const r=await require('../../src/services/phase7-obligation-handoff-service').handoffCleanupPage({db,after:cohort.enumeration?._cleanup||null,limit:20});
   // Repeated/concurrent runs are idempotent. Completed sweeps rotate back to
   // blocked identities; the contract independently checks the missing-proof index.
   await runDbTransaction(db,tx=>tx.$executeRawUnsafe(`UPDATE "Phase7RetirementCohort" SET "enumeration"=jsonb_set("enumeration",'{_cleanup}',$1::jsonb),"revision"="revision"+1 WHERE "id"='automation_job'`,json(r.hasMore?r.nextCursor:null)));
   emit(r);if(!r.hasMore)break;
  }
 }
 if(blocked)throw failure('PHASE7_PARTITIONS_BLOCKED',{count:blocked});
}
module.exports={main,args};
if(require.main===module){const db=require('../../src/prisma');main({db}).catch(e=>{console.error(json({ok:false,code:e.code||e.message,partitionId:e.partitionId,rowId:e.rowId,sourceId:e.sourceId}));process.exitCode=1;}).finally(()=>db.$disconnect());}
