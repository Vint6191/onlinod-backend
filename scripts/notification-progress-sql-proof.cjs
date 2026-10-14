"use strict";
// Isolated current-schema PGlite + actual Express routes + emitted Desktop handler.
// ONLINOD_SQL_PROOF_RUNTIME=/path/to/pglite ONLINOD_DESKTOP_ROOT=/path/to/desktop node scripts/notification-progress-sql-proof.cjs
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const alive = setInterval(() => {}, 1000);
const onlyLive = process.argv.includes("--live-only");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const types = ["subscriptions", "purchases", "tips", "comments", "likes"];
const envelope = state => ({ driverPhase: "execute", jobContinuation: state });
const subscriptionRows = Array.from({ length: 11 }, (_, i) => ({ id: String(100000 + i), type: "subscribed",
  subType: "new_subscriber", createdAt: "2026-10-12T23:03:14.000Z", user: { id: 200000 + i }, replacePairs: { "{PRICE}": "free" } }));
const eventBase = { createdAt: "2026-10-12T23:03:14.000Z", user: { id: 200000 } };
const typedRows = {
  purchases: [{ ...eventBase, id: "900002", type: "paided_message", subType: "subscriber_pay_for_chat_message", amount: 5, messageId: "70001" }],
  tips: [{ ...eventBase, id: "900001", type: "tip", subType: "new_tips", amount: 12.99 }],
  comments: [{ ...eventBase, id: "900003", type: "commented", subType: "new_comment", postId: "70002", commentId: "80001" }],
  likes: [{ ...eventBase, id: "900004", type: "favorited", subType: "new_favorite", postId: "70003" }],
};

