'use strict';
const {manifest,failure}=require('../../src/services/phase7-legacy-storage-service');
async function check(db){
  const exists=await db.$queryRawUnsafe(`SELECT to_regclass('public."Phase7RetirementCohort"')::text AS name`);if(!exists[0]?.name)return null;
  const states=await db.$queryRawUnsafe(`SELECT "state","planHash" FROM "Phase7RetirementCohort" WHERE "id"='analytics_compat'`);
  const state=states[0];if(!state||state.planHash!==manifest.planHash)throw failure('PHASE7_SNAPSHOT_COHORT_INVALID');
  const tables=manifest.tables.filter(t=>t.cohort==='analytics_compat');
  for(const t of tables){
    const relation=await db.$queryRawUnsafe(`SELECT c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=$1`,t.table);
    if(state.state==='PURGED'){if(relation.length)throw failure('PHASE7_SNAPSHOT_REAPPEARED');continue;}
    if(relation[0]?.kind!=='r')throw failure('PHASE7_SNAPSHOT_BRIDGE_MISSING');
    const columns=await db.$queryRawUnsafe(`SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped`,'"'+t.table+'"');
    if(t.columns.some(c=>!columns.some(r=>r.attname===c)))throw failure('PHASE7_SNAPSHOT_COLUMNS_MISSING');
    const triggers=await db.$queryRawUnsafe(`SELECT tgname,tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname IN ('phase7_storage_fence','phase7_truncate_fence')`,'"'+t.table+'"');
    if(triggers.length!==2||triggers.some(t=>!['O','A'].includes(t.enabled)))throw failure('PHASE7_SNAPSHOT_FENCE_MISSING');
  }
  return {ok:true,phase:state.state==='PURGED'?'PHASE7_PURGED':'PHASE7_READ_ONLY_BRIDGE',destructivePurgeAllowed:false};
}
module.exports={check};
