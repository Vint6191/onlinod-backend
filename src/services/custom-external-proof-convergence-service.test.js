"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { convergeHistoricalCustomExternalProofs } = require("./custom-external-proof-convergence-service");

function dbFixture() {
  const submission = {
    id: "terminal-sub", agencyId: "agency-deleted", creatorId: "creator-deleted", customOrderId: "order-terminal",
    pipelineDisposition: "ABANDONED", reviewStatus: "WAITING_REVIEW",
    telegramMessageIds: [701], ofMediaIds: [], telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678",
    updatedAt: new Date("2026-09-07T10:00:00.000Z"),
    vaultSettlementFolderId: "old-folder", vaultSettlementProfileRevision: 1, vaultSettlementMediaFingerprint: "old", vaultSettlementConfirmedAt: new Date(), vaultSettlementConfirmedByDeviceId: "old-device",
  };
  const proof = {
    id: "relay-terminal", agencyId: submission.agencyId, creatorId: submission.creatorId,
    actionType: "CUSTOM_RELAY_SEND", status: "COMPLETED", idempotencyKey: "custom-relay:terminal-sub:0",
    payload: { submissionId: "terminal-sub", expectedIndex: 0, telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageId: "701" },
    result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "990701" },
  };
  const db = {
    $transaction: async (work) => work(db),
    customContentSubmission: {
      findMany: async ({ cursor } = {}) => cursor ? [] : [submission],
      findFirst: async ({ where }) => where.id === submission.id && where.agencyId === submission.agencyId ? submission : null,
      updateMany: async ({ where, data }) => {
        if (where.id !== submission.id || where.agencyId !== submission.agencyId) return { count: 0 };
        if (where.updatedAt && new Date(where.updatedAt).getTime() !== new Date(submission.updatedAt).getTime()) return { count: 0 };
        Object.assign(submission, data, { updatedAt: new Date(new Date(submission.updatedAt).getTime() + 1) });
        return { count: 1 };
      },
    },
    automationDelivery: {
      findFirst: async ({ where }) => {
        if (where.idempotencyKey === proof.idempotencyKey && where.status === "COMPLETED") return proof;
        return null;
      },
    },
  };
  return { db, submission, proof };
}

test("historical projector converges a retired/terminal submission without creator runtime or work resurrection", async () => {
  const { db, submission } = dbFixture();
  const result = await convergeHistoricalCustomExternalProofs({ db, limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.repaired, 1);
  assert.equal(result.projectedMedia, 1);
  assert.deepEqual(submission.ofMediaIds, ["990701"]);
  assert.equal(submission.pipelineDisposition, "ABANDONED", "historical fact convergence must not resurrect terminal work");
  assert.equal(submission.vaultSettlementConfirmedAt, null, "media-set repair invalidates stale settlement receipt without starting new work");
});

test("scheduler owns historical proof convergence independently of Desktop polling", () => {
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  assert.match(scheduler, /async function runCustomExternalProofConvergenceSweep/);
  assert.match(scheduler, /convergeHistoricalCustomExternalProofs/);
  assert.match(scheduler, /projectionTick[\s\S]*runCustomExternalProofConvergenceSweep/);
  const service = fs.readFileSync(path.join(__dirname, "custom-external-proof-convergence-service.js"), "utf8");
  assert.doesNotMatch(service, /CreatorAccount[\s\S]*deletedAt IS NULL/);
  assert.doesNotMatch(service, /allowedCreatorScope|member|deviceId|runtimeClaim/);
});
