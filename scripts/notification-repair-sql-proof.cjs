"use strict";
// Run: node scripts/notification-repair-sql-proof.cjs /path/to/pglite-runtime
// Uses an isolated current-schema database, never the caller's DATABASE_URL.
const assert = require("node:assert/strict");
const { createAdminSqlRuntime } = require("./test-support/admin-sql-runtime.cjs");
const { runRootCommit } = require("../src/services/db-commit-kernel");
const writers = require("../src/services/database-write-contract-service");
const { ingestNotificationFacts } = require("../src/services/notification-facts-service");
const { notificationRepairParams } = require("../src/services/notification-repair-service");
const { notificationCommittedPageProof } = require("../src/services/notification-page-receipt-service");

async function main() {
  const fixture = await createAdminSqlRuntime({ runtimePath: process.argv[2] });
  try {
    const db = fixture.db;
    const { agency, creator } = await runRootCommit(db, async ({ tx }) => {
      await writers.assertTeamControlPlaneWriteAdmission(tx);
      const agency = await tx.agency.create({ data: { name: "Notification repair proof", status: "ACTIVE" } });
      const owner = await tx.user.create({ data: { email: "notification-proof@example.test", passwordHash: "fixture-no-login" } });
      await tx.agencyMember.create({ data: { agencyId: agency.id, userId: owner.id, role: "OWNER", roleKey: "owner" } });
      await writers.authorizeCreatorAccountWrite(tx);
      const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: "Synthetic creator", remoteId: "100001", status: "READY" } });
      return { agency, creator };
    });
    const scanRunId = "notification-repair-proof-old";
    const types = ["subscriptions", "purchases", "tips", "comments", "likes"];
    const job = await db.jobInstance.create({ data: {
      agencyId: agency.id, creatorId: creator.id, jobKey: "catchup_notifications_scan", scope: "CREATOR",
      params: { from: "2016-01-01T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", types,
        notificationMode: "full", collectionContractVersion: 1, collectionType: "NOTIFICATIONS", collectionMode: "full",
        collectionGeneration: scanRunId, collectionRequestedAt: "2026-10-13T23:00:00.000Z" },
    } });
    const events = Array.from({ length: 11 }, (_, i) => ({ eventType: "free_subscribed", notificationId: String(100000 + i),
      fanId: String(200000 + i), fanUsername: null, fanName: null, amountCents: 0, currency: "USD", occurredAt: "2026-10-12T23:03:14.000Z" }));
    const page = (run, type, rows) => ({ events: rows, notificationType: type, batchKey: `run:${run}:page:${type}:1`,
      finalizeCoverage: false, sourceTimezone: "UTC", scanRunId: run, collectorVersion: "notifications-history-v8-known-boundary",
      schemaVersion: 5, coverage: { [type]: { status: "partial" } } });
    const firstPage = page(scanRunId, "subscriptions", events);
    const original = await ingestNotificationFacts({ db, job, deviceId: null, result: firstPage });
    assert.equal(original.status, "COMMITTED");
    assert.equal(original.inserted, 11);
    const originalReceipt = await db.analyticsIngestBatch.findUnique({ where: { id: original.batchId } });
    // Prove the former lifecycle defect without weakening immutable receipts.
    await assert.rejects(ingestNotificationFacts({ db, job: { ...job, params: { ...job.params, types: ["subscriptions"] } },
      deviceId: null, result: firstPage }), error => error.code === "ANALYTICS_INGEST_IDEMPOTENCY_CONFLICT");

    const tip = [{ eventType: "tip_received", notificationId: "300001", fanId: "200000", amountCents: 1299,
      currency: "USD", occurredAt: "2026-10-12T23:03:14.000Z" }];
    await ingestNotificationFacts({ db, job, deviceId: null, result: page(scanRunId, "tips", tip) });
    const completedPartial = { scanRunId, coverage: Object.fromEntries(types.map(type => [type, { status: type === "subscriptions" ? "partial" : "complete" }])) };
    const params = notificationRepairParams({ ...job, params: { ...job.params, types: ["subscriptions"] } },
      new Date("2026-10-14T00:00:00.000Z"), completedPartial);
    assert.deepEqual(params.types, types);
    const repairedJob = await db.jobInstance.update({ where: { id: job.id }, data: { params } });
    const repairedPage = page(params.collectionGeneration, "subscriptions", events);
    const repaired = await ingestNotificationFacts({ db, job: repairedJob, deviceId: null, result: repairedPage });
    assert.equal(repaired.status, "COMMITTED");
    assert.notEqual(repaired.batchId, original.batchId);
    assert.equal(repaired.inserted, 0);
    const replay = await ingestNotificationFacts({ db, job: repairedJob, deviceId: null, result: repairedPage });
    assert.equal(replay.replayed, true);
    assert.equal(replay.batchId, repaired.batchId);
    await ingestNotificationFacts({ db, job: repairedJob, deviceId: null, result: page(params.collectionGeneration, "tips", tip) });
    assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: creator.id } }), 11);
    const tips = await db.creatorTip.aggregate({ where: { creatorId: creator.id }, _count: { _all: true }, _sum: { amountCents: true } });
    assert.equal(tips._count._all, 1);
    assert.equal(tips._sum.amountCents, 1299);
    assert.deepEqual(await db.analyticsIngestBatch.findUnique({ where: { id: original.batchId } }), originalReceipt,
      "repair must not rewrite the previous run's receipt");
    const proof = await notificationCommittedPageProof(db, repairedJob, { scanRunId: params.collectionGeneration, totalAcceptedEvents: 12 });
    assert.equal(proof.verified, true);
    assert.equal(proof.batches, 2, "completion must only count the repaired generation");
    assert.equal(proof.receivedRows, 12);
    console.log(JSON.stringify({ ok: true, oldCollisionReproduced: true, newRunCommits: true, exactReplayIdempotent: true,
      subscriptionFacts: 11, tipFacts: 1, tipCents: 1299, oldReceiptUnchanged: true, repairedRunProof: proof }, null, 2));
  } finally { await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
