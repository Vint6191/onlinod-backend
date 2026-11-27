"use strict";
// The monetary assertions below run only after SQL-triggered DomainWork has
// been consumed by the real bounded reconciliation and rollup sweep handlers.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const root = path.resolve(__dirname, "../.."), checks = [];
const pass = message => { checks.push(message); console.log("PASS", message); };

(async () => {
  const runtime = await createScaleSqlRuntime(), { db } = runtime;
  require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
  const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
  const financial = require(root + "/src/services/financial-transactions-service");
  const notifications = require(root + "/src/services/notification-facts-service");
  const scheduler = require(root + "/src/services/job-scheduler");
  const ppv = require(root + "/src/services/team-ppv-ledger-service"), tips = require(root + "/src/services/team-tip-ledger-service");
  const token = "finance209-" + crypto.randomBytes(5).toString("hex");
  let sweeps = 0;
  try {
    const { agency, member, user } = await db.$transaction(async tx => {
      await require(root + "/src/services/database-write-contract-service").assertTeamControlPlaneWriteAdmission(tx);
      const agency = await tx.agency.create({ data: { name: token } });
      const user = await tx.user.create({ data: { email: token + "@example.test", passwordHash: "isolated-fixture" } });
      const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: "OWNER", roleKey: "owner" } });
      return { agency, member, user };
    });
    async function drain() {
      for (let page = 0; page < 300; page++) {
        const pending = await db.domainWorkItem.count({ where: { agencyId: agency.id, workClass: { in: ["TEAM_MONEY_RECONCILIATION", "TEAM_READ_SUMMARY"] }, isOutstanding: true } });
        if (!pending) return;
        const a = await scheduler.runTeamMoneyReconciliationSweep({ db });
        const b = await scheduler.runTeamReadSummarySweep({ db }); sweeps++;
        if (!a.ok || !b.ok) {
          const failures = await db.domainWorkItem.findMany({ where: { agencyId: agency.id, workClass: { in: ["TEAM_MONEY_RECONCILIATION", "TEAM_READ_SUMMARY"] }, isOutstanding: true } });
          assert.fail(JSON.stringify({ a, b, failures }, (_, value) => typeof value === "bigint" ? value.toString() : value));
        }
      }
      assert.fail("Team owners did not drain their durable queue");
    }
    async function fixture(name, kind = "SALE") {
      const creator = await db.$transaction(async tx => {
        await require(root + "/src/services/database-write-contract-service").authorizeCreatorAccountWrite(tx);
        return tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: name, status: "READY" } });
      });
      const occurredAt = new Date(Date.now() - 120000), observationStart = Date.now() - 30000;
      let revision = 0, sequence = 0;
      await db.teamSentMessageLedger.create({ data: { agencyId: agency.id, creatorId: creator.id, accountId: creator.id,
        messageId: "message", localSeed: creator.id, fanId: "fan", dialogId: "fan", memberId: member.id, userId: user.id,
        source: "manual_chat", sentAt: new Date(+occurredAt - 10000) } });
      const model = kind === "SALE" ? "creatorSale" : "creatorTip";
      async function payout(patch = {}, channel = "live") {
        const observedAt = new Date(observationStart + (++revision) * 100);
        const money = { transactionId: "transaction", transactionType: kind === "SALE" ? "message" : "tip",
          amountCents: 1000, netCents: 800, fanOnlyFansUserId: "fan", currency: "USD", occurredAt, status: "done", ...patch };
        return runRootCommit(db, async ({ tx }) => {
          if (channel === "live") return financial.ingestExactLiveTransaction({ db: tx, agencyId: agency.id, creatorId: creator.id,
            deviceId: null, observedAt, now: new Date(), money });
          const job = { agencyId: agency.id, creatorId: creator.id, id: null, params: { collectionContractVersion: 1,
            collectionType: "FINANCIAL", collectionMode: "catchup", collectionGeneration: token + name + revision,
            collectionRequestedAt: observedAt.toISOString(), analyticsObservationStartedAt: observedAt.toISOString() } };
          return financial.publishVerifiedFinancialFactsPage({ db: tx, job, facts: [{ value: { ...money,
            externalTransactionId: money.transactionId, transactionStatus: money.status } }], now: new Date() });
        });
      }
      async function notification({ id = "notification", exact = false, type = kind, ...patch } = {}) {
        const scanRunId = token + creator.id + (++sequence), notificationType = type === "SALE" ? "purchases" : "tips";
        const response = await notifications.ingestNotificationFacts({ db, deviceId: null,
          job: { id: scanRunId + "job", sourceJobId: null, agencyId: agency.id, creatorId: creator.id,
            params: { from: new Date(+occurredAt - 1000).toISOString(), to: new Date().toISOString(), types: [notificationType] } },
          result: { schemaVersion: notifications.SCHEMA_VERSION, collectorVersion: notifications.COLLECTOR_VERSION,
            scanRunId, sourceTimezone: "UTC", notificationType, batchKey: `run:${scanRunId}:page:${notificationType}:1`, finalizeCoverage: false,
            events: [{ type: type === "SALE" ? "purchase" : "tip", notificationId: id, transactionId: exact ? "transaction" : null,
              fanId: "fan", messageId: "message", amountCents: 1000, currency: "USD", occurredAt: occurredAt.toISOString(), ...patch }] } });
        assert.equal(response.rejected, 0, JSON.stringify(response)); return response;
      }
      async function state() {
        const facts = await db.teamMoneyAttributionFact.findMany({ where: { creatorId: creator.id } });
        const rollups = await db.teamMoneyLifetimeRollup.findMany({ where: { creatorId: creator.id } });
        return { canonical: await db[model].findMany({ where: { creatorId: creator.id } }), facts,
          roots: await db[kind === "SALE" ? "teamPpvPurchaseLedger" : "teamTipLedger"].findMany({ where: { creatorId: creator.id } }),
          active: facts.filter(row => row.attributionActive && row.classificationState === "CANONICAL").length,
          money: rollups.reduce((sum, row) => sum + Number(row.amountCents), 0) };
      }
      return { creator, occurredAt, model, payout, notification, state };
    }

    for (const kind of ["SALE", "TIP"]) for (const order of ["notification-first", "payout-first", "concurrent"]) {
      const f = await fixture(kind + order, kind);
      if (order === "notification-first") { await f.notification(); await drain(); await f.payout(); }
      else if (order === "payout-first") { await f.payout(); await drain(); await f.notification(); }
      else await Promise.all([f.payout(), f.notification()]);
      await drain(); const before = await f.state();
      assert.equal(before.canonical.length, 1); assert.equal(before.active, 1); assert.equal(before.money, 1000);
      const sourceId = before.canonical[0].id, rootId = before.roots[0].id;
      await f.payout({ status: "undo" }, "scan"); await f.notification(); await drain();
      let current = await f.state(); assert.equal(current.active, 0); assert.equal(current.money, 0); assert.equal(current.canonical[0].transactionStatus, "undo");
      await f.payout(); await f.notification(); await drain(); current = await f.state();
      assert.equal(current.canonical.length, 1); assert.equal(current.canonical[0].id, sourceId); assert.equal(current.roots[0].id, rootId);
      assert.equal(current.active, 1); assert.equal(current.money, 1000);
      pass(`${kind} ${order}: one identity; scan undo plus late replay withdraws money; newer done restores the same root`);
    }

    for (const target of ["post", "stream"]) {
      const f = await fixture("message-" + target); await f.notification({ exact: true }); await f.payout(); await drain();
      const before = await f.state();
      await f.payout({ transactionType: target }, "scan"); await drain(); let current = await f.state();
      assert.equal(current.canonical[0].saleType, target.toUpperCase()); assert.equal(current.canonical[0].messageId, null);
      assert.equal(current.active, 0); assert.equal(current.money, 0); assert.equal(current.roots[0].financialStatus, "superseded");
      await f.notification({ exact: true }); await drain(); assert.equal((await f.state()).money, 0, "old notification cannot revert payout classification");
      await f.payout(); await f.notification({ exact: true }); await drain(); current = await f.state();
      assert.equal(current.canonical[0].id, before.canonical[0].id); assert.equal(current.roots[0].id, before.roots[0].id);
      assert.equal(current.money, 1000); assert.equal(current.active, 1);
      pass(`MESSAGE→${target.toUpperCase()}→MESSAGE: valid targets, retired PPV, replay fenced, exact ownership restored through queue`);
    }

    for (const kind of ["SALE", "TIP"]) {
      const f = await fixture("cross-kind-" + kind, kind); await f.notification({ exact: true }); await f.payout(); await drain();
      const before = await f.state(), other = kind === "SALE" ? "TIP" : "SALE";
      await f.payout({ transactionType: other === "SALE" ? "message" : "tip" }); await drain();
      assert.equal((await f.state()).money, 0);
      await f.notification({ type: other, id: "other-kind-notification", exact: true }); await drain();
      assert.equal((await f.state()).money, 1000); assert.equal((await f.state()).active, 1);
      await f.payout(); await f.notification({ exact: true }); await drain();
      const after = await f.state(); assert.equal(after.money, 1000); assert.equal(after.active, 1);
      assert.equal(after.roots.find(row => row.id === before.roots[0].id).financialStatus, "done");
      pass(`${kind}→${other}→${kind}: only current classification contributes; original root and identity survive`);
    }

    for (const kind of ["SALE", "TIP"]) {
      const f = await fixture("late-competitor-" + kind, kind); await f.notification(); await f.payout(); await drain();
      const original = await f.state();
      await f.payout({ transactionId: "competing-transaction" });
      const oldWork = await db.domainWorkItem.findFirst({ where: { agencyId: agency.id, objectId: original.canonical[0].id, workClass: "TEAM_MONEY_RECONCILIATION" } });
      assert.equal(oldWork.isOutstanding, true, "correlation-only update must wake the existing root");
      await drain(); const current = await f.state(); assert.equal(current.money, 0); assert.equal(current.active, 0);
      assert.equal(current.roots.find(row => row.id === original.roots[0].id).status, "conflict");
      await f.notification({ exact: true }); await drain(); assert.equal((await f.state()).money, 1000);
      pass(`${kind}: a late competing payout wakes the old root via SQL trigger; ambiguity retracts money; exact source identity restores it`);
    }

    // Upgrade fixture: two retained canonical rows from the older ingress order,
    // with a real manually resolved notification root. No identity is merged.
    for (const kind of ["SALE", "TIP"]) {
      const f = await fixture("legacy-separate-" + kind, kind); await f.payout(); await drain();
      const canonical = (await f.state()).canonical[0];
      const note = await db[f.model].create({ data: { agencyId: agency.id, creatorId: f.creator.id, fanRecordId: canonical.fanRecordId,
        fanOnlyFansUserIdAtEvent: "fan", externalNotificationId: "legacy-notification", eventFingerprint: crypto.randomBytes(32).toString("hex"),
        messageId: "message", amountCents: 1000, currency: "USD", source: "NOTIFICATION",
        ...(kind === "SALE" ? { saleType: "MESSAGE", purchasedAt: f.occurredAt } : { tippedAt: f.occurredAt }) } });
      await drain(); const prior = await f.state();
      const noteRoot = prior.roots.find(row => row[kind === "SALE" ? "creatorSaleId" : "creatorTipId"] === note.id);
      if (kind === "SALE") {
        const job = await db.teamPpvResolveJob.findFirst({ where: { creatorId: f.creator.id, purchaseId: noteRoot.purchaseId } });
        assert.equal((await ppv.resolvePpvConflict({ db, agencyId: agency.id, actorMember: member, actorMemberId: member.id,
          jobId: job.id, action: "assign", memberId: member.id, reason: "retained manager decision", allowedCreatorIds: [f.creator.id] })).resolved, 1);
      } else assert.equal((await tips.applyTipOverride({ db, agencyId: agency.id, actorMember: member, byMemberId: member.id, byUserId: user.id,
        eventHash: noteRoot.eventHash, action: "manager_override", targetMemberId: member.id, reason: "retained manager decision", allowedCreatorIds: [f.creator.id] })).ok, true);
      const savedNoteRoot = await db[kind === "SALE" ? "teamPpvPurchaseLedger" : "teamTipLedger"].findUnique({ where: { id: noteRoot.id } });
      await runRootCommit(db, async ({ tx }) => tx.maintenanceLaneState.upsert({ where: { key: "financial_correlation_adoption209" },
        create: { key: "financial_correlation_adoption209", generation: "financial_correlation_adoption209", activeGeneration: "financial_correlation_adoption209",
          cursor: { phase: kind, afterId: "", upperSaleId: note.id, upperTipId: note.id } },
        update: { completedAt: null, cursor: { phase: kind, afterId: "", upperSaleId: note.id, upperTipId: note.id } } }));
      for (let page = 0; page < 100; page++) {
        const result = await require(root + "/src/services/team-purchase-identity-service").adoptPage(db);
        if (result.complete) break; assert(page < 99);
      }
      await drain(); let current = await f.state();
      assert.equal(current.canonical.length, 2); assert.equal(current.money, 0); assert.equal(current.active, 0);
      const preserved = current.roots.find(row => row.id === noteRoot.id);
      assert.equal(preserved.attributedMemberId, savedNoteRoot.attributedMemberId); assert.equal(preserved.resolvedSource, savedNoteRoot.resolvedSource);
      assert.equal(preserved.financialStatus, "unverified");
      const payoutRoot = current.roots.find(row => row[kind === "SALE" ? "creatorSaleId" : "creatorTipId"] === canonical.id);
      assert.equal(payoutRoot.status, "conflict");
      if (kind === "SALE") {
        const page = await ppv.listPpvConflictPage({ db, agencyId: agency.id, allowedCreatorIds: [f.creator.id], creatorId: f.creator.id, state: "needs_review", limit: 20 });
        const claim = page.conflicts.find(row => row.purchaseId === payoutRoot.purchaseId); assert(claim); assert.equal(claim.reviewLane, "financial_identity_ambiguity");
        assert.equal(claim.messageId, null, "candidate message must not be presented as an exact source target");
        assert.equal((await ppv.resolvePpvConflict({ db, agencyId: agency.id, actorMember: member, actorMemberId: member.id, jobId: claim.jobId,
          action: "assign", memberId: member.id, reason: "verified distinct payout identity", allowedCreatorIds: [f.creator.id] })).resolved, 1);
      } else {
        const claims = await tips.listTipClaims({ agencyId: agency.id, actorMemberId: member.id, senior: true, includeMigrationReview: true, allowedCreatorIds: [f.creator.id] });
        assert(claims.find(row => row.eventHash === payoutRoot.eventHash && row.reviewLane === "financial_identity_ambiguity"));
        assert.equal((await tips.applyTipOverride({ db, agencyId: agency.id, actorMember: member, byMemberId: member.id, byUserId: user.id,
          eventHash: payoutRoot.eventHash, action: "manager_override", targetMemberId: member.id, reason: "verified distinct payout identity", allowedCreatorIds: [f.creator.id] })).ok, true);
      }
      await drain(); assert.equal((await f.state()).money, 1000);
      await f.payout({ status: "undo" }); await drain(); assert.equal((await f.state()).money, 0);
      await f.payout(); await drain(); current = await f.state(); assert.equal(current.money, 1000); assert.equal(current.active, 1);
      assert.equal(current.roots.find(row => row.id === payoutRoot.id).attributedMemberId, member.id);
      pass(`${kind} upgrade: bounded repair preserves both identities/manual evidence; visible authorized review resolves payout; undo/done stays single`);
    }
    const report = { ok: true, engine: runtime.native ? "native PostgreSQL" : "PGlite", checks, boundedSweepTurns: sweeps };
    if (process.env.FINANCE209_REPORT) fs.writeFileSync(process.env.FINANCE209_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
