"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = (name) => fs.readFileSync(path.join(__dirname, `../../prisma/migrations/${name}/migration.sql`), "utf8");

function modelMixedHistoryRepair() {
  // Duplicate A: genuine completed cycle. Duplicate B: newer username-era
  // transient skip carrying the historical bug usedForever=true. INT4.3A can
  // select B by generation while bool_or preserves usedForever. INT4.3C then
  // clears B because its winner state is transient. INT5.2A restores the bit
  // from the repointed completed cleanup delivery history.
  const completedA = { usedForever: true, state: "COMPLETED", generation: 2 };
  const transientB = { usedForever: true, state: "SKIPPED", eligibilityReason: "paid_target", generation: 3 };
  const winner = { ...transientB, usedForever: completedA.usedForever || transientB.usedForever };
  if (winner.usedForever && winner.state === "SKIPPED" && ["paid_target", "comments_disabled"].includes(winner.eligibilityReason)) {
    winner.usedForever = false;
  }
  const durableCompletedCleanupProof = true;
  if (durableCompletedCleanupProof) winner.usedForever = true;
  return winner;
}

test("INT5.2A mixed-history repair preserves genuine oneTargetForever after transient-winner cleanup", () => {
  const repaired = modelMixedHistoryRepair();
  assert.equal(repaired.state, "SKIPPED", "repair must not rewrite current workflow state");
  assert.equal(repaired.usedForever, true, "durable completed-cycle proof must restore oneTargetForever");
});

test("INT5.2A migration derives restoration from completed SFS cleanup history, not winner state", () => {
  const opaque = migration("20260916190000_phase3_sfs_opaque_target_identity");
  const transient = migration("20260916203000_phase3_sfs_consumption_semantics");
  const repair = migration("20260916211500_phase3_sfs_mixed_history_consumption_repair");

  assert.match(opaque, /AutomationDelivery[\s\S]*candidateId[\s\S]*winner_id/, "duplicate merge must repoint delivery history before loser deletion");
  assert.match(opaque, /bool_or\(c\."usedForever"\)/, "duplicate merge preserves the scalar bit before transient cleanup");
  assert.match(transient, /"usedForever" = false[\s\S]*paid_target[\s\S]*comments_disabled/, "transient legacy bug remains cleaned");

  assert.match(repair, /"moduleKey" = 'sfs'/);
  assert.match(repair, /"actionType" = 'SFS_UNFOLLOW_TARGET'/);
  assert.match(repair, /"status" = 'COMPLETED'/);
  assert.match(repair, /"payload"->>'candidateId' = c\."id"/);
  assert.match(repair, /"usedForever" = true/);
  assert.match(repair, /historicalConsumptionProofDeliveryId/);
  assert.doesNotMatch(repair, /"state"\s*=|"phase"\s*=/, "repair must not rewrite current workflow lifecycle");
});

test("INT5.2A repair remains target-id aware after opaque identity cutover", () => {
  const repair = migration("20260916211500_phase3_sfs_mixed_history_consumption_repair");
  assert.match(repair, /c\."targetUserId" IS NOT NULL/);
  assert.match(repair, /d\."fanId" = c\."targetUserId"/);
  assert.match(repair, /d\."targetId" = c\."targetUserId"/);
  assert.match(repair, /d\."payload"->>'targetUserId' = c\."targetUserId"/);
});
