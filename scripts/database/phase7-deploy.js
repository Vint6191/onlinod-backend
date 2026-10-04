#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {migrationChecksumReport}=require('./phase7-migration-checksum');
const {reviewHistoricalMigration}=require('./phase7-historical-migrations');
const root=path.resolve(__dirname,'../..');
const CONTRACT='20260930190000_phase7_legacy_storage_contract_v1';
const PRE=[['phase5-notification-history-indexes-online-preflight.js'],['phase4-execution-indexes-online-preflight.js'],['phase4-single-owner-preflight.js'],['phase3-analytics-legacy-snapshot-online-preflight.js'],['phase3-fandata-delivery-provenance-online-preflight.js'],['phase3-campaign-coverage-generation-online-preflight.js'],['phase3-a29-maintenance-check-online-preflight.js'],['phase3-domain-work-claim-online-rollout.js','--preflight']];
const POST=[['analytics-traffic-indexes.js','--create'],['campaign-observation-postflight.js'],['campaign-bounded-postflight.js'],['campaign-traversal-postflight.js'],['campaign-value-refresh-postflight.js'],['traffic-projection-postflight.js'],['campaign-refresh-work-postflight.js'],['campaign-membership-proof-postflight.js'],['campaign-fair-pages-postflight.js'],['analytics-fact-publication-postflight.js'],['provider-capacity-catalog-postflight.js'],['phase3-domain-work-claim-online-rollout.js','--activate'],['phase3-subscriber-publication-schema-online-postflight.js'],['phase3-analytics-legacy-snapshot-online-postflight.js'],['actual60-refreshsession-online-index-preflight.js']];
function run(args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,env:process.env,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('PHASE7_DEPLOY_CHILD_FAILED:'+code)));});}
async function migrationPlan(db,{contract=false,onCompatibility=report=>console.log(JSON.stringify(report)),onHistorical=report=>console.log(JSON.stringify(report))}={}){
  const dir=path.join(root,'prisma/migrations');const names=(await fs.readdir(dir,{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
  if(!names.includes(CONTRACT))throw new Error('PHASE7_CANONICAL_CONTRACT_MISSING');
  const table=await db.$queryRawUnsafe(`SELECT to_regclass('public._prisma_migrations')::text AS name`);
  const applied=table[0].name?await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY started_at'):[];
  const mismatches=[],compatible=[],verifiedApplied=new Map();
  for(const row of applied){if(row.rolled_back_at)continue;if(!row.finished_at)throw new Error('PHASE7_FAILED_MIGRATION_REQUIRES_RESOLUTION:'+row.migration_name);
    if(!names.includes(row.migration_name))throw new Error('PHASE7_UNKNOWN_APPLIED_MIGRATION:'+row.migration_name);
    const bytes=await fs.readFile(path.join(dir,row.migration_name,'migration.sql'));
    let report;
    try{report=migrationChecksumReport(bytes,row.checksum);}catch(error){throw new Error(error.message+':'+row.migration_name);}
    if(!report.matches)mismatches.push({migration:row.migration_name,...report});
    else {
      verifiedApplied.set(row.migration_name,report);
      if(report.matchMode!=='RAW')compatible.push({migration:row.migration_name,matchMode:report.matchMode});
    }
  }
  const unresolved=[],historical=[];
  for(const mismatch of mismatches){
    const review=await reviewHistoricalMigration(mismatch.migration,mismatch,verifiedApplied);
    if(review.accepted)historical.push(review);
    else unresolved.push({...mismatch,...(review.reason?{historicalReason:review.reason,missingRepairs:review.missingRepairs||[]}: {})});
  }
  if(unresolved.length){
    const error=new Error('PHASE7_MIGRATION_CHECKSUM_MISMATCH:'+unresolved[0].migration);
    error.phase7Diagnostics={event:'PHASE7_MIGRATION_HISTORY_MISMATCH',total:unresolved.length,shown:Math.min(unresolved.length,20),migrations:unresolved.slice(0,20)};
    throw error;
  }
  if(compatible.length)onCompatibility({event:'PHASE7_MIGRATION_CHECKSUM_COMPATIBILITY',total:compatible.length,migrations:compatible});
  if(historical.length)onHistorical({event:'PHASE7_VERIFIED_HISTORICAL_MIGRATIONS',total:historical.length,migrations:historical});
  const purged=applied.some(x=>x.migration_name===CONTRACT&&x.finished_at&&!x.rolled_back_at);
  const fresh=!applied.some(x=>x.finished_at&&!x.rolled_back_at);
  if(fresh){const tables=await db.$queryRawUnsafe(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v') AND c.relname<>'_prisma_migrations' LIMIT 1`);if(tables.length)throw new Error('PHASE7_UNBASELINED_DATABASE');}
  return {fresh,purged,names:(contract||purged)?names:names.filter(x=>x!==CONTRACT)};
}
async function main({db=require('../../src/prisma'),contract=process.argv.includes('--contract'),hooks=true,commandRunner=run}={}){
  const plan=await migrationPlan(db,{contract});
  const rolesBefore=await require('./phase7-role-preflight').inspectRoles(db,{strict:contract});
  console.log(JSON.stringify({phase7Roles:rolesBefore}));
  await db.$disconnect();
  if(hooks&&!plan.fresh)for(const [script,...args]of PRE)await commandRunner([path.join(__dirname,script),...args]);
  if(contract&&!plan.purged){await require('../../src/services/phase7-retirement-finalizer').checkContractReady(db);}
  await db.$disconnect();
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'onlinod-phase7-deploy-'));
  try{
    await fs.copyFile(path.join(root,'prisma/schema.prisma'),path.join(temp,'schema.prisma'));
    await fs.mkdir(path.join(temp,'migrations'));
    await fs.copyFile(path.join(root,'prisma/migrations/migration_lock.toml'),path.join(temp,'migrations/migration_lock.toml'));
    for(const name of plan.names)await fs.cp(path.join(root,'prisma/migrations',name),path.join(temp,'migrations',name),{recursive:true});
    await commandRunner([path.join(root,'node_modules/prisma/build/index.js'),'migrate','deploy','--schema',path.join(temp,'schema.prisma')]);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
  // Fresh installs pass the same guards after the canonical history creates
  // their base tables. Existing installations preserve all prior preflights.
  if(hooks){if(plan.fresh)for(const [script,...args]of PRE)await commandRunner([path.join(__dirname,script),...args]);for(const [script,...args]of POST)await commandRunner([path.join(__dirname,script),...args]);
    await commandRunner([path.join(__dirname,'phase7-legacy-storage-indexes.js'),'--create']);}
  const storage=await require('../../src/services/phase7-legacy-storage-service').storageState(db);
  console.log(JSON.stringify({ok:true,fresh:plan.fresh,migrations:plan.names.length,storage}));return storage;
}
function reportFailure(error,write=line=>console.error(line)){
  const diagnostic=error.phase7Diagnostics;
  if(diagnostic?.event==='PHASE7_ARCHIVE_PHYSICAL_SHAPE_MISMATCH'&&Array.isArray(diagnostic.tables)){
    const {tables,...summary}=diagnostic;
    write(JSON.stringify(summary));
    // Emit every table and difference separately so one large JSON line cannot
    // hide later mismatches in a hosted build log.
    for(const {differences,...table} of tables){
      write(JSON.stringify({event:'PHASE7_ARCHIVE_TABLE_SHAPE_DIFF',...table,totalDifferences:differences.length}));
      for(const difference of differences)write(JSON.stringify({event:'PHASE7_ARCHIVE_SHAPE_DETAIL',table:table.table,...difference}));
    }
  }else if(diagnostic)write(JSON.stringify(diagnostic));
  write(error.code||error.message);
}
module.exports={main,migrationPlan,reportFailure,CONTRACT,PRE,POST};
if(require.main===module){const db=require('../../src/prisma');main({db}).catch(e=>{reportFailure(e);process.exitCode=1;}).finally(()=>db.$disconnect());}
