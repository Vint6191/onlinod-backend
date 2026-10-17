"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");

(async () => {
  const runtime = await createScaleSqlRuntime(), results = [];
  const pass = name => { results.push(name); console.log("PASS", name); };
  try {
    const { db } = runtime, s = await scope(db);
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { runRootCommit } = require("../../src/services/db-commit-kernel");
    const { projectFanIdentity, projectEventFanIdentities } = require("../../src/services/fan-data-authority-service");
    const financial = require("../../src/services/financial-transactions-service");
    const receipts = require("../../src/services/financial-receipt-authority");
    const { buildCollectionCommand, COLLECTOR_TYPES } = require("../../src/services/analytics-collector-control-service");
    const tx = work => runRootCommit(db, ({ tx }) => work(tx));
    const now = new Date(), old = new Date("2025-07-13T14:57:39Z");
    const fanInput = { ...s, onlyFansUserId: "159980430", observedAt: old, source: "FINANCIAL_TRANSACTION" };
    await tx(t => projectFanIdentity(t, { ...fanInput, avatarUrl: "https://images.test/avatar?token=old" }));
    // This is the exact production failure, before any source page is written.
    await assert.rejects(tx(t => projectFanIdentity(t, { ...fanInput, avatarUrl: "https://images.test/avatar?token=new" })),
      error => error.code === "FAN_DATA_SAME_GENERATION_CONFLICT");
    pass("reproduced legacy event-date/avatar contradiction against persisted SQL authority");
    const command = buildCollectionCommand({ collectorType: COLLECTOR_TYPES.FINANCIAL, now });
    const initialMarker = String(Math.floor(+now / 1000));
    const params = { ...command, financialReceiptVersion: 1, financialMode: "full", earningsLedgerVersion: 1,
      collectorVersion: receipts.COLLECTOR, endDate: now.toISOString(), financialWindowGeneration: command.collectionGeneration,
      financialWindows: [{ kind: "FULL", from: "2016-01-01T00:00:00.000Z", to: now.toISOString(), initialMarker }] };
    const job = await db.jobInstance.create({ data: { id: "financial-avatar-regression", agencyId: s.agencyId,
      creatorId: s.creatorId, jobKey: "financial_transactions_scan", scope: "creator", status: "RUNNING", params } });
    const row = (id, gross, fan = "159980430", avatar = null) => ({ externalTransactionId: id, transactionType: "tip",
      fanOnlyFansUserId: fan, fanUsername: "known-fan", fanAvatarUrl: avatar,
      occurredAt: old.toISOString(), amountCents: gross, netCents: gross * 0.8, feeCents: gross * 0.2,
      currency: "USD", transactionStatus: "done" });
    const page = { scanRunId: command.collectionGeneration, collectorVersion: receipts.COLLECTOR,
      windowIndex: 0, pageNumber: 1, markerStart: initialMarker, markerEnd: "older-marker", sourceHasMore: true,
      rawReceived: 3, scannerRejected: 0, duplicateRows: 0,
      transactions: [row("one", 1000, "159980430", "avatar-A"), row("two", 2000, "159980430", "avatar-B"), row("deleted-fan", 500, null)] };
    const ingest = chunk => tx(t => financial.ingestFinancialTransactionsChunk({ db: t, job, deviceId: null, chunk }));
    const first = await ingest(page);
    assert.equal(first.accepted, 3); assert.equal(first.inserted, 3); assert.equal(first.rejected, 0);
    assert.equal(first.identityHintConflicts, 1);
    const stored = await db.creatorFinancialTransaction.findMany({ where: { creatorId: s.creatorId } });
    assert.equal(stored.reduce((n, r) => n + r.netCents, 0), 2800);
    assert.equal(stored.find(r => r.externalTransactionId === "deleted-fan").fanRecordId, null);
    assert.equal(await db.creatorTip.count({ where: { creatorId: s.creatorId } }), 3);
    let fan = await db.creatorFan.findUnique({ where: { creatorId_onlyFansUserId: { creatorId: s.creatorId, onlyFansUserId: "159980430" } } });
    assert.equal(fan.avatarUrl, "https://images.test/avatar?token=old");
    assert.equal(fan.username, "known-fan");
    assert.equal(+fan.firstSeenAt, +old); assert.equal(+fan.lastActivityObservedAt, +old);
    assert(+fan.identityObservedAt >= +now);
    pass("whole financial page commits exact NET and tip projections despite ambiguous avatars and unavailable fan");
    assert.equal((await ingest(page)).replay, true);
    assert.equal(await db.creatorFinancialTransaction.count({ where: { creatorId: s.creatorId } }), 3);
    await assert.rejects(ingest({ ...page, transactions: [{ ...page.transactions[0], amountCents: 999 }, ...page.transactions.slice(1)] }),
      error => error.code === "FINANCIAL_RECEIPT_PAYLOAD_CONFLICT");
    pass("receipt replay is idempotent; changed committed monetary page remains rejected");
    const second = await ingest({ ...page, pageNumber: 2, markerStart: "older-marker", markerEnd: null, sourceHasMore: false,
      rawReceived: 1, transactions: [row("three", 100, "159980430", "avatar-current")] });
    assert.equal(second.inserted, 1);
    fan = await db.creatorFan.findUnique({ where: { id: fan.id } });
    assert.equal(fan.avatarUrl, "avatar-current");
    const run = await db.financialReceiptRun.findFirst({ where: { creatorId: s.creatorId } });
    assert.equal(run.proof.windows[0].netCents, 2880); assert.equal(run.cursor.page, 2);
    pass("next page advances durable receipt cursor and mutable profile while event dates remain unchanged");
    const hint = { ...s, onlyFansUserId: "159980430", source: "LIVE_NOTIFICATION", activityObservedAt: old,
      username: "notification-user", avatarUrl: "notification-avatar" };
    const hintAt = new Date(+now + 1000);
    await tx(t => projectEventFanIdentities(t, [hint], hintAt));
    const conflict = await tx(t => projectEventFanIdentities(t, [{ ...hint, avatarUrl: "different", platformDisplayName: "available name" }], hintAt));
    assert.equal(conflict.ambiguousFields, 1);
    fan = await db.creatorFan.findUnique({ where: { id: fan.id } });
    assert.equal(fan.avatarUrl, "notification-avatar"); assert.equal(fan.displayName, "available name");
    await assert.rejects(tx(t => projectFanIdentity(t, { ...s, onlyFansUserId: "159980430", observedAt: hintAt,
      source: "LIVE_NOTIFICATION", avatarUrl: "strict-conflict" })), error => error.code === "FAN_DATA_SAME_GENERATION_CONFLICT");
    pass("notification hints withhold tied conflicting fields; strict canonical authority is unchanged");
    const notifications = require("../../src/services/notification-facts-service");
    const notificationJob = await db.jobInstance.create({ data: { id: "notification-avatar-regression", agencyId: s.agencyId,
      creatorId: s.creatorId, jobKey: "catchup_notifications_scan", scope: "creator", status: "RUNNING",
      params: { from: "2025-07-13T00:00:00Z", to: "2025-07-13T23:59:59.999Z", types: ["tips"] } } });
    const notificationPage = { collectorVersion: "notifications-catchup-v4", schemaVersion: 3, sourceTimezone: "UTC",
      scanRunId: "notification-avatar-run", batchKey: "run:notification-avatar-run:completion", finalizeCoverage: true,
      coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 2, rejected: 0 } },
      events: ["A", "B"].map(suffix => ({ eventType: "tip_received", notificationId: `notification-${suffix}`,
        fanId: "159980430", fanAvatarUrl: `variant-${suffix}`, fanName: "Profile",
        amountCents: 500, currency: "USD", occurredAt: old.toISOString() })) };
    const receive = result => tx(t => notifications.ingestNotificationFacts({ db: t, job: notificationJob, deviceId: null, result }));
    const notificationResult = await receive(notificationPage);
    assert.equal(notificationResult.status, "COMMITTED"); assert.equal(notificationResult.rejected, 0);
    assert.equal(notificationResult.inserted, 2); assert.equal(notificationResult.identityHintConflicts, 1);
    assert.equal((await receive(notificationPage)).replayed, true);
    assert.equal(await db.creatorTip.count({ where: { creatorId: s.creatorId } }), 6);
    pass("notification ingest commits both exact tips and coverage despite profile variants; replay preserves totals");
    const many = Array.from({ length: 2_000 }, () => ({ ...hint, onlyFansUserId: "large-page-fan" }));
    assert.equal((await tx(t => projectEventFanIdentities(t, many, hintAt))).fans.size, 1);
    await assert.rejects(tx(t => projectEventFanIdentities(t, [...many, hint], hintAt)), /Invalid event participant observation batch/);
    pass("full legacy notification batch stays bounded and merges repeated fans once");
    const before = await db.creatorFan.findUnique({ where: { id: fan.id } });
    await assert.rejects(tx(async t => {
      await projectEventFanIdentities(t, [{ ...hint, username: "must-rollback" }], new Date(+hintAt + 1000));
      throw new Error("FAIL_BEFORE_COMMIT");
    }), /FAIL_BEFORE_COMMIT/);
    assert.deepEqual(await db.creatorFan.findUnique({ where: { id: fan.id } }), before);
    pass("database failure rolls back metadata with transaction; no catch-and-continue write path");
    if (runtime.native) {
      const concurrentAt = new Date(+hintAt + 2000);
      const results = await Promise.all(['left', 'right'].map(username => tx(t => projectEventFanIdentities(t,
        [{ ...hint, onlyFansUserId: 'concurrent-fan', username }], concurrentAt))));
      assert.equal(results.reduce((n, value) => n + value.ambiguousFields, 0), 1);
      assert.equal(await db.creatorFan.count({ where: { creatorId: s.creatorId, onlyFansUserId: 'concurrent-fan' } }), 1);
      pass("native concurrent metadata tie serializes once without poisoning either transaction");
    }
    const report = { ok: true, engine: runtime.native ? "PostgreSQL" : "PGlite + Prisma, single connection", results };
    if (process.env.ONLINOD_EVENT_PARTICIPANT_REPORT) fs.writeFileSync(process.env.ONLINOD_EVENT_PARTICIPANT_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
