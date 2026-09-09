"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { convergeHistoricalCustomExternalProofs, repairCurrentCustomExternalProjectionDebt } = require("./custom-external-proof-convergence-service");

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
  const pumpStart = scheduler.indexOf("async function runPhase2MaintenancePump");
  const recurringStart = scheduler.indexOf("async function runRecurringSweepInternal", pumpStart);
  const pump = scheduler.slice(pumpStart, recurringStart > pumpStart ? recurringStart : undefined);
  assert.match(pump, /runCustomExternalProofConvergenceSweep\(\{ now, db \}\)/);
  const laneStart = scheduler.indexOf("async function runCustomExternalProofConvergenceSweep");
  const laneEnd = scheduler.indexOf("async function runTelegramInboundProjectionSweep", laneStart);
  const lane = scheduler.slice(laneStart, laneEnd > laneStart ? laneEnd : undefined);
  assert.match(lane, /oneTime:\s*true/);
  const service = fs.readFileSync(path.join(__dirname, "custom-external-proof-convergence-service.js"), "utf8");
  assert.doesNotMatch(service, /CreatorAccount[\s\S]*deletedAt IS NULL/);
  assert.doesNotMatch(service, /allowedCreatorScope|member|deviceId|runtimeClaim/);
});


test("current external debt repairs one exact relay proof and clears only that debt locator", async () => {
  const { db, submission, proof } = dbFixture();
  const debts = [{ id: "pod_external_relay-terminal", agencyId: submission.agencyId, accountId: "tg-1", creatorId: submission.creatorId, debtClass: "CUSTOM_EXTERNAL_PROJECTION_DEBT", objectType: "AutomationDelivery", objectId: proof.id, customOrderId: submission.customOrderId, customSubmissionId: submission.id, reason: "CUSTOM_RELAY_SEND" }];
  db.providerOperationalDebt = {
    findMany: async ({ where }) => where.debtClass === "CUSTOM_EXTERNAL_PROJECTION_DEBT" ? debts.map((row) => ({ ...row })) : [],
    deleteMany: async ({ where }) => { const before = debts.length; for (let i = debts.length - 1; i >= 0; i -= 1) if (debts[i].id === where.id) debts.splice(i, 1); return { count: before - debts.length }; },
  };
  db.automationDelivery.findUnique = async ({ where }) => where.id === proof.id ? proof : null;
  db.customOrder = { findFirst: async () => null };
  const result = await repairCurrentCustomExternalProjectionDebt({ db, limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.selected, 1);
  assert.equal(result.repaired, 1);
  assert.equal(result.cleared, 1);
  assert.deepEqual(submission.ofMediaIds, ["990701"]);
  assert.equal(debts.length, 0);
});

test("external current-work cutover keeps history one-time and creates DB-side debt for new completed writes", () => {
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  assert.match(scheduler, /CUSTOM_EXTERNAL_CURRENT_DEBT_LANE_KEY/);
  assert.match(scheduler, /repairCurrentCustomExternalProjectionDebt/);
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260909211500_phase2_current_work_coordination", "migration.sql"), "utf8");
  assert.match(migration, /AutomationDelivery_custom_external_projection_debt/);
  assert.match(migration, /CUSTOM_EXTERNAL_PROJECTION_DEBT/);
  assert.match(migration, /CUSTOM_RELAY_SEND/);
  assert.match(migration, /CUSTOM_MANUAL_SEND/);
});
