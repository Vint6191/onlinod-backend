"use strict";
async function verify(db) {
  const rows = await db.$queryRawUnsafe(`SELECT t.tgenabled AS enabled,t.tgtype AS type,p.proname AS fn
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('"CreatorCampaignCollectionState"') AND t.tgname='campaign_membership_proof_guard_v1'`);
  if (rows.length !== 1 || !["O", "A"].includes(rows[0].enabled) || Number(rows[0].type) !== 23
      || rows[0].fn !== "onlinod_campaign_membership_proof_guard_v1") throw new Error("CAMPAIGN_MEMBERSHIP_PROOF_FENCE_INVALID");
  return { ready: true, version: 1 };
}
module.exports = { verify };
if (require.main === module) {
  const db = require("../../src/prisma");
  verify(db).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
}
