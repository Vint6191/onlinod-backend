'use strict';
const {manifest,q,sha,failure}=require('../../src/services/phase7-legacy-storage-service');
const definitions=[];
for(const t of manifest.tables) if(t.scopeColumn) {
  const columns=[[t.scopeColumn,'id']];
  for(const key of ['creatorId','profileId']) if(t.columns.includes(key) && key!==t.scopeColumn) columns.push([t.scopeColumn,key,'id']);
  for(const keys of columns) definitions.push({table:t.table,keys,name:'phase7_archive_'+sha(t.table+keys.join(',')).slice(0,20),where:null});
}
for(const [table,column,states] of [['AutomationDelivery','status',"'CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED'"],['JobInstance','status',"'CLAIMED','RUNNING'"],['DomainWorkItem','state',"'CLAIMED'"]]) definitions.push({table,keys:['id'],name:'phase7_old_executor_'+table.toLowerCase(),where:`"legacyStorageGeneration" IS DISTINCT FROM 'phase7_legacy_storage_v1' AND ${q(column)} ${states.includes(',')?'IN ('+states+')':'='+states}`});
definitions.push({table:'AutomationDelivery',keys:['agencyId','id'],name:'phase7_missing_cleanup_proof',where:`"moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET' AND "payload"->>'legacyMigration'='true' AND "legacyCleanupProofId" IS NULL AND "status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED')`});
const cleanup=require('../../src/services/phase7-cleanup-contract');
definitions.push({table:'AutomationDelivery',keys:['agencyId','id'],name:'phase7_cleanup_lifecycle',where:cleanup.LEGACY_SQL});
definitions.push({table:'AutomationDelivery',keys:['agencyId','creatorId','id'],name:'phase7_cleanup_unsettled',where:cleanup.UNSETTLED_SQL});
definitions.push({table:'AutomationDelivery',keys:['agencyId','creatorId','id'],name:'phase7_follow_inflight',where:`"moduleKey"='sfs' AND "actionType"='SFS_FOLLOW_TARGET' AND "status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED')`});
definitions.push({table:'SfsTargetCandidate',keys:['agencyId','creatorId','id'],name:'phase7_owned_candidate',where:`"completedAt" IS NULL AND ("metadata"->>'followEffectOwnership'='OWNED' OR "metadata"->>'legacyMigration'='true')`});
function normalizePredicate(value){
  const literals=[];
  const masked=String(value||'').replace(/'(?:[^']|'')*'/g,s=>{literals.push(s);return `__L${literals.length-1}__`;});
  return masked.replace(/::text\[\]|::text|::jsonb/g,'').replace(/=\s*ANY\s*\(ARRAY\[(.*?)\]\)/gi,'IN($1)').replace(/[\s()"]/g,'').replace(/__L(\d+)__/g,(_m,n)=>literals[Number(n)]);
}
async function catalog(db,tables){
 return db.$queryRawUnsafe(`SELECT t.relname AS table,i.relname AS name,x.indisvalid AS valid,x.indisready AS ready,pg_get_expr(x.indpred,x.indrelid) AS predicate,
    ARRAY(SELECT a.attname::text FROM unnest(x.indkey::smallint[]) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=k.attnum WHERE k.ord<=x.indnkeyatts ORDER BY k.ord) AS keys
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=i.relam
    WHERE n.nspname=current_schema() AND t.relname=ANY($1::text[]) AND am.amname='btree'`,tables);
}
async function state(db,d,cache){
  const rows=(cache||await catalog(db,[d.table])).filter(r=>r.table===d.table);
  const named=rows.find(r=>r.name===d.name);
  // Partial contracts use exact operator-owned index definitions; arbitrary
  // predicates with the same key prefix never satisfy admission.
  const valid=rows.some(r=>r.valid&&r.ready&&d.keys.every((k,i)=>r.keys[i]===k)&&(d.where?r.name===d.name&&normalizePredicate(r.predicate)===normalizePredicate(d.where):!r.predicate));
  return {valid,named};
}
async function ensureIndexes(db,{create=false}={}){
  const present=await db.$queryRawUnsafe('SELECT "id","state" FROM "Phase7RetirementCohort"');const states=new Map(present.map(r=>[r.id,r.state]));
  const indexes=await catalog(db,[...new Set(definitions.map(d=>d.table))]);
  for(const d of definitions){
    const t=manifest.tables.find(t=>t.table===d.table);if(t&&states.get(t.cohort)==='PURGED')continue;
    let s=await state(db,d,indexes);if(s.valid)continue;
    if(!create)throw failure('PHASE7_ARCHIVE_INDEX_REQUIRED',{index:d.name});
    if(s.named)throw failure('PHASE7_INDEX_INVALID_REPAIR_REQUIRED',{index:d.name});
    // Dedicated connection, autocommit, and finite build budget. Never wrap
    // CONCURRENTLY in an application transaction or silently drop an invalid index.
    await db.$executeRawUnsafe(`CREATE INDEX CONCURRENTLY ${q(d.name)} ON ${q(d.table)} (${d.keys.map(q).join(',')})${d.where?' WHERE '+d.where:''}`);
    s=await state(db,d);if(!s.valid)throw failure('PHASE7_INDEX_BUILD_INVALID',{index:d.name});
  }
  return {ready:true,contracts:definitions.length};
}
module.exports={definitions,ensureIndexes,state,catalog,normalizePredicate};
if(require.main===module){
 require('dotenv').config();
 const {PrismaClient}=require('@prisma/client');const url=new URL(process.env.DATABASE_URL);url.searchParams.set('connection_limit','1');
 const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
 (async()=>{await db.$executeRawUnsafe("SET lock_timeout='5s'");await db.$executeRawUnsafe("SET statement_timeout='10min'");return ensureIndexes(db,{create:process.argv.includes('--create')});})()
 .then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.code||e.message);process.exitCode=1;}).finally(()=>db.$disconnect());
}
