"use strict";
async function verify(db) {
  const columns=await db.$queryRawUnsafe(`SELECT "is_nullable","column_default" FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='CampaignFanRefreshPromotionSignal' AND column_name='healAfterId'`);
  if(columns.length!==1 || columns[0].is_nullable!=='NO' || !columns[0].column_default)throw new Error("CAMPAIGN_VALUE_REFRESH_CURSOR_MISSING");
  const rows = await db.$queryRawUnsafe(`SELECT p.proname AS name,pg_get_functiondef(p.oid) AS body
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema()
      AND p.proname=ANY($1::text[])`,["onlinod_campaign_projection_assert_v2","onlinod_campaign_projection_policy_v2"]);
  for (const name of ["onlinod_campaign_projection_assert_v2","onlinod_campaign_projection_policy_v2"]) {
    if (!rows.find(row=>row.name===name)?.body.includes("onlinod.campaign_value_refresh_version")) {
      throw new Error("CAMPAIGN_VALUE_REFRESH_FENCE_INVALID:"+name);
    }
  }
  const fences=await db.$queryRawUnsafe(`SELECT t.tgname AS name,t.tgenabled AS enabled,p.proname AS fn
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=current_schema()
      AND t.tgname=ANY($1::text[])`,["campaign_receipt_writer_v2","campaign_metric_writer_v2","campaign_state_writer_v2","campaign_seed_writer_v2","campaign_work_ack_v2"]);
  for (const name of ["campaign_receipt_writer_v2","campaign_metric_writer_v2","campaign_state_writer_v2","campaign_seed_writer_v2","campaign_work_ack_v2"]) {
    const row=fences.find(r=>r.name===name);
    if (!row || !["O","A"].includes(row.enabled) || row.fn!==(name==="campaign_work_ack_v2"?"onlinod_campaign_projection_ack_v2":"onlinod_campaign_projection_guard_v2")) throw new Error("CAMPAIGN_VALUE_REFRESH_TRIGGER_INVALID:"+name);
  }
  return {ready:true,fences:fences.length};
}
module.exports={verify};
if(require.main===module){const db=require("../../src/prisma");verify(db).then(v=>console.log(JSON.stringify(v)))
  .catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());}
