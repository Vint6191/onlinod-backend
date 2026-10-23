"use strict";

// Isolated SQL only. Native CI uses a second connection for row contention;
// PGlite validates real triggers/queries but is not a concurrency certificate.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");

(async () => {
  const runtime = await createScaleSqlRuntime();
  const { db } = runtime;
  if (runtime.url) { process.env.DATABASE_URL = runtime.url; process.env.DIRECT_URL = runtime.url; }
  const { runTeamLedgerRetentionPage: page, PAGE_LIMIT } = require("../../src/services/team-ledger-retention-service");
  const { runRootCommit } = require("../../src/services/db-commit-kernel");
  const retention = require("../../src/services/retention-service");
  const { withRetentionWork } = require("../../src/services/retention-work-context-service");
  const checks = [], metrics = {}, skipped = [];
  const pass = value => { checks.push(value); console.log("PASS", value); };
  const now = new Date(), old = new Date(+now - 200 * 86400000), cutoff = new Date(+now - 180 * 86400000);
  const input = { db, now, cutoff, limit: 500 };
  const tx = work => runRootCommit(db, ({ tx }) => work(tx));
  try {
    const s = await scope(db);
    const seed = async (prefix, count, at = old) => tx(async t => {
      await t.$executeRawUnsafe(`INSERT INTO "TeamTipLedger"(id,"agencyId","creatorId","eventHash","tipId","receivedAt","amountCents",candidates,"weakCandidates",result,history,"updatedAt")
        SELECT $1||'-tip-'||i,$2,$3,$1||'-hash-'||i,$1||'-external-tip-'||i,$4,1000,
          '[{"memberId":"historical"}]'::jsonb,'[]'::jsonb,'{"old":true}'::jsonb,'[{"action":"manual-decision"}]'::jsonb,$4
        FROM generate_series(1,$5::int) i`, prefix, s.agencyId, s.creatorId, at, count);
      await t.$executeRawUnsafe(`INSERT INTO "TeamPpvPurchaseLedger"(id,"agencyId","creatorId","purchaseId","purchasedAt","amountCents","updatedAt")
        SELECT $1||'-ppv-'||i,$2,$3,$1||'-external-ppv-'||i,$4,2000,$4 FROM generate_series(1,$5::int) i`, prefix, s.agencyId, s.creatorId, at, count);
    });
    const facts = () => db.teamMoneyAttributionFact.findMany({ orderBy: { id: "asc" } });
    const summaryWork = () => db.$queryRawUnsafe(`SELECT id,"requestedRevision"::text AS revision FROM "DomainWorkItem" WHERE "workClass"='TEAM_READ_SUMMARY' ORDER BY id`);
    const contract = await require("../../src/services/database-contract-service").readDatabaseContract(db);
    assert.equal(contract.ready, true, JSON.stringify(contract));
    pass("V8 catalog, function identities and previous migration receipts are intact");

    await seed("original", 24);
    const originalFacts = await facts(), originalWork = await summaryWork();
    const start = performance.now();
    const tips = await page({ ...input, kind: "tips" });
    const purchases = await page({ ...input, kind: "purchases" });
    assert.equal(tips.compacted + purchases.compacted, 48);
    assert.deepEqual(await facts(), originalFacts);
    assert.deepEqual(await summaryWork(), originalWork);
    const kept = await db.teamTipLedger.findUnique({ where: { id: "original-tip-1" } });
    assert.deepEqual(kept.history, [{ action: "manual-decision" }]);
    assert.equal(kept.amountCents, 1000); assert(kept.compactedAt); assert.equal(+kept.updatedAt, +old);
    assert.equal(kept.candidates, null); assert.equal(kept.weakCandidates, null); assert.equal(kept.result, null);
    metrics.compaction48 = { elapsedMs: Math.round(performance.now() - start), factsRewritten: 0, summaryJobsRevised: 0 };
    pass("48 compacted roots preserve exact monetary facts, manual history and timestamps; zero summary requeues");
    for (const kind of ["tips", "purchases"]) {
      const repeat = await page({ ...input, kind }); assert.equal(repeat.affected, 0); assert.equal(repeat.hasMore, false);
    }
    assert.deepEqual(await facts(), originalFacts);
    pass("repeated cleanup is empty and does not revisit compacted money");

    await tx(async t => {
      await t.creatorTip.create({ data: { id: "canonical-tip", agencyId: s.agencyId, creatorId: s.creatorId,
        eventFingerprint: "a".repeat(64), amountCents: 1100, tippedAt: old } });
      await t.teamTipLedger.update({ where: { id: "original-tip-1" }, data: { creatorTipId: "canonical-tip", amountCents: 1100,
        status: "attributed", attributedMemberId: "member-" + s.agencyId, attributedUserId: s.userId } });
      await t.teamPpvPurchaseLedger.update({ where: { id: "original-ppv-1" }, data: { amountCents: 2700, status: "resolved",
        attributedMemberId: "member-" + s.agencyId, attributedUserId: s.userId } });
    });
    let tipFact = await db.teamMoneyAttributionFact.findFirst({ where: { sourceRowId: "original-tip-1" } });
    let ppvFact = await db.teamMoneyAttributionFact.findFirst({ where: { sourceRowId: "original-ppv-1" } });
    assert.equal(tipFact.amountCents, 1100); assert.equal(tipFact.classificationState, "CANONICAL"); assert.equal(tipFact.attributionActive, true);
    assert.equal(ppvFact.amountCents, 2700); assert.equal(ppvFact.memberId, "member-" + s.agencyId);
    await tx(async t => {
      await t.creatorTip.update({ where: { id: "canonical-tip" }, data: { transactionStatus: "undo" } });
      await t.teamTipLedger.update({ where: { id: "original-tip-1" }, data: { financialStatus: "undo" } });
    });
    tipFact = await db.teamMoneyAttributionFact.findFirst({ where: { sourceRowId: "original-tip-1" } });
    assert.equal(tipFact.attributionActive, false); assert.equal(tipFact.financialStatus, "undo");
    assert.notDeepEqual(await summaryWork(), originalWork);
    pass("post-compaction amount, attribution, canonical identity and refund corrections still project and enqueue");

    await seed("combined", 1);
    await tx(t => t.teamTipLedger.update({ where: { id: "combined-tip-1" }, data: {
      compactedAt: now, candidates: null, weakCandidates: null, result: null, amountCents: 3333,
    } }));
    assert.equal((await db.teamMoneyAttributionFact.findFirst({ where: { sourceRowId: "combined-tip-1" } })).amountCents, 3333);
    await tx(t => t.teamMoneyAttributionFact.deleteMany({ where: { sourceRowId: "combined-ppv-1" } }));
    assert.equal((await page({ ...input, kind: "purchases" })).compacted, 1);
    assert(await db.teamMoneyAttributionFact.findFirst({ where: { sourceRowId: "combined-ppv-1" } }));
    pass("combined monetary changes cannot use the compaction fast path; missing historical facts are rebuilt");

    await seed("pages", 601); await seed("recent", 1, now);
    const savedFacts = await facts(), savedWork = await summaryWork();
    const dry = await page({ ...input, kind: "tips", dryRun: true, limit: 20000 });
    assert.equal(dry.matched, PAGE_LIMIT); assert.equal(dry.affected, 0); assert.equal(dry.hasMore, true);
    for (const kind of ["tips", "purchases"]) {
      const first = await page({ ...input, kind, limit: 20000 });
      const second = await page({ ...input, kind, limit: 20000 });
      const third = await page({ ...input, kind });
      assert.equal(first.affected, 500); assert.equal(first.hasMore, true);
      assert.equal(second.affected, 101); assert.equal(second.hasMore, false); assert.equal(third.affected, 0);
    }
    assert.deepEqual(await facts(), savedFacts); assert.deepEqual(await summaryWork(), savedWork);
    assert.equal((await db.teamTipLedger.findUnique({ where: { id: "recent-tip-1" } })).compactedAt, null);
    pass("601 roots per ledger drain as 500 + 101; dry run, retention cutoff and all monetary facts survive");

    await tx(async t => {
      await t.teamSentMessageLedger.create({ data: { id: "sent-root", agencyId: s.agencyId, creatorId: s.creatorId,
        localSeed: "sent-seed", messageId: "provider-message", memberId: "member-" + s.agencyId,
        sentAt: old, mediaIds: ["media-1"], isPpv: true, priceCents: 2500 } });
      for (const [id, status, createdAt, expiresAt] of [
        ["pending-expired", "pending", old, old], ["terminal-old", "resolved", old, null],
        ["terminal-expired", "rejected", now, old], ["pending-live", "pending", old, new Date(+now + 60000)],
        ["terminal-recent", "resolved", now, new Date(+now + 60000)],
      ]) await t.teamPpvResolveJob.create({ data: { id, agencyId: s.agencyId, creatorId: s.creatorId,
        purchaseId: id, messageId: id, status, createdAt, expiresAt } });
    });
    const sentBefore = await db.teamSentMessageLedger.findUnique({ where: { id: "sent-root" } });
    assert.equal((await page({ ...input, kind: "sent" })).compacted, 1);
    const sentAfter = await db.teamSentMessageLedger.findUnique({ where: { id: "sent-root" } });
    assert.deepEqual({ ...sentAfter, compactedAt: null, mediaIds: sentBefore.mediaIds }, sentBefore);
    assert.equal(sentAfter.mediaIds, null);
    assert.equal((await page({ ...input, kind: "expireJobs", cutoff: now })).expired, 1);
    assert.equal((await page({ ...input, kind: "expiredJobs", cutoff: now })).deleted, 2);
    assert.equal((await page({ ...input, kind: "oldJobs" })).deleted, 1);
    const remainingJobs = await db.teamPpvResolveJob.findMany({ orderBy: { id: "asc" }, select: { id: true } });
    assert.deepEqual(remainingJobs.map(row => row.id), ["pending-live", "terminal-recent"]);
    pass("sent-message ownership survives compaction; terminal jobs drain once while live pending and recent jobs remain");

    for (const [table, time, index, status] of [
      ["TeamTipLedger", "receivedAt", "TeamTipLedger_retention_compact_v8_idx", ""],
      ["TeamPpvPurchaseLedger", "purchasedAt", "TeamPpvPurchaseLedger_retention_compact_v8_idx",
        "AND status IN ('resolved','expired','attributed','unresolved','rejected','creator_revenue')"],
    ]) {
      await db.$executeRawUnsafe(`ANALYZE "${table}"`);
      const plan = await db.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) SELECT id FROM "${table}"
        WHERE "${time}" < $1 AND "compactedAt" IS NULL AND "historicalFactVersion"='team_money_fact_v2'
          AND "historicalFactProjectedAt" IS NOT NULL ${status} ORDER BY "${time}",id LIMIT 500`, cutoff);
      assert(JSON.stringify(plan).includes(index), JSON.stringify(plan));
    }
    pass("after draining history, both monetary selectors use their partial retention indexes");

    await seed("rollback", 2);
    await db.$executeRawUnsafe(`CREATE FUNCTION retention_proof_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='57014',MESSAGE='injected page failure'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER retention_proof_fail BEFORE UPDATE ON "TeamPpvPurchaseLedger"
      FOR EACH ROW WHEN (OLD."compactedAt" IS NULL AND NEW."compactedAt" IS NOT NULL) EXECUTE FUNCTION retention_proof_fail()`);
    const partial = await retention.runTeamLedgerRetentionSweep({ db, now, policySettings: { teamMoneyRawDetailDays: 180, batchSize: 500 } });
    assert.equal(partial.ok, false); assert.equal(partial.hasMore, true); assert.equal(partial.totalCompacted, 2);
    assert.equal(partial.errors.length, 1); assert.equal(partial.errors[0].page, "purchases");
    assert.equal((await db.teamPpvPurchaseLedger.findUnique({ where: { id: "rollback-ppv-1" } })).compactedAt, null);
    assert((await db.teamTipLedger.findUnique({ where: { id: "rollback-tip-1" } })).compactedAt);
    await db.$executeRawUnsafe('DROP TRIGGER retention_proof_fail ON "TeamPpvPurchaseLedger"');
    await db.$executeRawUnsafe('DROP FUNCTION retention_proof_fail()');
    const resumed = await retention.runTeamLedgerRetentionSweep({ db, now, policySettings: { teamMoneyRawDetailDays: 180, batchSize: 500 } });
    assert.equal(resumed.ok, true); assert.equal(resumed.totalCompacted, 2); assert.equal(resumed.hasMore, false);
    pass("actual SQL page failure rolls back only that page; committed sibling counts survive and retry drains the remainder");

    await seed("owner", 1);
    const owner = await retention.claimRetentionSweepLease({ db });
    await assert.rejects(withRetentionWork("stale-owner", () => page({ ...input, kind: "tips" })), { code: "RETENTION_LEASE_LOST" });
    assert.equal((await db.teamTipLedger.findUnique({ where: { id: "owner-tip-1" } })).compactedAt, null);
    await withRetentionWork(owner.ownerToken, async () => {
      assert.equal((await page({ ...input, kind: "tips" })).compacted, 1);
      assert.equal((await page({ ...input, kind: "purchases" })).compacted, 1);
    });
    assert.equal(await retention.finalizeRetentionSweepLease({ db, ownerToken: owner.ownerToken, outcome: "COMPLETE" }), true);
    pass("stale ownership cannot compact; the current lease commits and finalizes normally");

    if (runtime.native) {
      await seed("busy", 2);
      let unlock, ready;
      const locked = new Promise(resolve => { ready = resolve; });
      const held = db.$transaction(async t => {
        await t.$queryRawUnsafe('SELECT id FROM "TeamTipLedger" WHERE id=$1 FOR UPDATE', "busy-tip-1");
        ready(); await new Promise(resolve => { unlock = resolve; });
      }, { timeout: 15000 });
      await locked;
      try {
        const busy = await page({ ...input, kind: "tips" });
        assert.equal(busy.matched, 2); assert.equal(busy.compacted, 1); assert.equal(busy.skippedBusy, 1); assert.equal(busy.hasMore, true);
      } finally { unlock(); await held; }
      const drained = await page({ ...input, kind: "tips" }); assert.equal(drained.compacted, 1); assert.equal(drained.hasMore, false);
      pass("native competing row lock is skipped; remaining work stays visible and drains after release");
    } else skipped.push("native competing row lock: PGlite has one connection");

    const report = { ok: true, nativePostgres: Boolean(runtime.native), checks, skipped, metrics };
    if (process.env.ONLINOD_RETENTION_REPORT) fs.writeFileSync(process.env.ONLINOD_RETENTION_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await require("../../src/prisma").$disconnect(); await db.$disconnect();
    await new Promise(resolve => setTimeout(resolve, 50)); await runtime.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
