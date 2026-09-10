"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../..");
const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260910160000_phase2_custom_source_pipeline_domain_work/migration.sql"), "utf8");
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

test("A43 producer matrix publishes standalone source work and both sides of CustomOrder reassignment", () => {
  const trigger = slice(migration, 'CREATE OR REPLACE FUNCTION "phase2_submission_domain_work_trigger"', 'DROP TRIGGER IF EXISTS "CustomContentSubmission_phase2_domain_work"');
  assert.match(trigger, /'CUSTOM_SOURCE_PIPELINE','CustomContentSubmission',NEW\."id"/);
  assert.match(trigger, /IF NEW\."customOrderId" IS NOT NULL[\s\S]*'CUSTOM_COMMUNICATION','CustomOrder',NEW\."customOrderId"/);
  assert.match(trigger, /TG_OP='UPDATE'[\s\S]*OLD\."customOrderId" IS DISTINCT FROM NEW\."customOrderId"[\s\S]*'CUSTOM_COMMUNICATION','CustomOrder',OLD\."customOrderId"/);
  assert.match(trigger, /IF TG_OP='DELETE'[\s\S]*do not create fresh[\s\S]*CUSTOM_COMMUNICATION/);
  assert.doesNotMatch(trigger.match(/IF TG_OP='DELETE'[\s\S]*?RETURN OLD;/)?.[0] || "", /CUSTOM_SOURCE_PIPELINE/,
    "cascade cleanup must not create orphan source work after the source row is gone");
});

test("A43 creator/account/config dependencies fan out to standalone submissions with bounded keyset continuation", () => {
  assert.match(migration, /OLD\."customsVaultFolderId" IS DISTINCT FROM NEW\."customsVaultFolderId"/);
  assert.match(migration, /UPDATE OF "telegramContact","telegramUserId","telegramAccountId","customsVaultFolderId","status","deletedAt"/);
  const config = slice(migration, 'CREATE OR REPLACE FUNCTION "phase2_custom_pipeline_config_dependency_trigger"', 'DROP TRIGGER IF EXISTS "WorkspaceSetting_phase2_custom_pipeline_config"');
  assert.match(config, /'CUSTOM_PIPELINE_CONFIG'/);
  assert.match(config, /'DEPENDENCY_FANOUT','CustomPipelineConfig'/);
  assert.doesNotMatch(config, /UPDATE\s+"CustomContentSubmission"/i, "config TX must publish one fanout instead of mass-touching submissions");
  assert.match(migration, /UPDATE OF "key","value"/);

  const list = slice(scheduler, "async function listDependencyFanoutSubmissions", "async function processTeamMoneyEvidenceFanout");
  assert.match(list, /pipelineDisposition:\s*\{ in: \["ACTIVE", "SALVAGE"\] \}/);
  assert.match(list, /CreatorAccount[\s\S]*where\.creatorId/);
  assert.match(list, /AgencyTelegramMtprotoAccount[\s\S]*where\.telegramSourceAccountId/);
  assert.match(list, /CustomPipelineConfig/);
  assert.match(list, /orderBy:\s*\{ id: "asc" \}[\s\S]*take:\s*Math\.max\(1, Math\.min\(100/);

  const fanout = slice(scheduler, "async function maybeRunPhase2DependencyFanout", "async function reminderBlockedDependency");
  assert.match(fanout, /phase\s*=\s*"submissions"/);
  assert.match(fanout, /CUSTOM_SOURCE_PIPELINE/);
  assert.match(fanout, /progressCursor:\s*\{ phase: "submissions", lastId:/);
});

test("A43 historical standalone source enumeration is per-agency, bounded, resumable, and activation waits for convergence", () => {
  assert.match(scheduler, /phase2_coverage_seed_v2/);
  assert.match(scheduler, /PHASE2_COVERAGE_FAMILY\.CUSTOM_SOURCE_PIPELINE/);
  const enumeration = slice(scheduler, "async function runCustomSourcePipelineCoverageEnumerationUnit", "async function runTeamActivityCoverageEnumerationUnit");
  assert.match(enumeration, /agencyId:\s*String\(item\.agencyId\)/);
  assert.match(enumeration, /pipelineDisposition:\s*\{ in: \["ACTIVE", "SALVAGE"\] \}/);
  assert.match(enumeration, /orderBy:\s*\{ id: "asc" \}, take:\s*100/);
  assert.match(enumeration, /progressCursor:\s*\{ lastSubmissionId: nextCursor \}/);
  assert.match(enumeration, /state" <> 'DONE'[\s\S]*requestedRevision" > w\."completedRevision"/);
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

test("A43 migration uses bounded indexable source history and preserves new-agency coverage", () => {
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "CustomContentSubmission_source_history_keyset_idx"[\s\S]*"agencyId","pipelineDisposition","id"[\s\S]*WHERE "pipelineDisposition" IN \('ACTIVE','SALVAGE'\)/);
  assert.match(migration, /'CUSTOM_SOURCE_PIPELINE','phase2_custom_source_pipeline_coverage_v1',TRUE,'COMPLETE'/);
  const functions = (migration.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
  const terminators = (migration.match(/\$\$\s+LANGUAGE\s+plpgsql(?:\s+\w+)*\s*;/gi) || []).length;
  assert.equal(terminators, functions, "every PL/pgSQL function body must have exactly one terminator");
});
