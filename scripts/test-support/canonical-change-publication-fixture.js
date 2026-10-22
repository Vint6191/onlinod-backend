"use strict";
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const { currentCommitContext } = require("../../src/services/db-commit-kernel");

// Projection unit fixtures model only the canonical tables under test. Keep
// the independent reverse-delivery boundary explicit; its real SQL persistence
// is exercised by campaign-fan-pipeline-sql-proof and entity-change SQL proofs.
function installCanonicalChangePublicationFixture() {
  const service = require("../../src/services/campaign-fan-change-publication");
  const calls = [];
  for (const [method, key, max] of [
    ["publishCanonicalFanChanges", "fanIds", 500],
    ["publishCanonicalCampaignChanges", "campaignIds", 50],
  ]) {
    mock.method(service, method, async input => {
      assert.equal(currentCommitContext()?.tx, input.db, "canonical changes belong to the committing transaction");
      assert.equal(typeof input.agencyId, "string");
      assert.equal(typeof input.creatorId, "string");
      assert.ok(input.agencyId && input.creatorId);
      const ids = input[key] || input.externalCampaignIds || [];
      assert.ok(Array.isArray(ids) && ids.length <= max, "publication uses a bounded canonical scope");
      assert.ok(ids.every(id => typeof id === "string" && id.length));
      calls.push({ method, agencyId: input.agencyId, creatorId: input.creatorId, ids: [...ids] });
      return { staged: true, count: ids.length };
    });
  }
  return calls;
}
module.exports = { installCanonicalChangePublicationFixture };
