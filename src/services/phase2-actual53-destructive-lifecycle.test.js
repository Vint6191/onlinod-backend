"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const destructive = fs.readFileSync(path.join(__dirname, "phase2-destructive-delete-authority-service.js"), "utf8");
const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
const admin = fs.readFileSync(path.join(__dirname, "../routes/admin.js"), "utf8");

function slice(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end}`);
  return source.slice(from, to);
}

test("F55-07 Agency hard delete is a durable bounded DomainWork lifecycle, not one tenant-wide route transaction", () => {
  const route = slice(admin, 'router.delete("/agencies/:id"', '// POST /agencies/:id/restore');
  const hardStart = route.indexOf("if (hard) {");
  const softStart = route.indexOf("const deletedAt", hardStart);
  const hard = route.slice(hardStart, softStart);
  const customFence = hard.indexOf("assertAgencyCustomPipelineRetirable");
  const massFence = hard.indexOf("assertAgencyMassCampaignRetirable");
  const barrier = hard.indexOf("tx.agency.update");
  const publish = hard.indexOf("DESTRUCTIVE_AGENCY_CLEANUP");
  assert.ok(customFence >= 0 && massFence > customFence);
  assert.ok(barrier > massFence, "Agency DELETING barrier must follow external-effect guards");
  assert.ok(publish > barrier, "durable Agency cleanup must be published in the barrier transaction");
  assert.doesNotMatch(hard, /tx\.agency\.delete/);
  assert.doesNotMatch(hard, /purgeAgencyPhase2ProviderLedgersForHardDelete/);

  const worker = slice(
    destructive,
    "async function processAgencyHardDeleteWorkItem",
    "async function processCreatorHardDeleteWorkItem",
  );
  assert.match(worker, /ensureAgencyCreatorCleanupBatch/);
  assert.match(worker, /purgeAgencyNonFkTenantBatch/);
  assert.match(worker, /purgeAgencyDomainWorkBatch/);
  assert.match(worker, /purgeRootCascadeDescendantsBatch/);
  assert.match(worker, /rootCascadeRowsRemain/);
  assert.match(worker, /tx\.agency\.delete/);
  assert.match(worker, /purgeAgencyPhase2CurrentWorkRootsAfterCascade/);
});

test("F53-12 Creator hard delete worker is bounded, restartable, claim-fenced and zero-gated", () => {
  const worker = slice(
    destructive,
    "async function processCreatorHardDeleteWorkItem",
    "module.exports",
  );
  assert.match(worker, /CREATOR_DELETE_BATCH/);
  assert.match(worker, /Math\.min\(1000/);
  assert.match(worker, /assertCreatorCustomPipelineRetirable/);
  assert.match(worker, /assertCreatorMassCampaignRetirable/);
  assert.match(worker, /lockDomainWorkClaimForCommit\(\{\s*db:\s*tx,/);
  assert.doesNotMatch(worker, /lockDomainWorkClaimForCommit\(\{\s*tx,/);
  assert.match(worker, /purgeCreatorNonFkPhase2Batch/);
  assert.match(worker, /purgeCreatorCascadeChildrenBatch/);
  assert.match(worker, /phase2CreatorResidualRowsRemain/);
  assert.match(worker, /creatorCascadeRowsRemain/);
  assert.match(worker, /creatorAccount\.delete/);

  const finalDelete = worker.indexOf("creatorAccount.delete");
  assert.ok(worker.indexOf("phase2CreatorResidualRowsRemain") < finalDelete);
  assert.ok(worker.indexOf("creatorCascadeRowsRemain") < finalDelete);
});

test("F53-12 scheduler yields incomplete Creator cleanup instead of holding one all-history transaction", () => {
  const sweep = slice(
    scheduler,
    "async function runCreatorDestructiveCleanupSweep",
    "async function runTeamReadSummarySweep",
  );
  assert.match(sweep, /limit:\s*10/);
  assert.match(sweep, /batchSize:\s*250/);
  assert.match(sweep, /yieldDomainWorkClaim/);
  assert.match(sweep, /availableAt:\s*new Date\(now\.getTime\(\) \+ 250\)/);
  assert.doesNotMatch(sweep, /collectCreatorPhase2DestructiveScope/);
});
