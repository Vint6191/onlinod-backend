"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../..");
const migration = fs.readFileSync(path.join(root, "prisma/migrations/20261009000000_current_baseline/migration.sql"), "utf8");
const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
const submissions = fs.readFileSync(path.join(__dirname, "custom-content-submissions-service.js"), "utf8");
const route = fs.readFileSync(path.join(root, "src/routes/custom-orders.js"), "utf8");

function slice(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}





test("A43 historical standalone source enumeration is per-agency, bounded, resumable, and activation waits for convergence", () => {
  assert.match(scheduler, /PHASE2_COVERAGE_SEED_GENERATION/);
  const manifest = fs.readFileSync(path.join(root, "src/services/phase2-coverage-manifest.js"), "utf8");
  assert.match(manifest, /phase2_coverage_manifest_actual53_v1/);
  assert.match(manifest, /CUSTOM_SOURCE_PIPELINE/);
  assert.match(scheduler, /PHASE2_COVERAGE_FAMILY\.CUSTOM_SOURCE_PIPELINE/);
  const enumeration = slice(scheduler, "async function runCustomSourcePipelineCoverageEnumerationUnit", "async function runTeamActivityCoverageEnumerationUnit");
  assert.match(enumeration, /agencyId:\s*String\(item\.agencyId\)/);
  assert.match(enumeration, /pipelineDisposition:\s*\{ in: \["ACTIVE", "SALVAGE"\] \}/);
  assert.match(enumeration, /orderBy:\s*\{ id: "asc" \}, take:\s*100/);
  assert.match(enumeration, /progressCursor:\s*\{ lastSubmissionId: nextCursor \}/);
  assert.match(enumeration, /hasOutstandingDomainWork\(\{[\s\S]*CUSTOM_SOURCE_PIPELINE/);
  assert.match(enumeration, /projectedThrough:\s*"domain_work_converged"/);
});

test("A43 Desktop-facing source execution is exact DomainWork claim + heartbeat + report settlement, not a second server provider executor", () => {
  const claim = slice(submissions, "async function claimCustomContentSubmissionUploadWork(", "async function heartbeatCustomContentSubmissionSourceWork");
  assert.match(claim, /claimDomainWorkBatch\(\{/);
  assert.match(claim, /workClass:\s*PHASE2_WORK_CLASS\.CUSTOM_SOURCE_PIPELINE/);
  assert.match(claim, /objectType:\s*"CustomContentSubmission"/);
  assert.match(claim, /exactSourcePipelineWork\(\{/);
  assert.match(claim, /authority:\s*"CUSTOM_SOURCE_PIPELINE_DOMAIN_WORK_V1"/);
  const exact = slice(submissions, "async function exactSourcePipelineWork", "async function claimCustomContentSubmissionUploadWork(");
  assert.match(exact, /sourceWorkClaim:\s*serializeSourcePipelineDomainClaim\(item, ownerToken\)/);
  assert.match(exact, /settleClaimedSourcePipelineFailure\(\{/);
  assert.doesNotMatch(exact, /reportSubmissionExecutionAttempt\(\{ db, agencyId, submissionId, success: false/,
    "claimed source diagnostics must not write submission retry metadata outside fenced settlement");
  const failureSettlement = slice(submissions, "async function settleClaimedSourcePipelineFailure", "async function exactSourcePipelineWork");
  assert.match(failureSettlement, /withSubmissionPipelineLock/);
  assert.match(failureSettlement, /lockDomainWorkClaimForCommit/);
  assert.match(failureSettlement, /guarded\.newerRevision/);
  assert.match(failureSettlement, /reportSubmissionExecutionAttempt/);
  assert.match(failureSettlement, /failDomainWorkClaim/);
  assert.doesNotMatch(claim, /sendMessage|uploadMedia|session\.fetch|OnlyFans/i,
    "backend source-work claim must not become a second external provider executor");

  const heartbeat = slice(submissions, "async function heartbeatCustomContentSubmissionSourceWork", "async function reportCustomContentSubmissionExecutionAttempt");
  assert.match(heartbeat, /assertSourcePipelineDomainClaim/);
  assert.match(heartbeat, /heartbeatDomainWorkClaim/);
  const report = slice(submissions, "async function reportCustomContentSubmissionExecutionAttempt", "async function assertCustomSubmissionTelegramSourceAccess");
  assert.match(report, /CUSTOM_SUBMISSION_SOURCE_WORK_CLAIM_REQUIRED/);
  assert.match(report, /withSubmissionPipelineLock/);
  assert.match(report, /lockDomainWorkClaimForCommit/);
  assert.match(report, /reportSubmissionExecutionAttempt\(\{[\s\S]*db:\s*lockedClient/);
  assert.match(report, /ackDomainWorkClaim/);
  assert.match(report, /failDomainWorkClaim/);
  assert.match(report, /settlement\?\.lost/);

  const reserve = slice(submissions, "async function reserveCustomContentSubmissionRelayWrite", "async function closeCustomContentSubmissionRelayWriteUnresolved");
  assert.match(reserve, /CUSTOM_SUBMISSION_SOURCE_WORK_CLAIM_REQUIRED/);
  assert.match(reserve, /withSubmissionSourceLock/);
  assert.match(reserve, /lockDomainWorkClaimForCommit/);
  assert.match(reserve, /heartbeatDomainWorkClaim/);
  assert.match(reserve, /CUSTOM_SUBMISSION_SOURCE_WORK_CLAIM_STALE/);

  assert.match(route, /submissions\/:submissionId\/source-work\/heartbeat/);
  assert.match(route, /sourceWorkClaim:\s*req\.body\?\.sourceWorkClaim/);
  const relayRoute = slice(route, 'router.post("/submissions/:submissionId/relay-write/reserve"', 'router.post("/submissions/:submissionId/relay-write/close-unresolved"');
  assert.match(relayRoute, /sourceWorkClaim:\s*req\.body\?\.sourceWorkClaim/);
});


