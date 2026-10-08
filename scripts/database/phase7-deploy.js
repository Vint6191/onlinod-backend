#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {runStage,stageTimeout}=require('./phase7-deploy-child');
const {checkInterrupted,processInterrupts,disconnectAll,retainFailure}=require('./phase7-deploy-lifecycle');
const {migrationChecksumReport}=require('./phase7-migration-checksum');
const {reviewHistoricalMigration}=require('./phase7-historical-migrations');
const {withDeploymentAuthority}=require('./phase7-deploy-authority');
const {captureMigrationSource,verifyStagedMigrationSource,verifyMigrationSource,assertCompletedLedger}=require('./phase7-deploy-integrity');
const root=path.resolve(__dirname,'../..');
const CONTRACT='20260930190000_phase7_legacy_storage_contract_v1';
const PRE=[['phase5-notification-history-indexes-online-preflight.js'],['phase4-execution-indexes-online-preflight.js'],['phase4-single-owner-preflight.js'],['phase3-analytics-legacy-snapshot-online-preflight.js'],['phase3-fandata-delivery-provenance-online-preflight.js'],['phase3-campaign-coverage-generation-online-preflight.js'],['phase3-a29-maintenance-check-online-preflight.js'],['phase3-domain-work-claim-online-rollout.js','--preflight']];
const POST=[['external-delivery-indexes.js','--create'],['external-delivery-postflight.js'],['background-maintenance-indexes.js','--create'],['maintenance-runtime-postflight.js'],['analytics-traffic-indexes.js','--create'],['campaign-observation-postflight.js'],['campaign-bounded-postflight.js'],['campaign-traversal-postflight.js'],['campaign-value-refresh-postflight.js'],['traffic-projection-postflight.js'],['campaign-refresh-work-postflight.js'],['campaign-membership-proof-postflight.js'],['campaign-fair-pages-postflight.js'],['analytics-fact-publication-postflight.js'],['provider-capacity-catalog-postflight.js'],['phase3-domain-work-claim-online-rollout.js','--activate'],['phase3-subscriber-publication-schema-online-postflight.js'],['phase3-analytics-legacy-snapshot-online-postflight.js'],['actual60-refreshsession-online-index-preflight.js']];
async function migrationPlan(db,{contract=false,signal,snapshot,onCompatibility=report=>console.log(JSON.stringify(report)),onHistorical=report=>console.log(JSON.stringify(report))}={}){
  const check=phase=>checkInterrupted(signal,phase);
  check('migration-inventory');
  const dir=path.join(root,'prisma/migrations');const names=snapshot?.names||(await fs.readdir(dir,{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
  check('migration-history');
  if(!names.includes(CONTRACT))throw new Error('PHASE7_CANONICAL_CONTRACT_MISSING');
  const table=await db.$queryRawUnsafe(`SELECT to_regclass('public._prisma_migrations')::text AS name`);
  check('migration-history');
  const applied=table[0].name?await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at,id,started_at FROM "_prisma_migrations" ORDER BY started_at'):[];
  check('migration-checksums');
  const mismatches=[],compatible=[],verifiedApplied=new Map(),appliedNames=new Set();
  for(const row of applied){if(row.rolled_back_at)continue;if(!row.finished_at)throw new Error('PHASE7_FAILED_MIGRATION_REQUIRES_RESOLUTION:'+row.migration_name);
    if(!names.includes(row.migration_name))throw new Error('PHASE7_UNKNOWN_APPLIED_MIGRATION:'+row.migration_name);
    if(appliedNames.has(row.migration_name))throw new Error('PHASE7_DUPLICATE_APPLIED_MIGRATION:'+row.migration_name);
    appliedNames.add(row.migration_name);
    const bytes=snapshot?snapshot.files.get(`migrations/${row.migration_name}/migration.sql`):await fs.readFile(path.join(dir,row.migration_name,'migration.sql'));
    check('migration-checksums');
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
    check('historical-migration-review');
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
  check('migration-plan-complete');
  return {fresh,purged,names:(contract||purged)?names:names.filter(x=>x!==CONTRACT),appliedNames:[...appliedNames].sort(),
    appliedReceipts:applied.filter(row=>!row.rolled_back_at).map(row=>({...row}))};
}
function deployArguments(argv){
  const options={contract:false};const seen=new Set();
  for(const arg of argv){
    const key=arg.split('=',1)[0];
    if(seen.has(key))throw new Error('PHASE7_DEPLOY_ARGUMENT_DUPLICATE');seen.add(key);
    if(arg==='--contract')options.contract=true;
    else if(arg.startsWith('--release-file=')&&arg.length>'--release-file='.length)options.releaseFile=arg.slice('--release-file='.length);
    else throw new Error('PHASE7_DEPLOY_ARGUMENT_INVALID');
  }
  if(options.releaseFile&&!options.contract)throw new Error('PHASE7_RELEASE_REQUIRES_CONTRACT');
  return options;
}
async function executeDeployment({db=require('../../src/prisma'),contract=false,releaseFile,hooks=true,signal,commandRunner,timeoutMs,assertCurrent,emitResult}={}){
  const check=phase=>checkInterrupted(signal,phase);
  const invoke=commandRunner||((args,options)=>runStage(args,{cwd:root,timeoutMs,...options}));
  commandRunner=async args=>{check('before-child');await assertCurrent('before-child');const result=await invoke(args,{signal});check('after-child');await assertCurrent('after-child');return result;};
  check('before-source-snapshot');
  const snapshot=await captureMigrationSource(root);
  check('source-snapshot-complete');
  const plan=await migrationPlan(db,{contract,signal,snapshot});
  let completedPlan=null;
  const verifyLedger=async phase=>{
    check(phase);await assertCurrent(phase);
    const observed=await migrationPlan(db,{contract,signal,snapshot,onCompatibility(){},onHistorical(){}});
    assertCompletedLedger(completedPlan||plan,observed);
    completedPlan||={...plan,appliedReceipts:observed.appliedReceipts};check(phase);
  };
  check('role-preflight');
  const rolesBefore=await require('./phase7-role-preflight').inspectRoles(db,{strict:contract});
  check('role-preflight-complete');
  console.log(JSON.stringify({phase7Roles:rolesBefore}));
  await db.$disconnect();
  check('before-preflights');
  if(hooks&&!plan.fresh)for(const [script,...args]of PRE)await commandRunner([path.join(__dirname,script),...args]);
  let admission=null;
  if(contract&&!plan.purged){admission=await require('../../src/services/phase7-retirement-finalizer').checkContractReady(db,{root,releaseFile});if(!admission?.ready)throw new Error('PHASE7_CONTRACT_NOT_PREPARED');}
  check('contract-admission-complete');
  await db.$disconnect();
  check('before-staging');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'onlinod-phase7-deploy-'));
  let stageFailure;
  try{
    // Ownership is established before observing cancellation after allocation.
    check('staging-created');
    await fs.copyFile(path.join(root,'prisma/schema.prisma'),path.join(temp,'schema.prisma'));
    check('stage-schema');
    await fs.mkdir(path.join(temp,'migrations'));
    check('stage-migrations');
    await fs.copyFile(path.join(root,'prisma/migrations/migration_lock.toml'),path.join(temp,'migrations/migration_lock.toml'));
    for(const name of plan.names){check('stage-migrations');await fs.cp(path.join(root,'prisma/migrations',name),path.join(temp,'migrations',name),{recursive:true});}
    check('staged-source');
    await verifyStagedMigrationSource(temp,plan.names,snapshot);
    await verifyMigrationSource(root,snapshot);
    check('staged-source-snapshot-verified');
    if(admission){
      await require('./phase7-release-source').verifyStagedRelease(root,temp,plan.names,{file:releaseFile,expectedRelease:admission.release});
      check('staged-source-verified');
      const latest=await require('../../src/services/phase7-retirement-finalizer').checkContractReady(db,{root,releaseFile});
      check('final-contract-admission');
      require('./phase7-release-source').sameRelease(admission.release,latest.release);
      await db.$disconnect();
    }
    await commandRunner([path.join(root,'node_modules/prisma/build/index.js'),'migrate','deploy','--schema',path.join(temp,'schema.prisma')]);
    await verifyLedger('migration-ledger-verified');
  }catch(error){stageFailure=error;throw error;}
  finally{try{await fs.rm(temp,{recursive:true,force:true});}catch(error){throw retainFailure(stageFailure,error);}}
  check('staging-cleanup-complete');
  // Fresh installs pass the same guards after the canonical history creates
  // their base tables. Existing installations preserve all prior preflights.
  if(hooks){if(plan.fresh)for(const [script,...args]of PRE)await commandRunner([path.join(__dirname,script),...args]);for(const [script,...args]of POST)await commandRunner([path.join(__dirname,script),...args]);
    await commandRunner([path.join(__dirname,'phase7-legacy-storage-indexes.js'),'--create']);}
  await verifyLedger('final-ledger-verified');
  await verifyMigrationSource(root,snapshot);
  check('final-source-verified');
  const storage=await require('../../src/services/phase7-legacy-storage-service').storageState(db);
  check('storage-verified');
  await assertCurrent('final-storage-verified');
  emitResult({ok:true,fresh:plan.fresh,migrations:plan.names.length,migrationSourceHash:snapshot.hash,storage});return storage;
}
async function main(options={}){
  let receipt;
  const storage=await withDeploymentAuthority({signal:options.signal},scope=>executeDeployment({...options,
    signal:scope.signal,assertCurrent:scope.assertCurrent,emitResult:value=>{receipt=value;}}));
  checkInterrupted(options.signal,'before-result');
  (options.emitResult||((result)=>console.log(JSON.stringify(result))))(receipt);
  return storage;
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
  for(const cleanupError of error.cleanupErrors||[])write(JSON.stringify({event:'PHASE7_CLEANUP_FAILED',code:cleanupError.code||'CLEANUP_FAILED'}));
  write(error.code||error.message);
}
async function cli(){
  const control=processInterrupts();let db,receipt,failure;
  try{
    const options=deployArguments(process.argv.slice(2)),timeoutMs=stageTimeout();
    db=require('../../src/prisma');
    await main({db,...options,timeoutMs,signal:control.signal,emitResult:value=>{receipt=value;}});
  }catch(error){failure=error;}
  try{await disconnectAll([db]);}catch(error){failure=retainFailure(failure,error);}
  try{
    try{control.check('final-publication');}catch(error){failure=failure||error;}
    if(failure){reportFailure(failure);process.exitCode=control.exitCode();}
    else console.log(JSON.stringify(receipt));
  }finally{control.dispose();}
}
module.exports={main,migrationPlan,reportFailure,deployArguments,cli,CONTRACT,PRE,POST};
if(require.main===module)cli().catch(error=>{reportFailure(error);process.exitCode=1;});
