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

test("F53-11 Agency hard delete removes proof roots before cascade and trigger-maintained current-work roots after cascade", () => {
  const prePurge = slice(
    destructive,
    "async function purgeAgencyPhase2ProviderLedgersForHardDelete",
    "async function purgeAgencyPhase2CurrentWorkRootsAfterCascade",
  );
  for (const delegate of [
    "teamSentMessageLedger",
    "teamPpvPurchaseLedger",
    "teamTipLedger",
    "teamPpvResolveJob",
    "providerOperationalDebt",
    "telegramDeliveryIntent",
    "telegramInboundEvent",
  ]) assert.match(prePurge, new RegExp(`"${delegate}"`));
  for (const delegate of ["phase2WorkFamilyState", "domainWorkReadyPartition", "domainWorkReadyAgency"]) {
    assert.doesNotMatch(prePurge, new RegExp(`"${delegate}"`));
  }

  const postPurge = slice(
    destructive,
    "async function purgeAgencyPhase2CurrentWorkRootsAfterCascade",
    "// Legacy bounded compatibility purge",
  );
  for (const delegate of ["phase2WorkFamilyState", "domainWorkReadyPartition", "domainWorkReadyAgency"]) {
    assert.match(postPurge, new RegExp(`"${delegate}"`));
  }

  const route = slice(admin, 'router.delete("/agencies/:id"', '// POST /agencies/:id/restore');
  const blockers = route.indexOf("assertAgencyMassCampaignRetirable");
  const preAt = route.indexOf("purgeAgencyPhase2ProviderLedgersForHardDelete");
  const deleteAt = route.indexOf("tx.agency.delete");
  const postAt = route.indexOf("purgeAgencyPhase2CurrentWorkRootsAfterCascade");
  assert.ok(blockers >= 0 && preAt > blockers && deleteAt > preAt && postAt > deleteAt);
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
