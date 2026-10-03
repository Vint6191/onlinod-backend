"use strict";
const SPECS = [
  { table: "CreatorCampaign", name: "campaign_directory_facts_clock_v1_trg", fn: "campaign_directory_facts_clock_v1",
    timing: /AFTER/, events: ["INSERT", "DELETE", "UPDATE OF"],
    columns: ["creatorId", "externalCampaignId", "sourceScanRunId", "sourceScanStartedAt"],
    markers: ['"campaignDirectoryFactsRevision" + 1', 'IS NOT DISTINCT FROM'] },
  { table: "CreatorCampaignCollectionState", name: "campaign_directory_count_guard_v1_trg", fn: "campaign_directory_count_guard_v1",
    timing: /BEFORE/, events: ["INSERT", "UPDATE OF"],
    columns: ["campaignDirectoryGeneration", "campaignDirectoryRequestedAt", "campaignDirectoryRevision", "campaignDirectoryCampaignCount", "campaignDirectoryCountRevision"],
    markers: ["onlinod.campaign_directory_count_version", 'NEW."campaignDirectoryCountRevision" := NULL'] },
  { table: "JobInstance", name: "campaign_bounded_claim_guard_v1_trg", fn: "campaign_bounded_claim_guard_v1",
    timing: /BEFORE/, events: ["INSERT", "UPDATE OF"],
    columns: ["status", "leaseRevision", "claimedByDeviceId", "params", "continuation"],
    markers: ["onlinod.campaign_bounded_traversal_version", "CAMPAIGN_BOUNDED_TRAVERSAL_CLAIM_REQUIRED", 'OLD."continuation" IS DISTINCT FROM NEW."continuation"'] },
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
      || !spec.markers.every(marker => row.body.includes(marker))) throw new Error("CAMPAIGN_BOUNDED_FENCE_INVALID:" + spec.table);
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
