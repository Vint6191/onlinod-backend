"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCustomMediaProvenance, classifyProgrammaticCustomMediaProvenance } = require("./custom-media-provenance-authority-service");

function proofFixture({ mismatch = false } = {}) {
  const submission = {
    id: "submission-proof", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    ofMediaIds: [], telegramMessageIds: ["701"], telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678",
  };
  const proof = {
    id: "write-proof", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND",
    idempotencyKey: "custom-relay:submission-proof:0", status: "COMPLETED",
    payload: {
      submissionId: "submission-proof", expectedIndex: 0, telegramSourceAccountId: "tg-1",
      telegramSourceUserId: "987654321012345678", telegramMessageId: mismatch ? "999" : "701",
    },
    result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "990701" },
  };
  const db = {
    creatorMediaAsset: { findMany: async () => [] },
    customContentSubmission: {
      findMany: async ({ where }) => {
        if (where?.ofMediaIds?.hasSome) return [];
        if (where?.id?.in?.includes("submission-proof")) return [submission];
        return [];
      },
    },
    automationDelivery: {
      findMany: async ({ where }) => {
        const wants = new Set((where?.OR || []).map((item) => String(item?.result?.equals || "")));
        return wants.has("990701") ? [proof] : [];
      },
    },
  };
  return { db, submission, proof };
}

test("validated COMPLETED relay proof is immediate CUSTOM truth before product projections exist", async () => {
  const { db } = proofFixture();
  const resolved = await resolveCustomMediaProvenance({ agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["990701"], db });
  assert.equal(resolved.customIds.has("990701"), true);
  assert.deepEqual([...resolved.evidenceByMedia.get("990701")], ["CONFIRMED_RELAY_PROOF"]);
  assert.equal([...resolved.referencesByMedia.get("990701").values()][0].submissionId, "submission-proof");

  const classified = await classifyProgrammaticCustomMediaProvenance({ agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["990701"], db });
  assert.equal(classified.allow, false);
  assert.equal(classified.code, "CUSTOM_MEDIA_PROGRAMMATIC_FORBIDDEN");
  assert.deepEqual(classified.customMediaIds, ["990701"]);
});

test("mismatched provider result is not accepted as CUSTOM proof", async () => {
  const { db } = proofFixture({ mismatch: true });
  const resolved = await resolveCustomMediaProvenance({ agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["990701"], db });
  assert.equal(resolved.customIds.has("990701"), false);
  const classified = await classifyProgrammaticCustomMediaProvenance({ agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["990701"], db });
  assert.deepEqual(classified, { ok: true, matched: false, allow: true, code: null, customMediaIds: [] });
});

test("derived submission/asset sources remain compatible while proof authority is centralized", async () => {
  const db = {
    creatorMediaAsset: { findMany: async () => [{ mediaId: "9001", customOrderId: "o1", customSubmissionId: "s1" }] },
    customContentSubmission: { findMany: async () => [{ id: "s2", customOrderId: "o2", ofMediaIds: ["9002"] }] },
  };
  const resolved = await resolveCustomMediaProvenance({ agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["9001", "9002", "general"], db });
  assert.deepEqual(["9001", "9002", "general"].filter((id) => resolved.customIds.has(id)), ["9001", "9002"]);
});
