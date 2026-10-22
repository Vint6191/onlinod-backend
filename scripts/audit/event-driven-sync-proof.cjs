"use strict";
const assert = require("node:assert/strict"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const desktop = process.env.ONLINOD_DESKTOP_PROOF_ROOT
  ? path.resolve(process.env.ONLINOD_DESKTOP_PROOF_ROOT)
  : path.resolve(root, "../desktop");
if (!process.env.ONLINOD_SQL_PROOF_RUNTIME)
  throw Error("ONLINOD_SQL_PROOF_RUNTIME must point to a local disposable PGlite + pglite-socket installation");
const { createAdminSqlRuntime } = require(root + "/scripts/test-support/admin-sql-runtime.cjs");
const { scope } = require(root + "/scripts/audit/analytics-traffic/fixture.cjs");
const checks = [];
const pass = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
async function main() {
  const f = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME });
  try {
    const { db } = f,
      s = await scope(db),
      member = await db.agencyMember.findUnique({ where: { id: "member-" + s.agencyId } });
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const sync = require(root + "/src/services/creator-live-sync-service");
    const frontier = require(root + "/src/services/notification-frontier-authority");
    const financial = require(root + "/src/services/financial-receipt-authority");
    const money = require(root + "/src/services/live-earnings-projection-service");
    const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
    const tx = (fn) => runRootCommit(db, ({ tx }) => fn(tx));
    assert.equal(
      (await require(root + "/src/services/database-contract-service").readDatabaseContract(db)).ready,
      true
    );
    pass("current migration and catalog readiness");
    const base = new Date();
    base.setUTCHours(1, 0, 0, 0);
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    async function sample(device, session, at, seq = 0, lossRevision = 0) {
      return tx((t) =>
        sync.recordCaptureSample({
          db: t,
          ...s,
          memberId: member.id,
          accessEpoch: member.accessEpoch,
          deviceId: device,
          now: at,
          account: {
            realtimeHealthy: true,
            lastWsFrameAt: at.toISOString(),
            observation: {
              version: 1,
              moneyRevisionVersion: 1,
              sessionId: session,
              capturedThroughAt: at.toISOString(),
              capturedThroughSeq: seq,
              loss: lossRevision > 0,
              lossRevision,
            },
          },
        })
      );
    }
    await sample("a", a, base);
    for (let min = 1; min <= 720; min++)
      await sample(min < 10 ? "a" : "b", min < 10 ? a : b, new Date(+base + min * 60000));
    assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "CreatorRecoveryIntent"'))[0].n, 0);
    pass("12 hours healthy including one device offline produce no recovery");
    // A continuous local journal can bridge a server outage without provider work.
    const bridged = await scope(db, { agencyId: "bridge-agency", creatorId: "bridge-creator", userId: "bridge-user" });
    const bridgeMember = await db.agencyMember.findUnique({ where: { id: "member-" + bridged.agencyId } }),
      bridgeSession = crypto.randomUUID();
    const bridgeAt = new Date(+base + 70 * 60000);
    const bridgeSample = (at) =>
      tx((t) =>
        sync.recordCaptureSample({
          db: t,
          ...bridged,
          memberId: bridgeMember.id,
          accessEpoch: bridgeMember.accessEpoch,
          deviceId: "bridge",
          now: at,
          account: {
            realtimeHealthy: true,
            lastWsFrameAt: at.toISOString(),
            observation: {
              version: 1,
              moneyRevisionVersion: 1,
              sessionId: bridgeSession,
              capturedThroughAt: at.toISOString(),
              capturedThroughSeq: 0,
              captureFromAt: base.toISOString(),
            },
          },
        })
      );
    await bridgeSample(base);
    await bridgeSample(bridgeAt);
    assert.equal(
      (
        await db.$queryRawUnsafe(
          'SELECT count(*)::int AS n FROM "CreatorRecoveryIntent" WHERE "creatorId"=$1',
          bridged.creatorId
        )
      )[0].n,
      0
    );
    pass("continuous durable capture bridges a backend outage without starting provider scans");
    const returned = new Date(+base + 781 * 60000);
    await sample("a", a, returned, 2);
    await sample("b", b, returned, 0);
    assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "CreatorRecoveryIntent"'))[0].n, 4);
    pass("61 minutes without any receiver and simultaneous returns create one intent per stream");
    const events = [{ key: "one" }, { key: "two" }];
    const deliver = (entries, ev, ingest = async () => []) =>
      tx((t) =>
        sync.acceptDelivery({
          db: t,
          ...s,
          deviceId: "a",
          memberId: member.id,
          accessEpoch: member.accessEpoch,
          delivery: { version: 1, sessionId: a, entries },
          events: ev,
          now: returned,
          ingest,
        })
      );
    const entries = [1, 2].map((seq) => ({ seq, capturedAt: returned.toISOString() }));
    await assert.rejects(() => deliver([entries[1]], [events[1]]), /DELIVERY_GAP/);
    await assert.rejects(
      () =>
        deliver(entries, events, async () => {
          throw Error("rollback");
        }),
      /rollback/
    );
    assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "CreatorRealtimeReceipt"'))[0].n, 0);
    assert.equal((await deliver(entries, events)).deliveryAck.throughSeq, 2);
    assert.equal((await deliver(entries, events)).deliveryAck.throughSeq, 2);
    await assert.rejects(() => deliver(entries, [{ key: "changed" }, events[1]]), /PAYLOAD_CONFLICT/);
    pass("delivery holes rejected; facts/ACK rollback together; lost ACK replay and changed payload distinguished");
    const intents = await db.$queryRawUnsafe('SELECT * FROM "CreatorRecoveryIntent"');
    for (const i of intents) {
      const job = {
        id: "recovery-" + i.stream,
        ...s,
        jobKey: Object.keys(sync.JOB_STREAM).find((k) => sync.JOB_STREAM[k] === i.stream),
        params: sync.recoveryParams(i),
      };
      await tx(async (t) => {
        await sync.bindRecovery(t, i, job.id);
        await sync.completeRecovery(t, job, true, { coveredThrough: returned });
      });
    }
    await sample("a", a, new Date(+returned + 60000), 2, 1);
    assert.equal(
      (await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "CreatorRecoveryIntent" WHERE status<>'COMPLETE'`))[0]
        .n,
      4
    );
    pass("durable capture loss creates explicit repair debt");
    const j = {
      ...s,
      params: {
        notificationMode: "catchup",
        notificationFrontierVersion: 2,
        collectionGeneration: "notification-test",
        knownNotificationIds: ["known", "old"],
      },
    };
    const chunk = (page, start, end, ids, done = false, more = true) => ({
      page,
      cursorStart: start,
      cursorEnd: end,
      sourcePhase: "all",
      sourceHasMore: more,
      observations: ids.map((notificationId) => ({ notificationId })),
      sourceExhausted: done,
      stopReason: done ? (more ? "known_boundary_reached" : "source_exhausted") : null,
    });
    let p = await tx((t) => frontier.commitPage(t, j, chunk(1, null, "new", ["new"]), {}));
    p = await tx((t) => frontier.commitPage(t, j, chunk(2, "new", "known", ["known"]), p));
    assert.equal(p.phase, "OVERLAP");
    assert(!frontier.completed(j, p));
    const c3 = chunk(3, "known", "old", ["old"], true);
    p = await tx((t) => frontier.commitPage(t, j, c3, p));
    assert(frontier.completed(j, p));
    assert.deepEqual(await tx((t) => frontier.commitPage(t, j, c3, p)), p);
    await assert.rejects(
      () => tx((t) => frontier.commitPage(t, j, { ...c3, cursorEnd: "tamper" }, p)),
      /PAYLOAD_CONFLICT/
    );
    pass("notification known page requires extra page, replay safe");
    const fj = {
      ...s,
      id: "fin-job",
      jobKey: "financial_transactions_scan",
      params: {
        financialReceiptVersion: 1,
        financialFrontierVersion: 2,
        financialFrontierKnownIds: ["known"],
        financialFrontierBaselineGeneration: "baseline",
        collectionMode: "catchup",
        collectionGeneration: "fin-gen",
        financialWindowGeneration: "fin-gen",
        collectionRequestedAt: returned.toISOString(),
        endDate: returned.toISOString(),
      },
    };
    fj.params.financialWindows = financial.planWindows(fj.params, {});
    let continuation;
    async function page(number, ids, markerStart, markerEnd, more = true) {
      const accepted = ids.map((id, i) => ({
        externalTransactionId: id,
        occurredAt: new Date(+returned - 3600000),
        transactionType: "tip",
        factType: "TIP",
        projectionStatus: "PROJECTED",
        fanOnlyFansUserId: null,
        currency: "USD",
        reasonCode: null,
        amountCents: 1000,
        netCents: 800,
        feeCents: 200,
        transactionStatus: "done",
        page: number,
        ordinal: i,
      }));
      const ch = {
        collectorVersion: financial.COLLECTOR,
        scanRunId: "fin-gen",
        windowIndex: 0,
        pageNumber: number,
        markerStart,
        markerEnd,
        rawReceived: accepted.length,
        scannerRejected: 0,
        duplicateRows: 0,
        sourceHasMore: more,
        transactions: accepted,
      };
      return tx(async (t) => {
        const pre = await financial.beforePage(t, fj, ch);
        if (pre.replay) return pre.financialContinuation;
        return financial.commitPage(t, fj, ch, pre, accepted, 0);
      });
    }
    continuation = await page(1, ["new"], fj.params.financialWindows[0].initialMarker, "m2");
    assert.equal(continuation.driverPhase, "execute");
    continuation = await page(2, ["known"], "m2", "m3");
    assert.equal(continuation.jobContinuation.frontierPhase, "OVERLAP");
    continuation = await page(3, ["older"], "m3", "m4");
    assert.equal(continuation.driverPhase, "complete");
    assert.equal((await financial.completionProof(db, fj)).complete, true);
    pass("financial receipts freeze known boundary, persist overlap and finish without chart requests");
    // Money baseline and live updates use exact transaction identity.
    await db.workerDevice.create({
      data: { id: "money-device", agencyId: s.agencyId, userId: s.userId, lastSeenAt: new Date() },
    });
    const today = new Date(new Date().toISOString().slice(0, 10));
    const now = new Date(+today + 15 * 3600000);
    await tx((t) =>
      t.$executeRawUnsafe(
        `INSERT INTO "CreatorEarningsLedgerProof"("creatorId","agencyId","fromAt","throughAt",generation) VALUES($1,$2,$3,$4,'proof-fixture')`,
        s.creatorId,
        s.agencyId,
        new Date(+today - 180 * 86400000),
        now
      )
    );
    await tx((t) => t.$executeRawUnsafe(`UPDATE "CreatorRecoveryIntent" SET status='COMPLETE'`));
    await tx((t) =>
      t.$executeRawUnsafe(
        `UPDATE "CreatorLiveSync" SET "shortGapFrom"=NULL,"lastDeliveredAt"=$2 WHERE "creatorId"=$1`,
        s.creatorId,
        now
      )
    );
    const event = (id) => ({
      notificationObservation: {
        identityKey: "notice-" + id,
        category: "tips",
        occurredAt: new Date(+today + 10 * 3600000).toISOString(),
        amountCents: 1000,
      },
      moneyObservation: {
        version: 1,
        transactionId: id,
        transactionType: "tip",
        amountCents: 1000,
        netCents: 800,
        feeCents: 200,
        currency: "USD",
        status: "done",
        occurredAt: new Date(+today + 10 * 3600000).toISOString(),
        revisionAt: new Date(+today + 11 * 3600000).toISOString(),
      },
    });
    const ingest = (events) =>
      tx((t) => money.ingestLive({ db: t, ...s, deviceId: "money-device", events, capturedAt: now, now }));
    await ingest([event("tx1"), event("tx2")]);
    await ingest([event("tx1")]);
    const home = require(root + "/src/services/home-read-repository");
    const homeInput = {
      db,
      ...s,
      member,
      money: true,
      manage: true,
      range: { startDay: today, endDay: today },
      previous: { startDay: new Date(+today - 86400000), endDay: new Date(+today - 86400000) },
      now,
    };
    let totals = await home.readHomeTotals(homeInput);
    assert.equal(totals.totalCents, 1600);
    assert.equal(totals.staleCreators, 0);
    assert.equal(totals.points.length, 24);
    assert.equal(
      totals.points.reduce((a, p) => a + p.valueCents, 0),
      1600
    );
    pass("two equal payments remain distinct; replay adds no money; Home sum equals 24-hour curve");
    const overviewDays = await require(
      root + "/src/services/published-earnings-read-repository"
    ).readPublishedEarningsDays({ db, creatorId: s.creatorId, from: today, to: today, now });
    assert.equal(overviewDays[0].daily.totalCents, 1600);
    assert.equal(overviewDays[0].daily.tipsCents, 1600);
    pass("Creator Overview and Home use the same NET, categories and hourly projection");
    const refunded = event("tx1");
    refunded.moneyObservation.status = "undo";
    refunded.moneyObservation.revisionAt = new Date(+today + 12 * 3600000).toISOString();
    await ingest([refunded]);
    await ingest([event("tx1")]);
    totals = await home.readHomeTotals(homeInput);
    assert.equal(totals.totalCents, 800);
    pass("refund subtracts only its transaction; delayed older event cannot undo correction");
    const pageView = await home.readHomeCreatorPage(homeInput);
    assert.equal(pageView.creators[0].revenueCents, 800);
    for (const days of [4, 7, 30, 90]) {
      const range = { startDay: new Date(+today - (days - 1) * 86400000), endDay: today };
      const result = await home.readHomeTotals({
        ...homeInput,
        range,
        previous: {
          startDay: new Date(+range.startDay - days * 86400000),
          endDay: new Date(+range.startDay - 86400000),
        },
      });
      assert.equal(result.totalCents, 800);
      assert.equal(result.points.length, days);
      assert.equal(
        result.points.reduce((a, p) => a + p.valueCents, 0),
        800
      );
    }
    pass("Home creator rows and every 4/7/30/90-day range share the same money and complete curve");
    const conflict = event("tx2");
    conflict.moneyObservation.netCents = 700;
    await ingest([conflict]);
    assert.equal((await home.readHomeTotals(homeInput)).totalCents, 800);
    assert.equal(
      (
        await db.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "CreatorMoneyObservation" WHERE reason='TRANSACTION_REVISION_CONFLICT'`
        )
      )[0].n,
      1
    );
    pass("a conflicting revision stays unresolved and cannot overwrite previously applied NET");
    await ingest([
      {
        notificationObservation: {
          identityKey: "uncertain",
          category: "tips",
          amountCents: 1000,
          occurredAt: now.toISOString(),
        },
      },
    ]);
    totals = await home.readHomeTotals(homeInput);
    assert.equal(totals.totalCents, 800);
    assert.equal(totals.staleCreators, 1);
    pass("missing exact NET preserves money and marks unresolved coverage instead of inventing commission");
    const planner = require(root + "/src/services/analytics-collection-planner");
    assert.equal((await planner.enqueueHomeAnalyticsFreshnessDemand({ mode: "automatic" })).queued, false);
    const planned = await planner.ensureAnalyticsWindowFreshness({
      db,
      ...s,
      startDay: new Date(+today - 89 * 86400000),
      endDay: today,
      now,
    });
    assert.equal(planned.created, 0);
    pass("Home automatic refresh and rolling window cannot enqueue provider scans after baseline");
    // The real HTTP handler (fixture-injected auth context, real access fences) and
    // Desktop normalizer are exercised together. No provider/API fixture is claimed.
    const wall = new Date(),
      httpAt = new Date(+wall - 60000).toISOString();
    await tx((t) =>
      t.deviceCreatorBinding.create({
        data: {
          agencyId: s.agencyId,
          creatorId: s.creatorId,
          deviceId: "money-device",
          accessEpoch: member.accessEpoch,
          realtimeReady: true,
          sessionReadReady: true,
          lastSeenAt: wall,
        },
      })
    );
    const express = require(root + "/node_modules/express"),
      app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.auth = { userId: s.userId, agencyId: s.agencyId, deviceId: "money-device", membership: member };
      next();
    });
    app.use("/api/stats", require(root + "/src/routes/stats"));
    const server = await new Promise((resolve) => {
      const v = app.listen(0, "127.0.0.1", () => resolve(v));
    });
    try {
      const { normalizeRuntimeWsFrame } = await import(
        path.resolve(desktop, "apps/desktop/dist/electron/main/services/creator-runtime/creator-runtime-normalizer.js")
      );
      const { canonicalRuntimeEvent } = await import(
        path.resolve(
          desktop,
          "apps/desktop/dist/electron/main/services/creator-analytics/creator-analytics-live-service.js"
        )
      );
      const frames = normalizeRuntimeWsFrame(
        {
          direction: "in",
          data: JSON.stringify({
            new_message: {
              id: "http-notice",
              type: "tip",
              createdAt: httpAt,
              user: { id: 123456 },
              transactionId: "http-payment",
              transactionType: "tip",
              amount: 10,
              net: 8,
              fee: 2,
              status: "done",
              currency: "USD",
            },
          }),
        },
        { accountId: s.creatorId }
      );
      const event = frames
        .map((event) => canonicalRuntimeEvent({ creatorId: s.creatorId, event }))
        .find((event) => event?.moneyObservation);
      assert(event);
      const body = {
        deviceId: "money-device",
        batchId: "http-proof-batch",
        observedAt: wall.toISOString(),
        sourceTimezone: "UTC",
        events: [event],
        delivery: { version: 1, sessionId: crypto.randomUUID(), entries: [{ seq: 1, capturedAt: wall.toISOString() }] },
      };
      const request = async (value) => {
        const r = await fetch(
          `http://127.0.0.1:${server.address().port}/api/stats/creators/${s.creatorId}/notifications/live`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }
        );
        return { status: r.status, body: await r.json() };
      };
      const first = await request(body);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.deliveryAck.throughSeq, 1);
      const replay = await request(body);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(
        await db.creatorFinancialTransaction.count({
          where: { creatorId: s.creatorId, externalTransactionId: "http-payment" },
        }),
        1
      );
      assert.equal(
        (
          await db.$queryRawUnsafe(
            'SELECT "netCents" FROM "CreatorEarningsLedgerEntry" WHERE "creatorId"=$1 AND "transactionId"=$2',
            s.creatorId,
            "http-payment"
          )
        )[0].netCents,
        800n
      );
      const tampered = structuredClone(body);
      tampered.events[0].moneyObservation.netCents = 600;
      assert.equal((await request(tampered)).body.code, "LIVE_DELIVERY_PAYLOAD_CONFLICT");
      const faultEvent=structuredClone(event);
      Object.assign(faultEvent.moneyObservation,{transactionId:"http-rollback",fanOnlyFansUserId:"987654",fanUsername:"current_fan",
        revisionAt:new Date(+wall-30000).toISOString()});
      const nextBody=(events,seq)=>({...body,batchId:"http-authority-"+seq,events,
        delivery:{...body.delivery,entries:events.map((_,index)=>({seq:seq+index,capturedAt:wall.toISOString()}))}});
      // Inject a crash after the real money/fan/fact writes, while still inside
      // the actual HTTP root commit. No monetary implementation is replaced.
      const realIngest=money.ingestLive;
      money.ingestLive=async input=>{await realIngest(input);throw Object.assign(Error("INJECTED_AFTER_LIVE_MONEY"),{code:"INJECTED_AFTER_LIVE_MONEY"});};
      try {assert.equal((await request(nextBody([faultEvent],2))).status,500);}
      finally {money.ingestLive=realIngest;}
      for(const [model,where] of [
        ["creatorFinancialTransaction",{creatorId:s.creatorId,externalTransactionId:"http-rollback"}],
        ["creatorTip",{creatorId:s.creatorId,externalTransactionId:"http-rollback"}],
        ["creatorFan",{creatorId:s.creatorId,onlyFansUserId:"987654"}],
        ["creatorEarningsLedgerEntry",{creatorId:s.creatorId,transactionId:"http-rollback"}],
      ])assert.equal(await db[model].count({where}),0,model+" escaped failed root commit");
      let httpSession=await db.creatorRealtimeSession.findFirst({where:{creatorId:s.creatorId,incarnation:body.delivery.sessionId}});
      assert.equal(httpSession.ackedSeq,1n);
      assert.equal(await db.creatorRealtimeReceipt.count({where:{sessionId:httpSession.id,seq:2n}}),0);
      const retried=await request(nextBody([faultEvent],2));assert.equal(retried.status,200,JSON.stringify(retried.body));assert.equal(retried.body.deliveryAck.throughSeq,2);
      const knownFan=await db.creatorFan.findUnique({where:{creatorId_onlyFansUserId:{creatorId:s.creatorId,onlyFansUserId:"987654"}}});assert(knownFan);
      const financialWhere={creatorId_externalTransactionId:{creatorId:s.creatorId,externalTransactionId:"http-rollback"}};
      const knownTransaction=await db.creatorFinancialTransaction.findUnique({where:financialWhere});
      assert.equal(knownTransaction.fanRecordId,knownFan.id);assert.equal(knownTransaction.fanUsernameAtEvent,"current_fan");
      assert.equal((await db.creatorTip.findUnique({where:financialWhere})).fanRecordId,knownFan.id);
      const correction=structuredClone(faultEvent);Object.assign(correction.moneyObservation,{status:"undo",revisionAt:new Date(+wall-10000).toISOString()});
      delete correction.moneyObservation.fanOnlyFansUserId;delete correction.moneyObservation.fanUsername;
      assert.equal((await request(nextBody([correction],3))).status,200);
      let corrected=await db.creatorFinancialTransaction.findUnique({where:financialWhere});
      assert.equal(corrected.transactionStatus,"undo");assert.equal(corrected.fanRecordId,knownFan.id);assert.equal(corrected.fanUsernameAtEvent,"current_fan");
      const stale=structuredClone(faultEvent);stale.moneyObservation.fanOnlyFansUserId="999999";
      assert.equal((await request(nextBody([stale],4))).status,200);
      assert.equal((await db.creatorFinancialTransaction.findUnique({where:financialWhere})).transactionStatus,"undo");
      assert.equal(await db.creatorFan.count({where:{creatorId:s.creatorId,onlyFansUserId:"999999"}}),0);
      const unknown=structuredClone(correction);Object.assign(unknown.moneyObservation,{transactionId:"http-unknown-fan",status:"done"});
      assert.equal((await request(nextBody([unknown],5))).status,200);
      assert.equal((await db.creatorFinancialTransaction.findUnique({where:{creatorId_externalTransactionId:{creatorId:s.creatorId,externalTransactionId:"http-unknown-fan"}}})).fanRecordId,null);
      pass("HTTP live money uses canonical fan authority; crash rolls money/fan/facts/receipt/ACK back together; retry, unknown fan and identity-preserving refund converge");
      await tx((t) =>
        t.deviceCreatorBinding.updateMany({ where: { creatorId: s.creatorId }, data: { realtimeReady: false } })
      );
      const rejected = await request({
        ...body,
        batchId: "http-proof-second",
        delivery: { ...body.delivery, entries: [{ seq: 6, capturedAt: wall.toISOString() }] },
      });
      assert.equal(rejected.status, 409);
      const [receipt] = await db.$queryRawUnsafe(
        `SELECT "ackedSeq" FROM "CreatorRealtimeSession" WHERE "creatorId"=$1 AND incarnation=$2`,
        s.creatorId,
        body.delivery.sessionId
      );
      assert.equal(receipt.ackedSeq, 5n);
      pass(
        "Desktop normalization -> HTTP access fence -> canonical fact and money -> ACK; replay safe and withdrawn binding cannot advance ACK"
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const fsScope = await scope(db, {
      agencyId: "financial-agency",
      creatorId: "financial-creator",
      userId: "financial-user",
    });
    const fsMember = await db.agencyMember.findUnique({ where: { id: "member-" + fsScope.agencyId } });
    const firstManual = await planner.ensureAnalyticsWindowFreshness({
      db,
      ...fsScope,
      startDay: today,
      endDay: today,
      reason: "HOME_INTERACTIVE_REFRESH",
      now: wall,
    });
    const secondManual = await planner.ensureAnalyticsWindowFreshness({
      db,
      ...fsScope,
      startDay: new Date(+today - 89 * 86400000),
      endDay: today,
      reason: "HOME_INTERACTIVE_REFRESH",
      now: wall,
    });
    assert.equal(firstManual.created, 1);
    assert.equal(secondManual.created, 0);
    assert.equal(firstManual.jobs[0].id, secondManual.jobs[0].id);
    assert.equal(firstManual.jobs[0].params.collectionMode, "full");
    pass("manual Home refresh across periods coalesces into one financial baseline job");
    const fullJob = await db.jobInstance.findUnique({ where: { id: firstManual.jobs[0].id } });
    fullJob.params = await financial.claimParams(db, fullJob);
    await db.workerDevice.create({
      data: { id: "full-device", agencyId: fsScope.agencyId, userId: fsScope.userId, lastSeenAt: new Date() },
    });
    await db.agency.update({ where: { id: fsScope.agencyId }, data: { trialEndsAt: new Date(Date.now() + 86400000) } });
    const token = "full-proof-token";
    await tx(async (t) => {
      await financial.enter(t);
      return t.jobInstance.update({
        where: { id: fullJob.id },
        data: {
          params: fullJob.params,
          status: "CLAIMED",
          claimedByDeviceId: "full-device",
          leaseUntil: new Date(Date.now() + 600000),
          leaseRevision: 1,
          leaseTokenHash: crypto.createHash("sha256").update(token).digest("hex"),
          leaseMemberId: fsMember.id,
          leaseAccessEpoch: fsMember.accessEpoch,
        },
      });
    });
    const start = new Date(fullJob.params.collectionRequestedAt),
      happened = new Date(+start - 3600000),
      later = new Date(+start + 1000);
    const live = {
      notificationObservation: { identityKey: "newer-proof-event", category: "tips" },
      moneyObservation: {
        version: 1,
        transactionId: "full-one",
        transactionType: "tip",
        fanOnlyFansUserId: "42",
        amountCents: 1000,
        netCents: 800,
        feeCents: 200,
        currency: "USD",
        status: "undo",
        occurredAt: happened.toISOString(),
        revisionAt: later.toISOString(),
      },
    };
    await tx((t) =>
      money.ingestLive({ db: t, ...fsScope, deviceId: null, events: [live], capturedAt: later, now: later })
    );
    const fin = require(root + "/src/services/financial-transactions-service");
    const transactions = ["full-one", "full-two"].map((externalTransactionId) => ({
      externalTransactionId,
      fanOnlyFansUserId: "42",
      transactionType: "tip",
      occurredAt: happened.toISOString(),
      amountCents: 1000,
      netCents: 800,
      feeCents: 200,
      currency: "USD",
      transactionStatus: "done",
    }));
    const fullChunk = {
      collectorVersion: financial.COLLECTOR,
      scanRunId: fullJob.params.collectionGeneration,
      windowIndex: 0,
      pageNumber: 1,
      markerStart: fullJob.params.financialWindows[0].initialMarker,
      markerEnd: null,
      rawReceived: 2,
      scannerRejected: 0,
      duplicateRows: 0,
      sourceHasMore: false,
      transactions,
    };
    await tx((t) => fin.ingestFinancialTransactionsChunk({ db: t, job: fullJob, deviceId: null, chunk: fullChunk }));
    const w = fullJob.params.financialWindows[0];
    for (const category of ["total", "subscribes", "tips", "messages", "post", "stream"])
      await tx((t) =>
        fin.ingestFinancialChartChunk({
          db: t,
          job: fullJob,
          deviceId: null,
          chunk: {
            collectorVersion: financial.COLLECTOR,
            scanRunId: fullJob.params.collectionGeneration,
            windowIndex: 0,
            category,
            rangeFrom: w.from,
            rangeTo: w.to,
            grossCents: ["total", "tips"].includes(category) ? 2000 : 0,
            netCents: ["total", "tips"].includes(category) ? 1600 : 0,
            transactionsCount: ["total", "tips"].includes(category) ? 2 : 0,
          },
        })
      );
    const receipt = await financial.completionProof(db, fullJob);
    assert.equal(receipt.complete, true);
    const lease = require(root + "/src/services/job-lease-service"),
      publisher = require(root + "/src/services/analytics-publication-service");
    const accepted = await lease.completeJob({
      jobId: fullJob.id,
      userId: fsScope.userId,
      deviceId: "full-device",
      leaseToken: token,
      leaseRevision: 1,
      result: { scanRunId: fullJob.params.collectionGeneration },
    });
    assert(accepted.publicationId);
    await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
    await publisher.runAnalyticsPublicationUnit({ db, publicationId: accepted.publicationId });
    await assert.rejects(
      () =>
        tx(async (t) => {
          await financial.enter(t);
          await t.$executeRawUnsafe(
            'DELETE FROM "FinancialObservedFact" WHERE "runId"=$1 AND "externalId"=$2',
            receipt.row.id,
            "full-two"
          );
          await require(root+"/src/services/earnings-generation-service").preparePage(t, fullJob, receipt.row);
        }),
      /EARNINGS_GENERATION_PROOF_MISMATCH/
    );
    assert.equal(await db.creatorEarningsLedgerProof.count({ where: { creatorId: fsScope.creatorId } }), 0);
    assert.notEqual(
      (await db.creatorFinancialCollectionState.findUnique({ where: { creatorId: fsScope.creatorId } })).status,
      "COMPLETE"
    );
    let completed;
    for (let step=0;step<20;step++) {
      await db.analyticsPublication.update({ where: { id: accepted.publicationId }, data: { availableAt: new Date(0) } });
      completed = await publisher.runAnalyticsPublicationUnit({ db, publicationId: accepted.publicationId });
      if (completed.sideEffect) break;
    }
    assert(completed.sideEffect.complete);
    assert.equal((await db.jobInstance.findUnique({ where: { id: fullJob.id } })).status, "DONE");
    const fsHome = await home.readHomeTotals({ ...homeInput, ...fsScope, member: fsMember, now: later });
    assert.equal(fsHome.totalCents, 800);
    assert.equal((await require(root+"/src/services/earnings-generation-service").activeEntry(db,fsScope.creatorId,"full-one")).status,"undo");
    pass(
      "verified full publication is atomic; missing receipt rows roll back completion; newer WS refund survives old scan; creator scopes isolated"
    );
    const campaignRead = require(root + "/src/services/campaign-read-repository");
    const campaignProjection = require(root + "/src/services/campaign-read-projection-service");
    const fan42 = await db.creatorFan.findUnique({
      where: { creatorId_onlyFansUserId: { creatorId: fsScope.creatorId, onlyFansUserId: "42" } },
    });
    assert(fan42);
    await tx(async (t) => {
      await require(root + "/src/services/campaign-causal-activation-service").enterCampaignWriterGeneration({ db: t });
      await t.creatorCampaign.create({
        data: {
          id: "live-campaign",
          ...{ agencyId: fsScope.agencyId, creatorId: fsScope.creatorId },
          externalCampaignId: "known-source-campaign",
          name: "Known membership",
        },
      });
      await t.creatorCampaignFan.create({
        data: {
          id: "live-membership",
          agencyId: fsScope.agencyId,
          creatorId: fsScope.creatorId,
          campaignId: "live-campaign",
          fanRecordId: fan42.id,
          attributedAt: new Date(+happened - 86400000),
        },
      });
      await require(root + "/scripts/test-support/campaign-read-coverage-fixture.cjs").seedCoverage(t, fsScope, {
        kind: "CAMPAIGNS",
        now: new Date(),
      });
    });
    async function campaignTotals() {
      for (let i = 0; i < 100; i++) {
        assert.equal((await campaignProjection.runCampaignProjectionSweep({ db })).ok, true);
        if ((await campaignRead.readiness(db, fsScope.creatorId, new Date())).ready)
          return (
            await campaignRead.readCampaignPage({ db, creatorId: fsScope.creatorId, rangeKey: "all", now: new Date() })
          ).totals;
      }
      throw Error("Campaign projection did not drain");
    }
    assert.equal((await campaignTotals()).netCents, 800);
    const liveNew = structuredClone(live);
    liveNew.notificationObservation.identityKey = "new-live-campaign-payment";
    liveNew.moneyObservation.transactionId = "live-campaign-payment";
    liveNew.moneyObservation.status = "done";
    await tx((t) =>
      money.ingestLive({
        db: t,
        ...fsScope,
        deviceId: null,
        events: [liveNew],
        capturedAt: new Date(),
        now: new Date(),
      })
    );
    assert.equal((await campaignTotals()).netCents, 1600);
    pass("verified known campaign membership receives exact live transaction NET without any message database");
    const coverageApi = require(root + "/src/services/earnings-live-read-sql");
    const futureDay = new Date(+today + 86400000),
      liveNow = new Date(+futureDay + 3600000);
    await tx((t) =>
      t.$executeRawUnsafe(
        `INSERT INTO "CreatorLiveSync"("creatorId","agencyId","lastDeliveredAt") VALUES($1,$2,$3) ON CONFLICT("creatorId") DO UPDATE SET "lastDeliveredAt"=$3`,
        fsScope.creatorId,
        fsScope.agencyId,
        liveNow
      )
    );
    const liveCoverage = await coverageApi.readLiveEarningsCoverage(db, fsScope.creatorId, liveNow);
    const financialState = await db.creatorFinancialCollectionState.findUnique({
      where: { creatorId: fsScope.creatorId },
    });
    const campaignCoverage = require(root + "/src/services/campaign-revenue-coverage").campaignRevenueCoverage(
      { ...financialState, liveCoverage },
      { proven: true, providerFresh: true },
      { startAt: futureDay },
      liveNow
    );
    assert.equal(campaignCoverage.ready, true);
    assert.equal(campaignCoverage.fresh, true);
    await tx((t) =>
      t.$executeRawUnsafe(
        `UPDATE "CreatorLiveSync" SET "shortGapFrom"=$2,"shortGapTo"=$3 WHERE "creatorId"=$1`,
        fsScope.creatorId,
        start,
        liveNow
      )
    );
    const withGap = await coverageApi.readLiveEarningsCoverage(db, fsScope.creatorId, liveNow);
    assert.equal(withGap.fresh, false);
    assert(+withGap.throughAt < +futureDay);
    pass(
      "campaign revenue accepts the same live financial coverage across UTC rollover; an uncovered short gap never claims fresh money"
    );
    // Large publication/read/concurrency measurements live in bounded-live-proof.cjs.
    const result = { ok: true, engine: "PGlite with real Prisma; not native PostgreSQL concurrency", checks };
    if (process.env.ONLINOD_REALTIME_PROOF_REPORT)
      require("node:fs").writeFileSync(process.env.ONLINOD_REALTIME_PROOF_REPORT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: true, checks: checks.length }));
  } finally {
    await f.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
