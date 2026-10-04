"use strict";
async function verify(db) {
  const rows = await db.$queryRawUnsafe(`SELECT t.tgname AS name,t.tgenabled AS enabled,
    t.tgtype AS type,p.proname AS fn,c.relname AS table_name
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=current_schema()
      AND t.tgname=ANY($1::text[])`,["campaign_refresh_work_writer_v2","campaign_refresh_work_scope_v2"]);
  for (const [name,type] of [["campaign_refresh_work_writer_v2",22],["campaign_refresh_work_scope_v2",23]]) {
    const r=rows.find(x=>x.name===name);
    if (!r || !["O","A"].includes(r.enabled) || r.fn!=="onlinod_"+name || Number(r.type)!==type
      || r.table_name!=="CreatorCampaignFanRefreshWork") throw new Error("CAMPAIGN_REFRESH_WORK_FENCE_INVALID:"+name);
  }
  const unique=await db.$queryRawUnsafe(`SELECT i.indisvalid AND i.indisready AND i.indisunique
      AND NOT i.indnullsnotdistinct AND i.indpred IS NULL AS valid,t.relname AS table_name,
      ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnkeyatts) k ORDER BY k) AS keys
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname='CreatorCampaignFanRefreshWork_creator_run_fan_key'`);
  if (unique.length!==1 || !unique[0].valid || unique[0].table_name!=="CreatorCampaignFanRefreshWork"
    || JSON.stringify(unique[0].keys)!==JSON.stringify(['"creatorId"','"scanRunId"','"onlyFansUserId"'])) {
    throw new Error("CAMPAIGN_REFRESH_WORK_CARDINALITY_INDEX_INVALID");
  }
  return {ready:true,version:2,fences:rows.length};
}
module.exports={verify};
if(require.main===module){const db=require("../../src/prisma");verify(db).then(r=>console.log(JSON.stringify(r)))
  .catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());}
