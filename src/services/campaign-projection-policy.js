"use strict";

const { runRootCommit } = require("./db-commit-kernel");
const WRITER = "campaign_projection_v2";

// Hold a shared policy lock for the entire root commit. A policy transition
// waits for existing commits; subsequent commits use the new DB-owned policy.
async function enterCampaignProjection(tx) {
  const [policy] = await tx.$queryRawUnsafe('SELECT "generation","valueFreshnessMs" FROM "CampaignProjectionPolicy" WHERE "id"=\'active\' FOR SHARE');
  if (!policy) throw new Error("CAMPAIGN_PROJECTION_POLICY_MISSING");
  await tx.$queryRawUnsafe("SELECT set_config('onlinod.campaign_projection_writer',$1,true),set_config('onlinod.campaign_projection_generation',$2,true)",WRITER,String(policy.generation));
  await tx.$queryRawUnsafe("SELECT set_config('onlinod.campaign_value_refresh_version','1',true)");
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
    // The class counter is telemetry, not a scheduling priority. A zero-count
    // new/repaired class gets one early turn, then joins the sequence frontier.
    // Read only this generation's fixed five-class catalog; lock its selected
    // row, never a singleton shared with other maintenance generations.
    const [row]=await tx.$queryRawUnsafe(`WITH next AS MATERIALIZED (
      SELECT "generation","laneName" FROM "MaintenanceAdmissionClassState"
      WHERE "generation"='campaign_projection_execution_v2' ORDER BY "admissionSequence","ordinal"
      LIMIT 1 FOR UPDATE SKIP LOCKED
    ), frontier AS MATERIALIZED (
      SELECT COALESCE(MAX("admissionSequence"),0) AS sequence
      FROM "MaintenanceAdmissionClassState" WHERE "generation"='campaign_projection_execution_v2'
    ) UPDATE "MaintenanceAdmissionClassState" s SET "turnCount"=s."turnCount"+1,
      "admissionSequence"=GREATEST(s."admissionSequence",f.sequence)+1,"lastAdmittedAt"=clock_timestamp()
      FROM next n CROSS JOIN frontier f
      WHERE s."generation"=n."generation" AND s."laneName"=n."laneName" RETURNING s."laneName"`);
    return row?.laneName||null;
  },{profile:"JOB_CHUNK"});
}

module.exports={WRITER,enterCampaignProjection,changeCampaignProjectionPolicy,admitProjectionWorkClass};