async function main() {
  const { fixture, scope } = require("./audit/analytics-traffic/fixture.cjs");
  const f = await fixture();
  let server;
  try {
    const db = f.db;
    require.cache[require.resolve("../src/prisma")] = { exports: db };
    const service = require("../src/services/job-lease-service");
    const { ingestNotificationFacts } = require("../src/services/notification-facts-service");
    const { readManualNotificationScan } = require("../src/services/notification-scan-control-service");
    const desktop = path.resolve(process.env.ONLINOD_DESKTOP_ROOT || "../desktop");
    const { notificationsCatchupHandler: handler } = await import(pathToFileURL(path.join(desktop,
      "apps/desktop/dist/electron/main/services/backend-jobs/handlers/notifications-catchup-handler.js")));
    const express = require("express"), app = express(), unhandled = [];
    app.use(express.json({limit:"2mb"}));
    // Only authentication is a loopback test port; all access/lease checks are real.
    app.use(async (req, res, next) => {
      try {
        const agencyId = req.headers["x-fixture-agency"];
        const membership = await db.agencyMember.findFirst({ where: { agencyId, userId: "qa-user" } });
        req.auth = { userId: "qa-user", agencyId, deviceId: req.body.deviceId, membership };
        next();
      } catch (error) { next(error); }
    });
    app.use("/api/jobs", require("../src/routes/jobs"));
    app.use("/api/stats", require("../src/routes/stats"));
    app.use((error, req, res, next) => { unhandled.push(error); console.error("SQL_PROOF_ROUTE_ERROR", error); res.status(500).json({ code: error.code || "SERVER_ERROR" }); });
    server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
    const base = `http://127.0.0.1:${server.address().port}/api/jobs`;

    async function setup(name, mode = "full") {
      const s = await scope(db, { agencyId: `agency-${name}`, creatorId: `creator-${name}` });
      const now = new Date(), token = crypto.randomBytes(32).toString("base64url"), deviceId = `device-${name}`;
      await db.workerDevice.create({ data: { id: deviceId, agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
      const params = { from: "2016-01-01T00:00:00.000Z", to: new Date(+now + 300000).toISOString(), types,
        notificationMode: mode, notificationNormalizerVersion: "notification-source-v2", pageLimit: 10, collectionContractVersion: 1, collectionType: "NOTIFICATIONS",
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

    async function claim(c) {
      await db.agency.update({ where: { id: c.agencyId }, data: { trialEndsAt: new Date(Date.now() + 86400000) } });
      await db.deviceCreatorBinding.create({ data: { agencyId: c.agencyId, creatorId: c.creatorId,
        deviceId: c.deviceId, status: "ACTIVE", sessionReadReady: true, lastSeenAt: new Date() } });
      const claimed = await service.claimJob({ userId: c.userId, deviceId: c.deviceId, jobKeys: ["catchup_notifications_scan"] });
      assert.equal(claimed.job?.id, c.job.id, JSON.stringify(claimed));
      c.job = claimed.job; c.token = claimed.job.leaseToken;
      assert.deepEqual([...c.job.params.types].sort(), [...types].sort());
      assert.equal(c.job.continuation, null);
    }
    const scanner = c => readManualNotificationScan({ db, creator: { id: c.creatorId, agencyId: c.agencyId } });
    async function finish(c, subscriptionPages = 1) {
      const subscriptions = Array.from({ length: subscriptionPages }, (_, page) => subscriptionRows.map((item, index) => ({
        ...item, id: String(100000 + page * 100 + index), user: { id: 200000 + page * 100 + index },
      })));
      const all = [...subscriptions.flat(), ...Object.values(typedRows).flat()].sort((a, b) => Number(b.id) - Number(a.id));
      const allPages = [];
      for (let i = 0; i < all.length; i += 100) allPages.push(all.slice(i, i + 100));
      const mode = c.job.params.notificationMode;
      let state = null, done, subscriptionPage = 0, allPage = 0, seenPhases = new Set();
      for (let iteration = 0; iteration < 30; iteration += 1) {
        const phase = mode === "catchup" || state?.fullStage === "all_reconciliation" ? "all" : types[state?.phaseIndex || 0];
        let rows = [], hasMore = false;
        if (phase === "all") {
          const start=state?.fromId?all.findIndex(item=>item.id===state.fromId)+1:0;
          rows=all.slice(start,start+100);hasMore=start+rows.length<all.length;
        }
        else if (phase === "subscriptions") { rows = subscriptions[subscriptionPage++]; hasMore = subscriptionPage < subscriptions.length; }
        else rows = typedRows[phase];
        done = await collect(c, state, rows, hasMore);
        if (!done.chunkResult) break;
        seenPhases.add(done.chunkResult.sourcePhase);
        if (mode === "full" && phase === "purchases") assert.equal(done.chunkResult.page, subscriptionPages + 1);
        assert.equal(done.chunkResult.rejectedRows, 0, JSON.stringify(done.chunkResult.auditItems));
        await post(c, "progress", wire(c, done, envelope(state)));
        if (done.outcome === "done") break;
        state = done.continuation;
      }
      assert.equal(done.outcome, "done");
      if (mode === "full") assert.deepEqual([...seenPhases], [...types, "all_reconciliation"]);
      await post(c, "complete", { deviceId: c.deviceId, leaseToken: c.token,
        leaseRevision: c.job.leaseRevision, result: done.result, progress: done.progress });
      assert.equal((await row(c)).status, "DONE");
      assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: c.creatorId } }), subscriptions.flat().length);
      for (const [model, cents] of [["creatorSale", 500], ["creatorTip", 1299]]) {
        const money = await db[model].aggregate({ where: { creatorId: c.creatorId }, _count: { _all: true }, _sum: { amountCents: true } });
        assert.equal(money._count._all, 1); assert.equal(money._sum.amountCents, cents);
      }
      for (const model of ["creatorPostLike", "creatorPostComment"]) assert.equal(await db[model].count({ where: { creatorId: c.creatorId } }), 1);
      const sync = await db.creatorNotificationSyncState.findUnique({ where: { creatorId: c.creatorId } });
      assert.equal(sync.status, "COMPLETE"); assert.ok(sync.fullBackfillVerifiedAt);
      assert.equal(sync.scanRunId, c.job.params.collectionGeneration);
      if (mode === "catchup") { assert.ok(sync.lastCatchupVerifiedAt); assert.equal(sync.knownNotificationIds.includes("retired-unverified-id"), false); }
      const view = await scanner(c);
      const audit = await db.creatorNotificationScanItem.count({ where: { sourceJobId: c.job.id, scanRunId: c.job.params.collectionGeneration } });
      assert.equal(view.status, "COMPLETE"); assert.equal(view.processed, audit);
      assert.equal(view.rejected, 0); assert.equal(view.sourceBoundaryReached, true);
      assert.equal(view.oldestOccurredAt, eventBase.createdAt);
      assert.equal(view.items.some(item => item.page === 68), false); assert.equal(view.reasonSummary.length, 0);
      return { pages: done.chunkResult?.page || state?.page, accepted: view.accepted, subscriptionFacts: subscriptions.flat().length, purchaseCents: 500, tipCents: 1299 };
    }

    if (!onlyLive) {
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
    for (const receipt of originalReceipts) assert.deepEqual(await db.analyticsIngestBatch.findUnique({where:{id:receipt.id}}),receipt);
    assert.equal((await receipts(c)).length, originalReceipts.length + 1, "empty source page has its own receipt");
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
    assert.deepEqual([...scheduled.params.types].sort(), [...types].sort()); assert.equal(scheduled.result, null);
    assert.deepEqual(await receipts(orphan), immutable);
    await post(orphan, "progress", staleToken, 409);
    assert.deepEqual(await row(orphan), scheduled, "retired lease cannot repeat the repair");

    await claim(orphan);
    const orphanProof = await finish(orphan);
    assert.deepEqual(await db.analyticsIngestBatch.findUnique({ where: { id: immutable[0].id } }), immutable[0]);
    console.log("PASS orphan receipt: atomic recovery, production reclaim, all five types and ALL", JSON.stringify(orphanProof));

    // Both active leases and queued legacy commands must upgrade before work.
    // Retired same-job audit/sync rows remain durable, but cannot supply the new
    // run's counters, errors, completion status or verified known-ID frontier.
    for (const mode of ["full", "catchup"]) for (const status of ["CLAIMED", "SCHEDULED"]) {
      const scopeCase = await setup(`scope-${mode}-${status}`, mode);
      const oldRun = scopeCase.job.params.collectionGeneration;
      let state = null;
      if (mode === "full" && status === "CLAIMED") {
        const oldPage = await collect(scopeCase, null, subscriptionRows, false);
        await post(scopeCase, "progress", wire(scopeCase, oldPage, null)); state = oldPage.continuation;
      }
      const oldReceipts = await receipts(scopeCase);
      await db.creatorNotificationScanItem.create({ data: { agencyId: scopeCase.agencyId, creatorId: scopeCase.creatorId,
        sourceJobId: scopeCase.job.id, scanRunId: oldRun, page: 68, ordinal: 0, notificationId: "retired-unverified-id",
        outcome: "REJECTED", reasonCode: "LIKE_POST_ID_MISSING", occurredAt: new Date("2020-01-01T00:00:00Z") } });
      const oldAudit = await db.creatorNotificationScanItem.findMany({ where: { sourceJobId: scopeCase.job.id, scanRunId: oldRun } });
      const yesterday = new Date(Date.now() - 86400000);
      const oldSync = { agencyId: scopeCase.agencyId, creatorId: scopeCase.creatorId, sourceJobId: scopeCase.job.id,
        status: "FAILED", mode, scanRunId: oldRun, pagesScanned: 68, eventsRejected: 1,
        lastErrorCode: "NOTIFICATION_SCAN_FAILED", lastErrorMessage: "lease expired",
        ...(mode === "catchup" ? { normalizerVersion:"notification-source-v2", fullBackfillCompletedAt: yesterday, fullBackfillVerifiedAt: yesterday,
          fullBackfillObservedAt: yesterday, headNotificationId: "verified-old-head", knownNotificationIds: ["verified-old-head"] } : {}) };
      await db.creatorNotificationSyncState.upsert({ where: { creatorId: scopeCase.creatorId }, create: oldSync, update: oldSync });
      scopeCase.job = await db.jobInstance.update({ where: { id: scopeCase.job.id }, data: {
        status, params: { ...scopeCase.job.params, types: ["subscriptions"] }, result: null,
        ...(status === "SCHEDULED" ? { nextRunAt: new Date(), claimedAt: null, claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null } : {}),
      } });
      if (status === "CLAIMED") {
        const attempt = await collect(scopeCase, state, typedRows.purchases, false);
        const retired = await post(scopeCase, "progress", wire(scopeCase, attempt, envelope(state)), 409);
        assert.equal(retired.code, "JOB_LEASE_STALE");
        assert.equal((await row(scopeCase)).attempts, 0);
        const emptyView = await scanner(scopeCase);
        assert.equal(emptyView.processed, 0); assert.equal(emptyView.lastErrorCode, null);
        assert.equal(emptyView.legacySummary.lastErrorMessage, "lease expired");
        assert.deepEqual(await receipts(scopeCase), oldReceipts);
        await post(scopeCase, "progress", wire(scopeCase, attempt), 409);
      }
      await claim(scopeCase);
      assert.notEqual(scopeCase.job.params.collectionGeneration, oldRun);
      assert.equal(scopeCase.job.params.notificationMode, mode); assert.equal((await row(scopeCase)).attempts, 0);
      const proof = await finish(scopeCase, mode === "full" && status === "CLAIMED" ? 12 : 1);
      for (const receipt of oldReceipts) assert.deepEqual(await db.analyticsIngestBatch.findUnique({ where: { id: receipt.id } }), receipt);
      assert.deepEqual(await db.creatorNotificationScanItem.findMany({ where: { sourceJobId: scopeCase.job.id, scanRunId: oldRun } }), oldAudit);
      console.log(`PASS ${status} narrow ${mode}: new scope, no failed attempt, immutable history, current-only inspector`, JSON.stringify(proof));
    }

    // An error after SQL facts/audit writes rolls back both facts and cursor. No
    // receipt recovery should run for unrelated failures. A later retry commits.
    const fault = await setup("rollback"), faultPage = await collect(fault);
    const syncService=require("../src/services/notification-sync-state-service");
    const originalProgress=syncService.recordNotificationPageProgress;
    syncService.recordNotificationPageProgress=async args=>{await originalProgress(args);throw new Error("injected failure after facts, audit and frontier");};
    try { await post(fault, "progress", wire(fault, faultPage), 500); } finally { syncService.recordNotificationPageProgress=originalProgress; }
    assert.equal((await row(fault)).continuation, null); assert.equal((await row(fault)).attempts, 0);
    assert.equal((await receipts(fault)).length, 0);
    assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: fault.creatorId } }), 0);
    await post(fault, "progress", wire(fault, faultPage, null));
    assert.equal(await db.creatorSubscriptionEvent.count({ where: { creatorId: fault.creatorId } }), 11);
    assert.equal(unhandled.length, 1, "only the intentionally injected transaction failure is unhandled");
    console.log("PASS late validation failure: full SQL rollback and successful exact retry");
    const domain = await setup("source-semantics", "catchup");
    const domainRows = [
      {...eventBase,id:"info-price",type:"price_changed",subType:"price_changed_from_free"},
      {...eventBase,id:"info-consent",type:"deactivated_media",subType:"deactivated_consent_withdrawal_request"},
      {...eventBase,id:"deleted-like",type:"favorited",postDeleted:true},
      {...eventBase,id:"missing-like",type:"favorited"},
      {...eventBase,id:"tip-profile",type:"tip",text:"I like comments",user:{id:333,name:"Comment King",price:50},replacePairs:{"{AMOUNT}":"12.99"}},
      {...eventBase,id:"same-minute-1",type:"subscribed",amount:5},
      {...eventBase,id:"same-minute-2",type:"subscribed",amount:5},
    ];
    const domainPage=await collect(domain,null,domainRows,false);
    await post(domain,"progress",wire(domain,domainPage,null));
    const observations=await db.creatorNotificationEvent.findMany({where:{creatorId:domain.creatorId}});
    assert.equal(observations.length,7);
    assert.equal(observations.filter(r=>r.persistenceStatus==="EVENT_STORED").length,2);
    assert.equal(observations.filter(r=>r.persistenceStatus==="TARGET_UNAVAILABLE").length,2);
    assert.equal(observations.find(r=>r.notificationId==="deleted-like").targetState,"DELETED");
    assert.equal(observations.find(r=>r.notificationId==="missing-like").targetState,"UNAVAILABLE");
    assert.equal(await db.creatorPostLike.count({where:{creatorId:domain.creatorId}}),0);
    assert.equal(await db.creatorSubscriptionEvent.count({where:{creatorId:domain.creatorId}}),2);
    assert.equal((await db.creatorTip.findFirst({where:{creatorId:domain.creatorId}})).amountCents,1299);
    const audit=await scanner(domain);assert.equal(audit.accepted,7);assert.equal(audit.rejected,0);
    assert.equal(audit.items.filter(r=>r.persistenceStatus==="FACT_COMMITTED").length,3);
    const sourceService=require("../src/services/notification-source-ledger-service");
    const replayed=await sourceService.ingestNotificationSourcePage({db,job:domain.job,deviceId:domain.deviceId,chunk:domainPage.chunkResult});
    assert.equal(replayed.replayed,true);
    const mutated=structuredClone(domainPage.chunkResult);mutated.observations[0].sourceEvidence.subType="changed";
    await assert.rejects(sourceService.ingestNotificationSourcePage({db,job:domain.job,deviceId:domain.deviceId,chunk:mutated}),{code:"ANALYTICS_INGEST_IDEMPOTENCY_CONFLICT"});
    const proof=await require("../src/services/notification-page-receipt-service").notificationCommittedPageProof(db,domain.job,domainPage.result);
    assert.equal(proof.verified,true);assert.equal(proof.sourceProof.observed,7);
    const brokenProof=await require("../src/services/notification-page-receipt-service").notificationCommittedPageProof(db,domain.job,{...domainPage.result,totalObservedRows:8});assert.equal(brokenProof.verified,false);
    console.log("PASS informational events, unavailable/deleted targets, exact money, strong subscription IDs, DB audit and immutable source replay");

    const repair=await setup("reclassification","catchup");
    await db.creatorSubscriptionEvent.create({data:{agencyId:repair.agencyId,creatorId:repair.creatorId,eventFingerprint:hash("wrong-category"),externalNotificationId:"wrong-tip",eventType:"SUBSCRIBED_PAID",observedPriceCents:500,currency:"USD",occurredAt:new Date(eventBase.createdAt),source:"NOTIFICATION"}});
    const repairPage=await collect(repair,null,[{...eventBase,id:"wrong-tip",type:"tip",amount:5}],false);
    await post(repair,"progress",wire(repair,repairPage,null));
    assert.equal(await db.creatorSubscriptionEvent.count({where:{creatorId:repair.creatorId}}),0);
    assert.equal(await db.creatorTip.count({where:{creatorId:repair.creatorId}}),1);
    assert.equal(await db.creatorNotificationCorrection.count({where:{creatorId:repair.creatorId}}),1);
    console.log("PASS exact notification reclassification removes the former category with a durable correction journal");
    const protectedCase=await setup("protected-fact","catchup");
    await db.creatorSubscriptionEvent.create({data:{agencyId:protectedCase.agencyId,creatorId:protectedCase.creatorId,eventFingerprint:hash("protected-category"),externalNotificationId:"protected-tip",externalTransactionId:"payout-1",eventType:"SUBSCRIBED_PAID",observedPriceCents:500,currency:"USD",occurredAt:new Date(eventBase.createdAt),source:"ONLYFANS_API"}});
    const protectedPage=await collect(protectedCase,null,[{...eventBase,id:"protected-tip",type:"tip",amount:5}],false);
    await post(protectedCase,"progress",wire(protectedCase,protectedPage,null));
    assert.equal(await db.creatorSubscriptionEvent.count({where:{creatorId:protectedCase.creatorId}}),1);
    assert.equal(await db.creatorTip.count({where:{creatorId:protectedCase.creatorId}}),0);
    const protectedView=await scanner(protectedCase);assert.equal(protectedView.rejected,1);assert.equal(protectedView.accepted,0);assert.equal(protectedView.items[0].reasonCode,"RECLASSIFICATION_AUTHORITY_CONFLICT");
    assert.equal((await require("../src/services/notification-page-receipt-service").notificationCommittedPageProof(db,protectedCase.job,protectedPage.result)).verified,false);
    console.log("PASS independently reconciled money is preserved, visibly rejected and cannot prove COMPLETE");
    }
    const live=await setup("live-source","catchup");
    await db.deviceCreatorBinding.create({data:{agencyId:live.agencyId,creatorId:live.creatorId,deviceId:live.deviceId,status:"ACTIVE",realtimeReady:true,accessEpoch:1,lastSeenAt:new Date()}});
    const {normalizeNotificationSource}=await import(pathToFileURL(path.join(desktop,"apps/desktop/dist/electron/main/services/notifications/notification-source-normalizer.js")));
    const rawLive=[{...eventBase,id:"live-tip",type:"tip",replacePairs:{"{AMOUNT}":"12.99"}},{...eventBase,id:"live-info",type:"price_changed",subType:"price_changed_from_free"}];
    const liveEvents=rawLive.map(raw=>{const {event,...observation}=normalizeNotificationSource(raw,live.creatorId);return {normalizerVersion:"notification-source-v2",eventType:"notification_source_observed",notificationFact:event,notificationObservation:observation};});
    const liveBody={deviceId:live.deviceId,batchId:"live-source-proof-0001",observedAt:new Date().toISOString(),sourceTimezone:"UTC",events:liveEvents};
    for(let repeat=0;repeat<2;repeat++){
      const response=await fetch(`${base.replace("/api/jobs","/api/stats")}/creators/${live.creatorId}/notifications/live`,{method:"POST",headers:{"content-type":"application/json","x-fixture-agency":live.agencyId},body:JSON.stringify({...liveBody,observedAt:new Date().toISOString()})});
      const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true);
    }
    assert.equal(await db.creatorTip.count({where:{creatorId:live.creatorId}}),1);assert.equal(await db.creatorNotificationEvent.count({where:{creatorId:live.creatorId}}),2);
    const liveHistory=await collect(live,null,rawLive,false);await post(live,"progress",wire(live,liveHistory,null));
    assert.equal(await db.creatorTip.count({where:{creatorId:live.creatorId}}),1);assert.equal(await db.creatorNotificationEvent.count({where:{creatorId:live.creatorId}}),2);
    assert.equal((await db.creatorNotificationSyncState.findUnique({where:{creatorId:live.creatorId}})).fullBackfillVerifiedAt,null);
    console.log("PASS live HTTP with current device/binding, exact replay and subsequent history preserves one canonical fact");
    await require("../src/services/database-contract-service").assertDatabaseContract(db);
    console.log("PASS additive schema and approved migration chain satisfy startup contract");
    console.log(JSON.stringify({ ok: true, realHttp: true, realSql: true, emittedDesktopHandler: true, productionReclaim: !onlyLive, moneyNotDuplicated: true, scope: onlyLive ? "live-only" : "full" }));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(alive));
