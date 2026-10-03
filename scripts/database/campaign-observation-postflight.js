"use strict";

const SPECS = Object.freeze([
  { table: "CreatorCampaign", fn: "campaign_frontier_observation_guard_v1", column: "claimersObservationVersion",
    columns: ["claimersVerifiedAt", "claimerVerifiedRevision", "claimersLastVerifiedRunId", "claimersObservationVersion"] },
  { table: "CreatorCampaignCollectionState", fn: "campaign_plan_observation_guard_v1", column: "campaignFrontierObservationVersion",
    columns: ["campaignFrontierPlanRunId", "campaignFrontierFreshnessStatus", "campaignFrontierNextDueAt", "campaignFrontierCompletedCount", "campaignFrontierDeferredCount", "campaignFrontierObservationVersion"] },
]);
async function verify(db) {
  const rows = await db.$queryRawUnsafe(`SELECT t.tgname AS name,c.relname AS "table",t.tgenabled AS enabled,
    p.proname AS fn,pg_get_functiondef(p.oid) AS body,pg_get_triggerdef(t.oid) AS definition,
    ARRAY(SELECT a.attname FROM unnest(t.tgattr::smallint[]) n
      JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=n ORDER BY a.attname) AS columns
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
    JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname=current_schema() AND t.tgname=ANY($1::text[])`, SPECS.map(s => s.fn + "_trg"));
  for (const spec of SPECS) {
    const row = rows.find(r => r.name === spec.fn + "_trg");
    if (!row || row.table !== spec.table || row.fn !== spec.fn || !["O", "A"].includes(row.enabled)
      || !/BEFORE INSERT OR UPDATE OF/.test(row.definition) || !/FOR EACH ROW/.test(row.definition)
      || JSON.stringify([...row.columns].sort()) !== JSON.stringify([...spec.columns].sort())
      || !row.body.includes("onlinod.campaign_observation_version") || !row.body.includes("IS DISTINCT FROM '1'")
      || !row.body.includes(`NEW."${spec.column}" := 0`)) {
      throw new Error("CAMPAIGN_OBSERVATION_FENCE_INVALID:" + spec.table);
    }
  }
  return { ready: true, observationVersion: 1, fences: SPECS.length };
}
module.exports = { verify, SPECS };
if (require.main === module) {
  const db = require("../../src/prisma");
  verify(db).then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  }).finally(() => db.$disconnect());
}
