"use strict";

const { CampaignTraversalError } = require("./campaign-traversal-errors");
const VERSION = 1;
const CAPABILITY = "campaignSourceValidationV1";
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function continuation(value) {
  for (let depth = 0; depth < 10000 && value?.driverPhase === "execute"; depth++) value = value.jobContinuation;
  return value?.driverPhase === "complete" ? object(value.result) : value ?? null;
}
function current(value) { return object(value).sourceValidationVersion === VERSION; }
function jobCurrent(job) {
  const cursor = continuation(job?.continuation);
  return current(job?.params) && (cursor === null || current(cursor));
}
function needsRotation(job) {
  if (job?.jobKey !== "fetch_campaigns" || !job.params?.collectionGeneration || jobCurrent(job)) return false;
  // A previous owner may already have read a response even if its first page
  // was never acknowledged. Never stamp the new validator onto that run.
  return job.status === "CLAIMED" || job.startedAt != null || job.continuation != null
    || job.result?.scanRunId === job.params.collectionGeneration;
}
function claimParams(value) {
  const params = { ...object(value), sourceValidationVersion: VERSION };
  // Old discovery seals prove the older parser only. Reuse is safe only when
  // its durable source-validation marker was copied into this server command.
  if (params.campaignDirectoryReuseSourceValidationVersion !== VERSION) {
    for (const key of Object.keys(params)) if (key.startsWith("campaignDirectoryReuse")) delete params[key];
  }
  return params;
}
function repairParams(job, now) {
  const control = require("./analytics-collector-control-service");
  const previous = object(job.params), params = claimParams(previous);
  for (const key of Object.keys(params)) if (key.startsWith("campaignDirectoryReuse")) delete params[key];
  for (const key of ["knownCampaignFanCounts", "knownClaimersByCampaign", "knownClaimerFrontierHashes", "maxClaimerPages"]) delete params[key];
  const command = control.buildCollectionCommand({ collectorType: control.COLLECTOR_TYPES.CAMPAIGNS,
    collectionMode: previous.collectionMode === "catchup" ? "catchup" : "full",
    reason: previous.collectionReason || previous.reason || "CAMPAIGN_SOURCE_VALIDATION_REPAIR", now });
  return control.stampCollectionAuthorityParams({ ...params, ...command,
    sourceValidationVersion: VERSION, campaignFairPagesVersion: 1,
    campaignSourceRepairFromRunId: previous.collectionGeneration || null,
  }, now, previous.collectionAuthorityRequestedAt || previous.collectionRequestedAt);
}
function assertCurrent(job, payload) {
  if (!jobCurrent(job) || !current(payload)) throw new CampaignTraversalError("CAMPAIGN_SOURCE_VALIDATION_REQUIRED");
}

module.exports = { VERSION, CAPABILITY, continuation, current, jobCurrent, needsRotation, claimParams, repairParams, assertCurrent };
