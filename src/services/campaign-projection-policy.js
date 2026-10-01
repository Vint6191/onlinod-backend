"use strict";

const { runRootCommit } = require("./db-commit-kernel");
const WRITER = "campaign_projection_v2";

// Hold a shared policy lock for the entire root commit. A policy transition
// waits for existing commits; subsequent commits use the new DB-owned policy.
async function enterCampaignProjection(tx) {
  const [policy] = await tx.$queryRawUnsafe('SELECT "generation","valueFreshnessMs" FROM "CampaignProjectionPolicy" WHERE "id"=\'active\' FOR SHARE');
  if (!policy) throw new Error("CAMPAIGN_PROJECTION_POLICY_MISSING");
  await tx.$queryRawUnsafe("SELECT set_config('onlinod.campaign_projection_writer',$1,true),set_config('onlinod.campaign_projection_generation',$2,true)",WRITER,String(policy.generation));
  return policy;
}

async function changeCampaignProjectionPolicy({db,expectedGeneration,valueFreshnessMs}) {
  if (!Number.isSafeInteger(expectedGeneration) || !Number.isSafeInteger(valueFreshnessMs) || valueFreshnessMs<60000 || valueFreshnessMs>2147483647) throw new Error("CAMPAIGN_PROJECTION_POLICY_INVALID");
  return runRootCommit(db,async({tx}) => {
    const [row] = await tx.$queryRawUnsafe('SELECT "onlinod_campaign_projection_policy_v2"($1::integer,$2::integer) AS generation',expectedGeneration,valueFreshnessMs);
    return row;
  },{profile:"JOB_CHUNK"});
}

async function admitProjectionWorkClass(db) {
  return runRootCommit(db,async({tx})=>{
    const [row]=await tx.$queryRawUnsafe(`WITH next AS MATERIALIZED (
      SELECT "generation","laneName" FROM "MaintenanceAdmissionClassState"
      WHERE "generation"='campaign_projection_execution_v2' ORDER BY "turnCount","ordinal"
      LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE "MaintenanceAdmissionClassState" s SET "turnCount"=s."turnCount"+1,"lastAdmittedAt"=clock_timestamp()
      FROM next n WHERE s."generation"=n."generation" AND s."laneName"=n."laneName" RETURNING s."laneName"`);
    return row?.laneName||null;
  },{profile:"JOB_CHUNK"});
}

module.exports={WRITER,enterCampaignProjection,changeCampaignProjectionPolicy,admitProjectionWorkClass};
