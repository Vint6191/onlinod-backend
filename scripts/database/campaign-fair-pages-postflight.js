"use strict";
const SPECS = [
  { table: "CreatorCampaign", name: "campaign_fair_cursor_guard_v1_trg", fn: "campaign_fair_cursor_guard_v1", timing: /BEFORE/, events: ["INSERT", "UPDATE"], columns: [], markers: ["onlinod.campaign_fair_pages_version", "CAMPAIGN_FAIR_CURSOR_TRANSITION_INVALID", "CAMPAIGN_FAIR_CURSOR_WRITER_REQUIRED"] },
  { table: "JobInstance", name: "campaign_fair_job_guard_v1_trg", fn: "campaign_fair_job_guard_v1", timing: /BEFORE/, events: ["INSERT", "UPDATE"], columns: [], markers: ["onlinod.campaign_fair_pages_version", "CAMPAIGN_FAIR_EXECUTOR_REQUIRED", "CAMPAIGN_FAIR_PROTOCOL_DOWNGRADE"] },
  { table: "AnalyticsIngestBatch", name: "campaign_fair_ingest_guard_v1_trg", fn: "campaign_fair_ingest_guard_v1", timing: /BEFORE/, events: ["INSERT", "UPDATE"], columns: [], markers: ["onlinod.campaign_fair_pages_version", "CAMPAIGN_FAIR_INGEST_REQUIRED"] },
  { table: "CreatorCampaignCollectionState", name: "campaign_fair_schedule_guard_v1_trg", fn: "campaign_fair_schedule_guard_v1", timing: /BEFORE/, events: ["INSERT", "UPDATE OF"], columns: ["campaignFrontierPlanRunId", "campaignFrontierNextDueAt", "campaignFrontierNextEligibleAt", "campaignFrontierScheduleVersion"], markers: ["onlinod.campaign_fair_pages_version", "campaignFrontierScheduleVersion", "campaignFrontierNextEligibleAt"] },
];
async function verify(db) {
  const rows = await db.$queryRawUnsafe(`SELECT t.tgname AS name,c.relname AS "table",t.tgenabled AS enabled,
    p.proname AS fn,pg_get_functiondef(p.oid) AS body,pg_get_triggerdef(t.oid) AS definition,
    ARRAY(SELECT a.attname FROM unnest(t.tgattr::smallint[]) n
      JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=n ORDER BY a.attname) AS columns
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
    JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname=current_schema() AND t.tgname=ANY($1::text[])`, SPECS.map(s => s.name));
  for (const spec of SPECS) {
    const row = rows.find(r => r.name === spec.name);
    if (!row || row.table !== spec.table || row.fn !== spec.fn || !["O", "A"].includes(row.enabled)
      || !spec.timing.test(row.definition) || !row.definition.includes("FOR EACH ROW")
      || !spec.events.every(event => row.definition.includes(event))
      || JSON.stringify([...row.columns].sort()) !== JSON.stringify([...spec.columns].sort())
      || !spec.markers.every(marker => row.body.includes(marker))) throw new Error("CAMPAIGN_FAIR_FENCE_INVALID:" + spec.table);
  }
  return { ready: true, fences: SPECS.length };
}
module.exports = { verify, SPECS };
if (require.main === module) {
  const db = require("../../src/prisma");
  verify(db).then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  }).finally(() => db.$disconnect());
}
