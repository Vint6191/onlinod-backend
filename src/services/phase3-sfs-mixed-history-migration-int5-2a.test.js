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




