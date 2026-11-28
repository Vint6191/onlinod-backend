"use strict";
// Disposable native PostgreSQL proof. Seed deliberately unsupported historical
// evidence before the USD migration, then use current production write owners.
// Provider/actor identities are fixtures; SQL triggers, transactions, replay,
// financial admission, recovery, claim authority and rollups are real.
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto");
const { createRequire } = require("node:module");

function services(db, backendRoot) {
  const load = createRequire(path.join(backendRoot, "package.json")), prismaPath = load.resolve("./src/prisma");
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: db };
  return { load, commit: work => load("./src/services/db-commit-kernel").runRootCommit(db, ({ tx }) => work(tx)),
    scope: load("./scripts/audit/analytics-traffic/fixture.cjs").scope };
}
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

async function seedUsdWriteLegacyProof({ db, backendRoot = path.resolve(__dirname, "../..") }) {
  const { load, commit, scope } = services(db, backendRoot);
  const now = new Date((await db.$queryRawUnsafe("SELECT clock_timestamp() AS now"))[0].now);
  const at = new Date(+now - 3600000), day = new Date(at.toISOString().slice(0, 10)), cases = [];
  for (const [label, currency, sourceCurrency, verified] of [["foreign", "EUR", "EUR", true], ["relabeled", "USD", "EUR", true], ["unverified", "GBP", null, false]]) {
    const prefix = `usd215-${label}`, s = await scope(db, { agencyId: `${prefix}-agency`, creatorId: `${prefix}-creator`, userId: `${prefix}-user` });
    const memberId = `member-${s.agencyId}`, transactionId = `${prefix}-transaction`, tipId = `${prefix}-tip`, rootId = `${prefix}-root`, fanId = `${prefix}-fan`;
    const history = [{ ts: +at, action: "claim", byMemberId: memberId, byUserId: s.userId, prevOwner: null,
      nextOwner: memberId, reason: "retained accepted manual decision", source: "manual_chatter_claim" }];
    await commit(async tx => {
      await load("./src/services/earnings-generation-service").lock(tx, s.creatorId);
      await load("./src/services/creator-fact-write-authority").lockCreatorFacts(tx, s.agencyId, s.creatorId);
      await tx.creatorFan.create({ data: { id: fanId, agencyId: s.agencyId, creatorId: s.creatorId, onlyFansUserId: "991215" } });
      await tx.creatorFinancialTransaction.create({ data: { id: `${prefix}-financial`, agencyId: s.agencyId, creatorId: s.creatorId,
        externalTransactionId: transactionId, transactionType: "tip", factType: "TIP", projectionStatus: "PROJECTED", fanRecordId: fanId,
        fanOnlyFansUserId: "991215", amountCents: 2500, netCents: 1701, currency, transactionStatus: "done", occurredAt: at, sourceUpdatedAt: at } });
      await tx.creatorTip.create({ data: { id: tipId, agencyId: s.agencyId, creatorId: s.creatorId, fanRecordId: fanId,
        fanOnlyFansUserIdAtEvent: "991215", externalTransactionId: transactionId, eventFingerprint: hash(tipId),
        amountCents: 2500, netCents: 1701, currency, transactionStatus: "done", tippedAt: at, sourceUpdatedAt: at, source: "ONLYFANS_API" } });
      if (verified) await tx.$executeRawUnsafe(`INSERT INTO "CreatorEarningsLedgerEntry"
        ("agencyId","creatorId","transactionId","occurredAt",category,"netCents","grossCents",status,"observedAt","fanOnlyFansUserId","financialFact")
        VALUES($1,$2,$3,$4,'tips',1701,2500,'done',$4,'991215',$5::jsonb)`, s.agencyId, s.creatorId, transactionId, at,
        JSON.stringify({ version: 1, value: { externalTransactionId: transactionId, transactionType: "tip", amountCents: 2500,
          netCents: 1701, currency: sourceCurrency, transactionStatus: "done", occurredAt: at.toISOString(), fanOnlyFansUserId: "991215" } }));
      await tx.teamTipLedger.create({ data: { id: rootId, agencyId: s.agencyId, accountId: s.creatorId, creatorId: s.creatorId,
        eventHash: hash(tipId), tipId: transactionId, creatorTipId: tipId, amountCents: 2500, currency, receivedAt: at,
        status: "claimed", financialStatus: "done", attributionBasis: "MANUAL_OVERRIDE_PRESERVED", attributedMemberId: memberId,
        attributedUserId: s.userId, fanId: "991215", dialogId: "991215", resolvedAt: at, resolvedByMemberId: memberId,
        resolvedSource: "manual_chatter_claim", source: "creator_tip_reconciliation", history,
        result: { manualResolution: { manualResolution: true, action: "claim", memberId, resolvedByMemberId: memberId, resolvedAt: at.toISOString() } } } });
      const fact = await tx.teamMoneyAttributionFact.findFirst({ where: { creatorTipId: tipId } });
      assert(fact?.attributionActive, "predecessor fixture must actually contain the unsupported active contribution");
      const bucket = { agencyId: s.agencyId, creatorId: s.creatorId, creatorKey: s.creatorId, memberId, sourceType: "TIP", currency, amountCents: 2500n };
      await tx.teamMoneyDailyRollup.create({ data: { ...bucket, id: `${prefix}-day`, day, factCount: 1 } });
      await tx.teamMoneyLifetimeRollup.create({ data: { ...bucket, id: `${prefix}-lifetime`, factCount: 1 } });
      await tx.teamMoneyRollupContribution.create({ data: { ...bucket, id: `${prefix}-contribution`, sourceFactId: fact.id,
        factFingerprint: "retained-predecessor-contribution", active: true, day } });
    });
    cases.push({ ...s, label, memberId, transactionId, tipId, rootId, currency, history, financialId: `${prefix}-financial`, fanId });
  }
  return { now: now.toISOString(), at: at.toISOString(), cases };
}

