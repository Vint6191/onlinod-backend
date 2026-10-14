"use strict";
// Isolated current-schema PGlite + actual Express routes + emitted Desktop handler.
// ONLINOD_SQL_PROOF_RUNTIME=/path/to/pglite ONLINOD_DESKTOP_ROOT=/path/to/desktop node scripts/notification-progress-sql-proof.cjs
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const alive = setInterval(() => {}, 1000);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const types = ["subscriptions", "purchases", "tips", "comments", "likes"];
const envelope = state => ({ driverPhase: "execute", jobContinuation: state });
const subscriptionRows = Array.from({ length: 11 }, (_, i) => ({ id: String(100000 + i), type: "subscribed",
  subType: "new_subscriber", createdAt: "2026-10-12T23:03:14.000Z", user: { id: 200000 + i }, replacePairs: { "{PRICE}": "free" } }));

async function main() {
  const { fixture, scope } = require("./audit/analytics-traffic/fixture.cjs");
  const f = await fixture();
  let server;
  try {
    const db = f.db;
    require.cache[require.resolve("../src/prisma")] = { exports: db };
    const service = require("../src/services/job-lease-service");
    const { ingestNotificationFacts } = require("../src/services/notification-facts-service");
    const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT || "../desktop");
    const { notificationsCatchupHandler: handler } = await import(pathToFileURL(path.join(desktop,
      "apps/desktop/dist/electron/main/services/backend-jobs/handlers/notifications-catchup-handler.js")));
    const express = require("express"), app = express(), unhandled = [];
    app.use(express.json());
    // Only authentication is a loopback test port; all access/lease checks are real.
    app.use((req, res, next) => { req.auth = { userId: "qa-user", agencyId: req.headers["x-fixture-agency"], deviceId: req.body.deviceId }; next(); });
    app.use("/api/jobs", require("../src/routes/jobs"));
    app.use((error, req, res, next) => { unhandled.push(error); res.status(500).json({ code: error.code || "SERVER_ERROR" }); });
    server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
    const base = `http://127.0.0.1:${server.address().port}/api/jobs`;

    async function setup(name, mode = "full") {
      const s = await scope(db, { agencyId: `agency-${name}`, creatorId: `creator-${name}` });
      const now = new Date(), token = crypto.randomBytes(32).toString("base64url"), deviceId = `device-${name}`;
      await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
      const params = { from: "2016-01-01T00:00:00.000Z", to: new Date(+now + 300000).toISOString(), types,
        notificationMode: mode, pageLimit: 10, collectionContractVersion: 1, collectionType: "NOTIFICATIONS",
        collectionMode: mode, collectionGeneration: crypto.randomUUID(), collectionRequestedAt: now.toISOString() };
      const job = await db.jobInstance.create({ data: { id: `job-${name}`, agencyId: s.agencyId, creatorId: s.creatorId,
        jobKey: "catchup_notifications_scan", scope: "creator", status: "CLAIMED", params,
        claimedByDeviceId: deviceId, leaseTokenHash: hash(token), leaseRevision: 1,
        leaseMemberId: `member-${s.agencyId}`, leaseAccessEpoch: 1, leaseUntil: new Date(+now + 600000) } });
      return { ...s, job, token, deviceId };
    }
    async function collect(c, state = null, rows = subscriptionRows, hasMore = true) {
      return handler.runChunk({ job: c.job, creatorId: c.creatorId, continuation: state,
        signal: new AbortController().signal, ofApi: { request: async () => ({ ok: true, status: 200, data: { hasMore, list: rows } }) } });
    }
    function wire(c, step, expected) {
      return { deviceId: c.deviceId, leaseToken: c.token, leaseRevision: c.job.leaseRevision,
        workId: `work-${c.job.id}`, progress: step.progress, chunkResult: step.chunkResult,
        continuation: step.outcome === "done" ? { driverPhase: "complete", result: step.result, progress: step.progress } : envelope(step.continuation),
        ...(expected === undefined ? {} : { expectedContinuation: expected }) };
    }
    async function post(c, endpoint, input, status = 200) {
      const response = await fetch(`${base}/${c.job.id}/${endpoint}`, { method: "POST",
        headers: { "content-type": "application/json", "x-fixture-agency": c.agencyId }, body: JSON.stringify(input) });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    }
    const row = c => db.jobInstance.findUnique({ where: { id: c.job.id } });
    const receipts = c => db.analyticsIngestBatch.findMany({ where: { sourceJobId: c.job.id }, orderBy: { id: "asc" } });

    const c = await setup("replay"), first = await collect(c);
    await post(c, "progress", wire(c, first, envelope(null)));
    const originalReceipts = await receipts(c);
    const changedRows = structuredClone(subscriptionRows); changedRows[0].createdAt = "2026-10-12T23:03:15.000Z";
    const changed = await collect(c, null, changedRows);
    assert.equal(changed.chunkResult.batches[0].batchKey, first.chunkResult.batches[0].batchKey);
    assert.notDeepEqual(changed.chunkResult.batches[0].events, first.chunkResult.batches[0].events);
    for (const expected of [undefined, null, envelope(null)]) {
      const replay = await post(c, "progress", wire(c, changed, expected));
      assert.equal(replay.lease.sideEffect.staleProgress, true);
      assert.deepEqual(replay.lease.continuation, envelope(first.continuation));
    }
    const second = await collect(c, first.continuation, [], false);
    await post(c, "progress", wire(c, second, envelope(first.continuation)));
    await post(c, "progress", wire(c, first));
    assert.deepEqual((await row(c)).continuation, envelope(second.continuation), "late page cannot rewind page 2");
    assert.deepEqual(await receipts(c), originalReceipts);
    assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: c.creatorId } }), 11);
    console.log("PASS changed and exact stale pages: no receipt mutation, no cursor rewind, 11 facts");

    // Receipt persisted by a historical split commit, but its job cursor is absent.
    // Also reproduce the old narrowed-types checksum, without a partial result marker.
    const orphan = await setup("orphan"), page = await collect(orphan);
    const b = page.chunkResult.batches[0];
    await ingestNotificationFacts({ db, job: { ...orphan.job, params: { ...orphan.job.params, types: ["subscriptions"] } },
      deviceId: orphan.deviceId, result: { ...page.chunkResult, events: b.events, notificationType: b.notificationType,
        batchKey: b.batchKey, finalizeCoverage: false, coverage: { subscriptions: { status: "partial" } } } });
    const immutable = await receipts(orphan);
    const staleToken = wire(orphan, page, null);
    const repaired = await post(orphan, "progress", staleToken, 409);
    assert.equal(repaired.code, "JOB_LEASE_STALE");
    const scheduled = await row(orphan);
    assert.equal(scheduled.status, "SCHEDULED"); assert.equal(scheduled.continuation, null);
    assert.equal(scheduled.attempts, 1); assert.equal(scheduled.leaseRevision, 2);
    assert.notEqual(scheduled.params.collectionGeneration, orphan.job.params.collectionGeneration);
    assert.deepEqual(scheduled.params.types, types); assert.equal(scheduled.result, null);
    assert.deepEqual(await receipts(orphan), immutable);
    await post(orphan, "progress", staleToken, 409);
    assert.deepEqual(await row(orphan), scheduled, "retired lease cannot repeat the repair");

    // Seed only capability/billing fixture rows, then use the production claim path.
    await db.agency.update({ where: { id: orphan.agencyId }, data: { trialEndsAt: new Date(Date.now() + 86400000) } });
    await db.deviceCreatorBinding.create({ data: { agencyId: orphan.agencyId, creatorId: orphan.creatorId,
      deviceId: orphan.deviceId, status: "ACTIVE", sessionReadReady: true, lastSeenAt: new Date() } });
    const claimed = await service.claimJob({ userId: orphan.userId, deviceId: orphan.deviceId, jobKeys: ["catchup_notifications_scan"] });
    assert.ok(claimed.job, JSON.stringify(claimed));
    orphan.job = claimed.job; orphan.token = claimed.job.leaseToken;
    let state = null, done;
    const tip = { id: "900001", type: "tip", subType: "new_tips", createdAt: "2026-10-12T23:03:14.000Z", user: { id: 200000 }, amount: 12.99 };
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const phase = state?.fullStage === "all_reconciliation" ? "all" : types[state?.phaseIndex || 0];
      const rows = phase === "subscriptions" ? subscriptionRows : phase === "tips" || phase === "all" ? [tip] : [];
      done = await collect(orphan, state, rows, false);
      if (!done.chunkResult) break;
      await post(orphan, "progress", wire(orphan, done, envelope(state)));
      state = done.continuation;
    }
    assert.equal(done.outcome, "done");
    await post(orphan, "complete", { deviceId: orphan.deviceId, leaseToken: orphan.token,
      leaseRevision: orphan.job.leaseRevision, result: done.result, progress: done.progress });
    assert.equal((await row(orphan)).status, "DONE");
    assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: orphan.creatorId } }), 11);
    const tips = await db.creatorTip.aggregate({ where: { creatorId: orphan.creatorId }, _count: { _all: true }, _sum: { amountCents: true } });
    assert.equal(tips._count._all, 1); assert.equal(tips._sum.amountCents, 1299);
    assert.deepEqual(await db.analyticsIngestBatch.findUnique({ where: { id: immutable[0].id } }), immutable[0]);
    assert.ok((await db.creatorNotificationSyncState.findUnique({ where: { creatorId: orphan.creatorId } })).fullBackfillVerifiedAt);
    console.log("PASS orphan receipt: atomic recovery, production reclaim, full completion, 11 subscriptions + 1 tip/1299 cents");

    // An error after SQL facts/audit writes rolls back both facts and cursor. No
    // receipt recovery should run for unrelated failures. A later retry commits.
    const fault = await setup("rollback"), faultPage = await collect(fault);
    const broken = structuredClone(faultPage); broken.chunkResult.auditItems[0].ordinal = -1;
    await post(fault, "progress", wire(fault, broken), 500);
    assert.equal((await row(fault)).continuation, null); assert.equal((await row(fault)).attempts, 0);
    assert.equal((await receipts(fault)).length, 0);
    assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: fault.creatorId } }), 0);
    await post(fault, "progress", wire(fault, faultPage, null));
    assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: fault.creatorId } }), 11);
    assert.equal(unhandled.length, 1, "only the intentionally invalid audit row is unhandled");
    console.log("PASS late validation failure: full SQL rollback and successful exact retry");
    console.log(JSON.stringify({ ok: true, realHttp: true, realSql: true, emittedDesktopHandler: true, productionReclaim: true, moneyNotDuplicated: true }));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(alive));
