"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FAILURE_CATEGORIES,
  classifyAutomationFailure,
  categoryAllowsBlindRetry,
} = require("./automation-failure-taxonomy");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { runDbTransaction } = require("./db-transaction-service");

test("Audit13 unknown failure is never a blind-safe retry", () => {
  const category = classifyAutomationFailure({ failureCode: "unknown", deliveryStatus: "RUNNING" });
  assert.equal(category, FAILURE_CATEGORIES.TERMINAL);
  assert.equal(categoryAllowsBlindRetry(category), false);
});

test("Audit13 lost COMMITTING write becomes outcome reconciliation", () => {
  for (const failureCode of ["lease_lost", "write_outcome_unknown", "send_reconcile_pending", "network_error", "timeout"]) {
    const category = classifyAutomationFailure({ failureCode, deliveryStatus: "COMMITTING" });
    assert.equal(category, FAILURE_CATEGORIES.OUTCOME_UNKNOWN_RECONCILE, failureCode);
    assert.equal(categoryAllowsBlindRetry(category), false, failureCode);
  }
});

test("Audit13 proven no-effect pre-wire failure may be retried", () => {
  const category = classifyAutomationFailure({ failureCode: "session_write_unavailable", deliveryStatus: "COMMITTING", provenNoEffect: true });
  assert.equal(category, FAILURE_CATEGORIES.SESSION_UNAVAILABLE);
  assert.equal(categoryAllowsBlindRetry(category), true);
});

test("Audit13 commit/control fence is transaction-scoped and agency-keyed", async () => {
  const calls = [];
  const tx = { async $queryRawUnsafe(sql, ...args) { calls.push({ sql, args }); return [{ ok: true }]; } };
  await lockAutomationWriteCommitFence({ db: tx, agencyId: "agency-1" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].args, ["onlinod:automation-write-commit:v1", "agency-1"]);
});

test("Audit13 nested lifecycle work reuses an existing transaction client", async () => {
  const tx = { marker: "tx" };
  const result = await runDbTransaction(tx, async (db) => db.marker);
  assert.equal(result, "tx");
});

test("Audit13 committed/reconciliation authority is immutable to pause/cancel/release while outcome settlement remains explicit", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const actionSource = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  const controlSource = fs.readFileSync(path.join(__dirname, "automation-control-service.js"), "utf8");
  assert.match(actionSource, /if \(\["COMMITTING", "RECONCILE_REQUIRED"\]\.includes\(delivery\.status\)\)[\s\S]{0,220}DELIVERY_COMMIT_IN_FLIGHT[\s\S]{0,220}cancellation/);
  assert.match(actionSource, /releaseClaimByAdmin[\s\S]{0,360}\["COMMITTING", "RECONCILE_REQUIRED"\]\.includes\(delivery\.status\)[\s\S]{0,220}DELIVERY_COMMIT_IN_FLIGHT/);
  assert.match(controlSource, /ACTIVE_DELIVERY_STATUSES = \["QUEUED", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"\]/);
  assert.doesNotMatch(controlSource, /ACTIVE_DELIVERY_STATUSES = \[[^\]]*(?:COMMITTING|RECONCILE_REQUIRED)/);
});

test("Audit13 reconciliation is claimable but never precommit-mutable", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /NORMAL_CLAIMABLE_STATUSES = \["QUEUED", "RETRY_SCHEDULED"\]/);
  assert.match(source, /CLAIMABLE_STATUSES = \[\.\.\.NORMAL_CLAIMABLE_STATUSES, "RECONCILE_REQUIRED"\]/);
  assert.match(source, /PRECOMMIT_EXECUTABLE_STATUSES = \[\.\.\.NORMAL_CLAIMABLE_STATUSES, "CLAIMED", "RUNNING"\]/);
  assert.doesNotMatch(source, /PRECOMMIT_EXECUTABLE_STATUSES = [^\n]*RECONCILE_REQUIRED/);
});

test("Audit13 retry and cancel commit candidate projection on the same transaction client", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /await updateModuleCandidateProgress\(latest, "QUEUED", null, tx\)/);
  assert.match(source, /await updateCandidateFromTerminal\(latest, "CANCELED", "canceled", tx\)/);
  assert.doesNotMatch(source, /\}\);\s*await updateModuleCandidateProgress\(updated, "QUEUED"\)/);
  assert.doesNotMatch(source, /\}\);\s*await updateCandidateFromTerminal\(updated, "CANCELED"/);
});

test("Audit13 COMMITTING settlement survives lease expiry while ordinary RUNNING remains expiry-fenced", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /const committedSettlement = allowCommittedSettlement && delivery\.status === "COMMITTING" && delivery\.writeCommitAt/);
  assert.match(source, /if \(!allowExpired && !terminal && !committedSettlement && \(!delivery\.claimUntil/);
  assert.match(source, /completeActionDelivery[\s\S]*allowCommittedSettlement: true/);
  assert.match(source, /failActionDelivery[\s\S]*allowCommittedSettlement: true/);
});

test("Audit13 pre-commit action lifecycle mutations re-lock execution access inside their commit transaction", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  assert.match(source, /renewActionLease[\s\S]*requireLease\(\{ \.\.\.input, db: tx, lockAccess: true \}\)/);
  assert.match(source, /startActionDelivery[\s\S]*requireLease\(\{ \.\.\.input, db: tx, lockAccess: true \}\)/);
  assert.match(source, /prepareWriteActionDelivery[\s\S]*requireLease\(\{ \.\.\.input, db: tx, lockAccess: true \}\)/);
  assert.match(source, /completeActionDelivery[\s\S]*lockDeliveryExecutionAccess\(\{ db: tx, delivery, userId: input\.userId \}\)/);
  assert.match(source, /failActionDelivery[\s\S]*lockDeliveryExecutionAccess\(\{ db: tx, delivery, userId: input\.userId \}\)/);
  assert.match(source, /releaseActionDelivery[\s\S]*lockDeliveryExecutionAccess\(\{ db: tx, delivery, userId: input\.userId \}\)/);
  assert.match(source, /applyBumpValidationTransition[\s\S]*executionAccess\?\.userId[\s\S]*lockDeliveryExecutionAccess/);
  assert.match(source, /applySfsValidationTransition[\s\S]*executionAccess\?\.userId[\s\S]*lockDeliveryExecutionAccess/);
});