async function runUsdWriteAuthorityProof({ db, legacy, backendRoot = path.resolve(__dirname, "../..") }) {
  const { load, commit, scope } = services(db, backendRoot), checks = [];
  const now = new Date(legacy.now), at = new Date(legacy.at);
  const financial = load("./src/services/financial-transactions-service"), receipts = load("./src/services/financial-receipt-authority");
  const money = load("./src/services/team-money-reconciliation-service"), tips = load("./src/services/team-tip-ledger-service");
  const rollups = load("./src/services/team-money-rollup-authority-service"), live = load("./src/services/live-earnings-projection-service");
  async function check(name, work) {
    const item = { name, ok: false }; checks.push(item);
    try { await work(item); item.ok = true; }
    catch (error) { item.error = { code: error.code || null, message: error.message, actual: error.actual, expected: error.expected, stack: error.stack }; }
    console.log(JSON.stringify({ usdWriteCheck: item }));
  }
  const fact = s => db.teamMoneyAttributionFact.findFirst({ where: { creatorTipId: s.tipId } });
  const buckets = s => db.teamMoneyLifetimeRollup.findMany({ where: { agencyId: s.agencyId }, orderBy: { currency: "asc" } });
  for (const s of legacy.cases) {
    await check(`upgrade quarantines ${s.label} money and withdraws the exact old contribution without erasing manual history`, async out => {
      const row = await db.teamTipLedger.findUnique({ where: { id: s.rootId } }), f = await fact(s), totals = await buckets(s);
      assert.equal(row.currency, s.currency); assert.equal(row.amountCents, 2500); assert.equal(row.attributedMemberId, s.memberId);
      assert.deepEqual(row.history, s.history); assert.equal(row.financialStatus, "unsupported_currency"); assert.equal(f.attributionActive, false);
      assert.equal(f.financialStatus, "unsupported_currency"); assert.equal(totals.reduce((n, row) => n + row.amountCents, 0n), 0n);
      assert.equal(totals.reduce((n, row) => n + row.factCount, 0), 0);
      assert.equal((await db.teamMoneyRollupContribution.findUnique({ where: { sourceFactId: f.id } })).active, false);
      const dto = tips.tipRowForClaims(row); assert.equal(dto.amountCents, null); assert.equal(dto.currency, null);
      out.originalCurrency = row.currency; out.ownerPreserved = row.attributedMemberId; out.moneyVisible = dto.amountCents;
    });
    await check(`reconciliation, automatic recovery and claim replay cannot reactivate ${s.label} unsupported evidence`, async out => {
      const before = await db.creatorFinancialTransaction.findUnique({ where: { id: s.financialId } });
      const repaired = await commit(async tx => { await load("./src/services/earnings-generation-service").lock(tx, s.creatorId);
        return load("./src/services/financial-legacy-repair-service").repairPage({ db: tx, ...s, now }); });
      assert.equal(repaired.unsupportedCurrency, 1);
      const after = await db.creatorFinancialTransaction.findUnique({ where: { id: s.financialId } });
      for (const key of ["currency", "amountCents", "netCents", "transactionStatus", "fanRecordId"]) assert.equal(after[key], before[key], key);
      await money.reconcileCreatorTipToTeam({ db, tipId: s.tipId });
      await money.reconcileCreatorTipToTeam({ db, tipId: s.tipId });
      const f = await fact(s); await rollups.applyTeamMoneyFactToRollups({ db, agencyId: s.agencyId, factId: f.id });
      await rollups.applyTeamMoneyFactToRollups({ db, agencyId: s.agencyId, factId: f.id });
      const actor = await db.agencyMember.findUnique({ where: { id: s.memberId } });
      const result = await tips.applyTipOverride({ db, agencyId: s.agencyId, actorMember: actor, byUserId: s.userId, byMemberId: s.memberId,
        eventHash: hash(s.tipId), action: "claim", allowedCreatorIds: [s.creatorId] });
      assert.equal(result.code, "UNSUPPORTED_CURRENCY");
      const row = await db.teamTipLedger.findUnique({ where: { id: s.rootId } }); assert.deepEqual(row.history, s.history);
      assert.equal(row.attributedMemberId, s.memberId); assert.equal((await fact(s)).attributionActive, false);
      assert.equal((await buckets(s)).reduce((n, row) => n + row.amountCents, 0n), 0n);
      out.claimCode = result.code; out.originalGross = after.amountCents; out.originalNet = after.netCents;
    });
  }
  const corrected = legacy.cases.find(s => s.label === "relabeled");
  async function emitRevision(gross, net, status, tick) {
    return commit(tx => live.ingestLive({ db: tx, ...corrected, deviceId: null, capturedAt: now, now,
      events: [{ eventKey: `usd-correction-${tick}`, moneyObservation: { version: 1, transactionId: corrected.transactionId, transactionType: "tip",
        amountCents: gross, netCents: net, currency: "USD", status, occurredAt: at.toISOString(), revisionAt: new Date(+at + tick).toISOString(), fanOnlyFansUserId: "991215" } }] }));
  }
  await check("explicit verified USD correction restores the retained manual owner with exact GROSS, and replay does not double count", async out => {
    await emitRevision(3107, 2222, "done", 1000); await emitRevision(3107, 2222, "done", 1000);
    await money.reconcileCreatorTipToTeam({ db, tipId: corrected.tipId });
    const f = await fact(corrected); await rollups.applyTeamMoneyFactToRollups({ db, agencyId: corrected.agencyId, factId: f.id });
    await rollups.applyTeamMoneyFactToRollups({ db, agencyId: corrected.agencyId, factId: f.id });
    const root = await db.teamTipLedger.findUnique({ where: { id: corrected.rootId } });
    assert.equal(root.currency, "USD"); assert.equal(root.amountCents, 3107); assert.equal(root.attributedMemberId, corrected.memberId);
    assert.deepEqual(root.history, corrected.history); assert.equal((await fact(corrected)).attributionActive, true);
    const total = await buckets(corrected); assert.equal(total.length, 1); assert.equal(total[0].currency, "USD");
    assert.equal(total[0].amountCents, 3107n); assert.equal(total[0].factCount, 1);
    assert.equal((await db.creatorFinancialTransaction.findUnique({ where: { id: corrected.financialId } })).netCents, 2222);
    out.gross = 3107; out.net = 2222; out.count = 1;
  });
  await check("USD refund, stale correction and later reinstatement preserve audit while applying exact signed deltas", async () => {
    await emitRevision(3107, 2222, "undo", 2000); await money.reconcileCreatorTipToTeam({ db, tipId: corrected.tipId });
    await rollups.applyTeamMoneyFactToRollups({ db, agencyId: corrected.agencyId, factId: (await fact(corrected)).id });
    assert.equal((await buckets(corrected))[0].amountCents, 0n);
    await emitRevision(3107, 2222, "done", 1000); assert.equal((await db.creatorTip.findUnique({ where: { id: corrected.tipId } })).transactionStatus, "undo");
    await emitRevision(3701, 2409, "done", 3000); await money.reconcileCreatorTipToTeam({ db, tipId: corrected.tipId });
    await rollups.applyTeamMoneyFactToRollups({ db, agencyId: corrected.agencyId, factId: (await fact(corrected)).id });
    assert.equal((await buckets(corrected))[0].amountCents, 3701n); assert.equal((await buckets(corrected))[0].factCount, 1);
    assert.deepEqual((await db.teamTipLedger.findUnique({ where: { id: corrected.rootId } })).history, corrected.history);
  });
  const fresh = await scope(db, { agencyId: "usd215-fresh-agency", creatorId: "usd215-fresh-creator", userId: "usd215-fresh-user" });
  const sample = { transactionId: "usd215-exact", transactionType: "tip", amountCents: 2500, netCents: 1701, status: "done", occurredAt: at,
    fanOnlyFansUserId: "991216" };
  await check("foreign exact live input fails before fan, canonical fact or consequence writes; omitted documented USD remains valid", async () => {
    const before = await db.creatorFan.count({ where: { creatorId: fresh.creatorId } });
    await assert.rejects(commit(tx => financial.ingestExactLiveTransaction({ db: tx, ...fresh, money: { ...sample, currency: "EUR" }, observedAt: now, now })), { code: "UNSUPPORTED_CURRENCY" });
    assert.equal(await db.creatorFan.count({ where: { creatorId: fresh.creatorId } }), before);
    assert.equal(await db.creatorFinancialTransaction.count({ where: { creatorId: fresh.creatorId } }), 0);
    await commit(tx => financial.ingestExactLiveTransaction({ db: tx, ...fresh, money: sample, observedAt: now, now }));
    await commit(tx => financial.ingestExactLiveTransaction({ db: tx, ...fresh, money: { ...sample, currency: "USD" }, observedAt: now, now }));
    const rows = await db.creatorFinancialTransaction.findMany({ where: { creatorId: fresh.creatorId } });
    assert.equal(rows.length, 1); assert.equal(rows[0].currency, "USD"); assert.equal(rows[0].amountCents, 2500); assert.equal(rows[0].netCents, 1701);
    assert.equal(await db.creatorTip.count({ where: { creatorId: fresh.creatorId } }), 1);
  });
  await check("contradictory notification and exact money currencies cannot publish a second financial fact", async () => {
    const result = await commit(tx => live.ingestLive({ db: tx, ...fresh, deviceId: null, capturedAt: now, now,
      events: [{ eventKey: "contradictory-currency", notificationObservation: { category: "tips", currency: "EUR", amountCents: 2500, occurredAt: at.toISOString() },
        moneyObservation: { ...sample, version: 1, transactionId: "contradictory-money", currency: "USD", occurredAt: at.toISOString() } }] }));
    assert.equal(result.applied, 0); assert.equal(await db.creatorFinancialTransaction.count({ where: { creatorId: fresh.creatorId } }), 1);
    const observation = await db.creatorMoneyObservation.findFirst({ where: { creatorId: fresh.creatorId, transactionId: "contradictory-money" } });
    assert.equal(observation.reason, "MONEY_CURRENCY_UNSUPPORTED"); assert(observation.resolutionBlockedAt);
  });
  async function financialJob(label) {
    const s = await scope(db, { agencyId: `usd215-${label}-agency`, creatorId: `usd215-${label}-creator`, userId: `usd215-${label}-user` });
    const generation = `usd215-${label}-generation`, params = { collectionContractVersion: 1, collectionType: "FINANCIAL", collectionMode: "full",
      collectionGeneration: generation, collectionRequestedAt: now.toISOString(), endDate: now.toISOString(), financialReceiptVersion: 1,
      financialTraversalVersion: 2, financialWindowGeneration: generation };
    params.financialWindows = receipts.planWindows(params, null);
    const job = await commit(async tx => { await receipts.enter(tx);
      return tx.jobInstance.create({ data: { id: `usd215-${label}-job`, agencyId: s.agencyId, creatorId: s.creatorId,
        jobKey: "financial_transactions_scan", scope: "creator", status: "CLAIMED", params, startedAt: now } }); });
    return { s, job };
  }
  const scan = await financialJob("scan"), validRows = [undefined, "USD"].map((currency, index) => ({ externalTransactionId: `usd-page-${index}`,
    transactionType: "tip", amountCents: 2500, netCents: 1701, currency, transactionStatus: "done", occurredAt: at.toISOString(), fanOnlyFansUserId: `99221${index}` }));
  const page = { scanRunId: scan.job.params.collectionGeneration, collectorVersion: receipts.COLLECTOR, windowIndex: 0, pageNumber: 1,
    markerStart: scan.job.params.financialWindows[0].initialMarker, markerEnd: null, rawReceived: 3, scannerRejected: 0, duplicateRows: 0,
    sourceHasMore: false, transactions: [...validRows, { ...validRows[0], externalTransactionId: "foreign-page", fanOnlyFansUserId: "foreign-page-fan", currency: "EUR" }] };
  await check("financial source page stores only USD observations, records foreign rejection and remains replay-idempotent", async out => {
    const result = await financial.ingestFinancialTransactionsChunk({ db, job: scan.job, deviceId: null, chunk: page });
    assert.equal(result.accepted, 2); assert.equal(result.rejected, 1); assert.equal(result.rejectedRows[0].reasonCode, "UNSUPPORTED_CURRENCY");
    const replay = await financial.ingestFinancialTransactionsChunk({ db, job: scan.job, deviceId: null, chunk: page }); assert.equal(replay.replay, true);
    const run = await db.financialReceiptRun.findUnique({ where: { id: receipts.runId(scan.job) } });
    assert.equal(run.proof.currencyContract, "USD_ONLY_V1"); assert.equal(run.proof.windows[0].count, 2); assert.equal(run.proof.windows[0].rejected, 1);
    const facts = await db.financialObservedFact.findMany({ where: { runId: run.id } }); assert.equal(facts.length, 2); assert(facts.every(row => row.value.currency === "USD"));
    assert.equal(await db.creatorFinancialTransaction.count({ where: { creatorId: scan.s.creatorId } }), 0);
    assert.equal(await db.creatorFan.count({ where: { creatorId: scan.s.creatorId } }), 0);
    out.accepted = result.accepted; out.rejected = result.rejected; out.currencyContract = run.proof.currencyContract;
  });
  await check("foreign chart leaves receipt unchanged; accepted USD charts cannot certify a page with rejected source money", async () => {
    const run = await db.financialReceiptRun.findUnique({ where: { id: receipts.runId(scan.job) } }), range = receipts.comparisonRange(run);
    const chart = { scanRunId: scan.job.params.collectionGeneration, collectorVersion: receipts.COLLECTOR, windowIndex: 0,
      rangeFrom: range.from, rangeTo: range.to, category: "total", grossCents: 5000, netCents: 3402, transactionsCount: 2 };
    await assert.rejects(commit(tx => financial.ingestFinancialChartChunk({ db: tx, job: scan.job, chunk: { ...chart, currency: "EUR" } })), { code: "UNSUPPORTED_CURRENCY" });
    assert.deepEqual((await db.financialReceiptRun.findUnique({ where: { id: run.id } })).proof, run.proof);
    for (const category of receipts.FULL_CHARTS) await commit(tx => financial.ingestFinancialChartChunk({ db: tx, job: scan.job,
      chunk: { ...chart, category, ...(category !== "total" && category !== "tips" ? { grossCents: 0, netCents: 0, transactionsCount: 0 } : {}) } }));
    const completed = await receipts.completionProof(db, scan.job); assert.equal(completed.complete, false); assert.equal(completed.currencySupported, true);
    assert.equal(completed.row.proof.windows[0].rejected, 1);
  });
  const clean = await financialJob("clean-scan");
  await check("valid omitted/explicit USD page and all six charts retain exact independent amounts and permit canonical publication", async () => {
    const cleanPage = { ...page, scanRunId: clean.job.params.collectionGeneration, markerStart: clean.job.params.financialWindows[0].initialMarker,
      rawReceived: 2, transactions: validRows };
    await financial.ingestFinancialTransactionsChunk({ db, job: clean.job, chunk: cleanPage });
    const id = receipts.runId(clean.job), run = await db.financialReceiptRun.findUnique({ where: { id } }), range = receipts.comparisonRange(run);
    for (const category of receipts.FULL_CHARTS) await commit(tx => financial.ingestFinancialChartChunk({ db: tx, job: clean.job, chunk: {
      scanRunId: clean.job.params.collectionGeneration, collectorVersion: receipts.COLLECTOR, windowIndex: 0, rangeFrom: range.from, rangeTo: range.to,
      category, currency: "USD", grossCents: ["total", "tips"].includes(category) ? 5000 : 0,
      netCents: ["total", "tips"].includes(category) ? 3402 : 0, transactionsCount: ["total", "tips"].includes(category) ? 2 : 0 } }));
    assert.equal((await receipts.completionProof(db, clean.job)).complete, true);
    const facts = await db.financialObservedFact.findMany({ where: { runId: id } });
    await commit(tx => financial.publishVerifiedFinancialFactsPage({ db: tx, job: clean.job, facts, now }));
    await commit(tx => financial.publishVerifiedFinancialFactsPage({ db: tx, job: clean.job, facts, now }));
    const rows = await db.creatorFinancialTransaction.findMany({ where: { creatorId: clean.s.creatorId } });
    assert.equal(rows.length, 2); assert(rows.every(row => row.currency === "USD" && row.amountCents === 2500 && row.netCents === 1701));
    assert.equal(await db.creatorTip.count({ where: { creatorId: clean.s.creatorId } }), 2);
  });
  await check("direct persisted publication cannot normalize foreign or currencyless receipt evidence into USD", async () => {
    const before = await db.creatorFinancialTransaction.count({ where: { creatorId: clean.s.creatorId } });
    for (const currency of ["EUR", undefined]) await assert.rejects(commit(tx => financial.publishVerifiedFinancialFactsPage({ db: tx, job: clean.job,
      facts: [{ value: { ...validRows[0], externalTransactionId: "bad-persisted", currency } }], now })), { code: "UNSUPPORTED_CURRENCY" });
    assert.equal(await db.creatorFinancialTransaction.count({ where: { creatorId: clean.s.creatorId } }), before);
  });
  return { ok: checks.every(item => item.ok), nativePostgres: true, predecessorUpgrade: true, liveProvider: false,
    financialUnit: "USD cents; exact GROSS and NET are independent", checks };
}

module.exports = { seedUsdWriteLegacyProof, runUsdWriteAuthorityProof };
if (require.main === module) (async () => {
  const factoryPath = process.env.NOD_AUDIT_FIXTURE_FACTORY;
  if (!factoryPath) throw Error("NOD_AUDIT_FIXTURE_FACTORY must provide a disposable createLegacyRuntime with upgrade()");
  const runtime = await require(path.resolve(factoryPath)).createLegacyRuntime();
  try {
    process.env.ONLINOD_NATIVE_TEST_DATABASE_URL = runtime.url; process.env.DATABASE_URL = runtime.url;
    const legacy = await seedUsdWriteLegacyProof({ db: runtime.db }); await runtime.upgrade();
    const result = await runUsdWriteAuthorityProof({ db: runtime.db, legacy });
    if (process.env.NOD_AUDIT_RESULT_PATH) fs.writeFileSync(process.env.NOD_AUDIT_RESULT_PATH, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
