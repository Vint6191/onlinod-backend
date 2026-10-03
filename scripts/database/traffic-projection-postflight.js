"use strict";

const TRIGGERS = Object.freeze({
  traffic_source_writer_v3: "TrafficSource",
  traffic_member_writer_v3: "TrafficSourceMember",
  traffic_metric_writer_v3: "TrafficMetric",
  traffic_receipt_writer_v3: "TrafficReceiptProjection",
  traffic_backfill_writer_v3: "TrafficProjectionBackfillData",
  traffic_seed_writer_v3: "TrafficProjectionSeed",
  traffic_fan_writer_v3: "TrafficFanProjection",
  traffic_work_guard_v3: "DomainWorkItem",
});
async function verify(db) {
  const signals=await db.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='TrafficFanSignal'`);
  for(const name of ["id","agencyId","creatorId","fanId","lastRevenueAt"])
    if(!signals.some(r=>r.column_name===name))throw new Error("TRAFFIC_PROJECTION_SIGNAL_MISSING:"+name);
  const rows = await db.$queryRawUnsafe(`SELECT t.tgname AS name,t.tgenabled AS enabled,c.relname AS table,p.proname AS fn
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=current_schema() AND t.tgname=ANY($1::text[])`, Object.keys(TRIGGERS));
  for (const [name, table] of Object.entries(TRIGGERS)) {
    const r=rows.find(row=>row.name===name);
    if (!r || r.table!==table || !["O","A"].includes(r.enabled)
      || r.fn!==(name==="traffic_work_guard_v3"?"onlinod_traffic_work_guard_v3":"onlinod_traffic_projection_guard_v3")) {
      throw new Error("TRAFFIC_PROJECTION_TRIGGER_INVALID:"+name);
    }
  }
  const capture = await db.$queryRawUnsafe(`SELECT p.proname AS name,pg_get_functiondef(p.oid) AS body
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema()
      AND p.proname=ANY($1::text[])`,["onlinod_traffic_canonical_capture_v2","onlinod_traffic_receipt_capture_v2"]);
  if (capture.length!==2 || capture.some(r=>!r.body.includes('"onlinod_traffic_publish_fact_v3"')
    || r.body.includes('"onlinod_traffic_project_') || r.body.includes('"onlinod_traffic_receipt_project_'))) {
    throw new Error("TRAFFIC_PROJECTION_INLINE_WRITER_PRESENT");
  }
  const views = await db.$queryRawUnsafe(`SELECT pg_get_viewdef(c.oid) AS definition FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
      AND c.relname='TrafficProjectionBackfill' AND c.relkind='v'`);
  if (views.length!==1 || !/NULL::timestamp[^,]*AS "completedAt"/.test(views[0].definition)
    || !views[0].definition.includes('"TrafficProjectionBackfillData"')) throw new Error("TRAFFIC_PROJECTION_OLD_READER_UNFENCED");
  return { ready:true,version:3,fences:rows.length };
}
module.exports={verify};
if(require.main===module){const db=require("../../src/prisma");verify(db).then(r=>console.log(JSON.stringify(r)))
  .catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());}
