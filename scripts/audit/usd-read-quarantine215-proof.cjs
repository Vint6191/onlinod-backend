"use strict";
// Disposable native PostgreSQL proof: seed actual delivered215 schema, preserve
// its foreign monetary evidence, then execute current read owners. Provider
// observations are fixtures; no real-provider behavior is inferred.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
async function seedTeam({ db, backendRoot = path.resolve(__dirname, '../..') }) {
  const load = createRequire(path.join(backendRoot, 'package.json'));
  const { runRootCommit } = load('./src/services/db-commit-kernel');
  const now = new Date((await db.$queryRawUnsafe('SELECT clock_timestamp() AS now'))[0].now);
  const when = new Date(now.getTime() - 3_600_000);
  const day = new Date(when); day.setUTCHours(0, 0, 0, 0);
  const agencyId = 'team215-reads';
  const creatorA = 'team215-creator-a', creatorB = 'team215-creator-b';
  const memberIds = ['mixed', 'removed', 'euro', 'no-messages'].map(id => `team215-${id}`);
  const [mixed, removed, euro, noMessages] = memberIds;
  await runRootCommit(db, async ({ tx }) => {
    await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true),set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)`);
    await tx.agency.create({ data: { id: agencyId, name: 'Team read proof 215' } });
    for (const id of memberIds) {
      const userId = `${id}-user`;
      await tx.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: 'fixture' } });
      await tx.agencyMember.create({ data: { id, agencyId, userId, displayName: id, role: id === mixed ? 'OWNER' : 'OPERATOR', roleKey: id === mixed ? 'owner' : 'chatter', assignedCreators: 'all',
        deletedAt: id === removed ? now : null,
        teamFunctions: { create: { agencyId, functionKey: 'CHATTER' } } } });
    }
    for (const id of [creatorA, creatorB]) await tx.creatorAccount.create({ data: { id, agencyId, displayName: id, remoteId: id, status: 'READY' } });
    const coverageFrom = new Date(now.getTime() - 30 * 86_400_000);
    await tx.teamProjectionCoverage.create({ data: { agencyId, responseCoverageFrom: coverageFrom, dialogCoverageFrom: coverageFrom } });
    await tx.teamHistoricalAnalyticsCoverage.create({ data: { agencyId, activityCoverageFrom: coverageFrom, moneyCoverageFrom: coverageFrom } });
    await tx.teamMemberActivityDaily.createMany({ data: [
      { agencyId, memberId: mixed, creatorKey: creatorA, creatorId: creatorA, day, messagesSent: 4 },
      { agencyId, memberId: euro, creatorKey: creatorA, creatorId: creatorA, day, messagesSent: 2 },
    ] });
    for (const [id, memberId, creatorId, currency, amountCents, active, occurredAt] of [
      ['mixed-usd', mixed, creatorA, 'USD', 1001, true, when],
      ['mixed-eur', mixed, creatorA, 'EUR', 1999, true, when],
      ['other-creator', mixed, creatorB, 'USD', 3333, true, when],
      ['removed-usd', removed, creatorA, 'USD', 511, true, when],
      ['removed-eur', removed, creatorA, 'EUR', 722, true, when],
      ['euro', euro, creatorA, 'EUR', 803, true, when],
      ['no-messages', noMessages, creatorA, 'USD', 250, true, when],
      ['refunded', mixed, creatorA, 'USD', 9999, false, when],
      ['old', mixed, creatorA, 'USD', 2400, true, new Date(now.getTime() - 9 * 86_400_000)],
    ]) {
      await tx.teamMoneyAttributionFact.create({ data: { id: `read215-${id}`, agencyId, sourceType: 'TIP', sourceRowId: `read215-${id}`,
        creatorId, memberId, fanId: 'same-fan', dialogId: 'same-fan', amountCents, currency, occurredAt,
        businessStatus: active ? 'attributed' : 'refunded', financialStatus: active ? 'paid' : 'refunded', attributionActive: active,
        classificationState: 'CANONICAL', sourceUpdatedAt: when } });
    }
    for (const [creatorId, seconds] of [[creatorA, 1200], [creatorB, 600]]) {
      await tx.teamDialogSession.create({ data: { agencyId, memberId: mixed, creatorId, dialogId: 'same-fan', fanId: 'same-fan',
        sessionId: `read215-${creatorId}`, startedAt: new Date(when.getTime() - seconds * 1000), endedAt: when,
        activeSeconds: seconds, wallSeconds: seconds } });
    }
    for (const [id, classification, seconds, eligible] of [
      ['fresh-fast', 'FRESH', 60, true], ['fresh-slow', 'FRESH', 600, true], ['backlog', 'BACKLOG', 3600, false], ['handoff', 'HANDOFF', 900, false],
    ]) await tx.teamResponseCase.create({ data: { id: `read215-${id}`, agencyId, creatorId: creatorA, memberId: mixed,
      dialogId: 'same-fan', replyMessageId: `read215-${id}`, incomingAt: new Date(when.getTime() - seconds * 1000),
      lastIncomingAt: new Date(when.getTime() - seconds * 1000), replyAt: when, classification, wallClockSeconds: seconds,
      slaEligible: eligible, sla5Pass: eligible ? seconds < 300 : null, sla15Pass: eligible ? seconds < 900 : null } });
  });

  return { agencyId, creatorA, creatorB, memberIds, mixed, removed, euro, noMessages, now, when, day };
}

function reader(backendRoot, db) {
  const load = createRequire(path.join(backendRoot, 'package.json'));
  const prisma = load.resolve('./src/prisma');
  require.cache[prisma] = { id: prisma, filename: prisma, loaded: true, exports: db };
  return load;
}

async function seedOtherReads(db, s, load) {
  const kernel = load('./src/services/db-commit-kernel');
  const write = fn => kernel.runRootCommit(db, async ({ tx }) => {
    await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
    await load('./src/services/campaign-causal-activation-service').enterCampaignWriterGeneration({ db: tx });
    return fn(tx);
  });
  const from = new Date(+s.day - 60 * 86400000), published = 'usd215-published';
  s.oldCurrencyCreator = 'usd215-old-currency'; s.wrappedCreator = 'usd215-wrapped-currency'; s.receiptCurrencyCreator = 'usd215-receipt-currency';
  await write(async tx => {
    await tx.creatorAccount.create({ data: { id: published, agencyId: s.agencyId, displayName: 'Legacy published currency', remoteId: published, status: 'READY' } });
    for (const id of [s.oldCurrencyCreator, s.wrappedCreator, s.receiptCurrencyCreator]) await tx.creatorAccount.create({ data: { id, agencyId: s.agencyId, displayName: id, remoteId: id, status: 'READY' } });
    for (const [creatorId, currency, netCents, grossCents] of [[s.creatorA, 'EUR', 1555, 1888], [s.creatorB, 'USD', 800, 1000], [s.oldCurrencyCreator, 'EUR', 9000, 10000], [s.wrappedCreator, 'USD', 211, 300], [s.receiptCurrencyCreator, 'USD', 1555, 1888]]) {
      const at = creatorId === s.oldCurrencyCreator ? new Date(+s.when - 40 * 86400000) : s.when;
      await load('./src/services/earnings-generation-service').lock(tx, creatorId);
      const generation = `usd215-generation-${creatorId}`;
      await tx.creatorEarningsGeneration.create({ data: { id: generation, agencyId: s.agencyId, creatorId, runId: generation,
        state: 'ACTIVE', phase: 'READY', fromAt: from, throughAt: s.now, snapshotAt: s.now, fullScan: true, publishedAt: s.now } });
      await tx.creatorEarningsLedgerProof.create({ data: { agencyId: s.agencyId, creatorId, fromAt: from,
        throughAt: s.now, confirmedThroughAt: s.now, generation, activeGeneration: generation, proofPolicyVersion: 2 } });
      await tx.creatorFinancialTransaction.create({ data: { id: `usd215-financial-${creatorId}`, agencyId: s.agencyId, creatorId,
        externalTransactionId: `usd215-tx-${creatorId}`, transactionType: 'tip', factType: 'TIP', projectionStatus: 'PROJECTED',
        amountCents: grossCents, netCents, currency, occurredAt: at, sourceUpdatedAt: at, transactionStatus: 'done' } });
      await load('./src/services/earnings-generation-service').upsert(tx, generation, [{ transactionId: `usd215-tx-${creatorId}`,
        occurredAt: at, category: 'tips', grossCents, netCents, status: 'done', observedAt: s.now, fanOnlyFansUserId: 'same-fan',
        financialFact: creatorId === s.receiptCurrencyCreator ? null : creatorId === s.wrappedCreator ? { version: 1, value: { currency: 'EUR', netCents, amountCents: grossCents, transactionStatus: 'done', transactionType: 'tip' } }
          : { currency, netCents, amountCents: grossCents, transactionStatus: 'done', transactionType: 'tip' } }]);
      if (creatorId === s.oldCurrencyCreator) await load('./src/services/earnings-generation-service').upsert(tx, generation, [{
        transactionId: 'current-usd', occurredAt: s.when, category: 'tips', grossCents: 500, netCents: 411, status: 'done', observedAt: s.now,
        financialFact: { version: 1, value: { currency: 'USD', netCents: 411, amountCents: 500 } } }]);
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.fan_ltv_writer','178',true)");
      await tx.fanLtvState.upsert({ where: { creatorId }, update: {}, create: { agencyId: s.agencyId, creatorId,
        sourceKey: 'generation:' + generation, stage: 'LIVE', snapshot: { version: 1, sourceKey: 'generation:' + generation,
          proofGeneration: generation, throughAt: s.now.toISOString(), fromAt: from.toISOString(), asOf: s.now.toISOString(),
          windowDay: s.day.toISOString().slice(0, 10), historyComplete: true, medianCents: netCents,
          ranges: { all: { netCents, knownNetCents: netCents, payingFans: 1, averageCents: netCents, attributionComplete: true },
            '7d': { netCents, knownNetCents: netCents, payingFans: 1, averageCents: netCents, attributionComplete: true } } } } });
    }
    for (const publishedCreator of [published, s.creatorB]) {
      const suffix = publishedCreator === published ? '' : '-retired';
      await tx.jobInstance.create({ data: { id: 'usd215-job' + suffix, agencyId: s.agencyId, creatorId: publishedCreator, jobKey: 'fetch_earnings', scope: 'creator', status: 'PUBLISHING' } });
      await tx.analyticsPublication.create({ data: { id: 'usd215-publication' + suffix, jobId: 'usd215-job' + suffix, agencyId: s.agencyId, creatorId: publishedCreator,
        userId: `${s.mixed}-user`, deviceId: 'fixture', leaseRevision: 1, leaseTokenHash: 'fixture', payloadHash: 'fixture', payload: { scanRunId: 'usd215-scan' + suffix }, stage: 'FINALIZE' } });
      await tx.analyticsScanProof.create({ data: { id: 'usd215-scan' + suffix, agencyId: s.agencyId, creatorId: publishedCreator,
        dataType: 'EARNINGS', scanRunId: 'usd215-scan' + suffix, sourceTimezone: 'UTC', scanFrom: s.day, scanTo: s.day,
        requestedAt: s.now, observationStartedAt: s.now, serverReceivedAt: s.now, committedAt: s.now, status: 'COMMITTED',
        collectorVersion: 'fixture', schemaVersion: 1, scanGeneration: 'fixture', collectionReason: 'fixture', payloadChecksum: 'fixture', proofVersion: 2, sourceJobId: 'usd215-job' + suffix } });
      await tx.creatorEarningsPublishedDay.create({ data: { id: 'usd215-published-day' + suffix, agencyId: s.agencyId, creatorId: publishedCreator,
        date: s.day, totalCents: 7444, tipsCents: 7444, currency: 'EUR', sourceScanRunId: 'usd215-scan' + suffix, scanProofId: 'usd215-scan' + suffix,
        coverageStatus: 'PARTIAL', lastVerifiedAt: s.now, sourceScanRequestedAt: s.now } });
      await tx.analyticsPublication.update({ where: { id: 'usd215-publication' + suffix }, data: { state: 'COMMITTED', stage: 'TERMINAL', completedAt: s.now } });
      await tx.jobInstance.update({ where: { id: 'usd215-job' + suffix }, data: { status: 'DONE', completedAt: s.now } });
    }
    await load('./src/services/traffic-projection-authority').enterTrafficProjection(tx, s.creatorA);
    await tx.creatorCampaign.create({ data: { id: 'usd215-campaign', agencyId: s.agencyId, creatorId: s.creatorA,
      externalCampaignId: 'usd215-campaign', name: 'Foreign historical cost' } });
    const [projected] = await tx.$queryRawUnsafe('SELECT onlinod_traffic_project_source_v2($1) AS id', 'usd215-campaign');
    s.trafficSourceId = projected.id;
    await tx.trafficSource.update({ where: { id: s.trafficSourceId }, data: { costCents: 500, currency: 'EUR', costRevision: 1 } });
    await tx.creatorSubscriptionLedger.create({ data: { id: 'usd215-sub-eur', agencyId: s.agencyId, creatorId: s.creatorA,
      sourceId: s.trafficSourceId, fanId: 'same-fan', eventHash: 'usd215-sub-eur', externalEventId: 'usd215-sub-eur',
      source: 'fixture', eventType: 'paid_subscribed', amountCents: 932, currency: 'EUR', occurredAt: s.when } });
    await tx.$executeRawUnsafe('SELECT onlinod_traffic_receipt_project_v2($1)', 'usd215-sub-eur');
    const receiptAuthority = load('./src/services/financial-receipt-authority');
    await receiptAuthority.enter(tx);
    for (const [creatorId, expired] of [[s.creatorA, false], [s.creatorB, true], [s.receiptCurrencyCreator, false], [s.oldCurrencyCreator, false]]) {
      const job = await tx.jobInstance.create({ data: { id: `usd215-scanner-${creatorId}`, agencyId: s.agencyId, creatorId,
        jobKey: 'financial_transactions_scan', scope: 'creator', status: 'DONE', params: { financialReceiptVersion: 1, collectionGeneration: 'usd215-old' }, result: { complete: true } } });
      const generationReceipt = [s.receiptCurrencyCreator, s.oldCurrencyCreator].includes(creatorId);
      const receiptAt = creatorId === s.oldCurrencyCreator ? new Date(+s.when - 40 * 86400000) : s.when;
      const runId = generationReceipt ? `usd215-generation-${creatorId}` : receiptAuthority.runId(job);
      const totals = { count: 1, grossKnown: 1, grossCents: 1888, netCents: 1555, feeCents: 333, storedOnly: 0, pages: 1, rejected: 0, exhausted: true,
        statusGroups: { done: { transactionStatus: 'done', _count: { _all: 1 }, _sum: { amountCents: 1888, netCents: 1555, feeCents: 333 }, grossKnown: 1 } },
        typeGroups: { tip: { transactionType: 'tip', count: 1, grossKnown: 1, grossCents: 1888, netCents: 1555 } },
        charts: { total: { grossCents: 1888, netCents: 1555, transactionsCount: 1 } } };
      await tx.financialReceiptRun.create({ data: { id: runId, agencyId: s.agencyId, creatorId, jobId: job.id, generation: 'usd215-old',
        windows: [{ kind: 'RECENT', from: s.day.toISOString(), to: s.now.toISOString() }], cursor: { phase: 'done' },
        proof: { version: 2, complete: true, windows: [totals] }, ...(expired ? { compactedAt: s.now } : {}) } });
      if (!expired) await tx.financialObservedFact.create({ data: { runId, windowIndex: 0, externalId: generationReceipt ? `usd215-tx-${creatorId}` : 'foreign', occurredAt: receiptAt,
        value: { currency: 'EUR', amountCents: 1888, netCents: 1555, feeCents: 333, transactionType: 'tip', occurredAt: receiptAt.toISOString() } } });
    }
    // A retained foreign receipt belonging to a retired generation must not
    // invalidate the current healthy USD generation for the same transaction.
    await load('./src/services/earnings-generation-service').lock(tx, s.creatorB);
    const retired = 'usd215-retired-receipt-generation';
    await tx.creatorEarningsGeneration.create({ data: { id: retired, agencyId: s.agencyId, creatorId: s.creatorB, runId: retired,
      state: 'RETIRED', phase: 'READY', fromAt: from, throughAt: s.now, snapshotAt: s.now, fullScan: true, publishedAt: s.now, retiredAt: s.now } });
    await load('./src/services/earnings-generation-service').upsert(tx, retired, [{ transactionId: `usd215-tx-${s.creatorB}`,
      occurredAt: s.when, category: 'tips', grossCents: 9999, netCents: 8888, status: 'done', observedAt: s.now, financialFact: null }]);
    const retiredJob = await tx.jobInstance.create({ data: { id: retired, agencyId: s.agencyId, creatorId: s.creatorB,
      jobKey: 'fetch_earnings', scope: 'creator', status: 'DONE' } });
    await tx.financialReceiptRun.create({ data: { id: retired, agencyId: s.agencyId, creatorId: s.creatorB, jobId: retiredJob.id, generation: retired,
      windows: [{ kind: 'RECENT', from: s.day.toISOString(), to: s.now.toISOString() }], cursor: { phase: 'done' }, proof: { complete: true, windows: [{ count: 1 }] } } });
    await tx.financialObservedFact.create({ data: { runId: retired, windowIndex: 0, externalId: `usd215-tx-${s.creatorB}`, occurredAt: s.when,
      value: { currency: 'EUR', amountCents: 9999, netCents: 8888, transactionStatus: 'done', transactionType: 'tip', occurredAt: s.when.toISOString() } } });
    for (const [creatorId, revenueCents] of [[s.creatorA,1555],[s.wrappedCreator,211],[s.receiptCurrencyCreator,1555]]) {
      const id = creatorId === s.creatorA ? 'usd215-media' : 'usd215-media-' + creatorId;
      await tx.creatorMediaAsset.create({ data: { id, agencyId: s.agencyId, creatorId,
        mediaId: id, catalogActive: true, soldCount: 1, revenueCents, averagePriceCents: revenueCents } });
    }
  });
  return { ...s, from, published, write };
}

async function runReadProof({ db, baselineRoot, sourceRoot, upgrade }) {
  const old = reader(baselineRoot, db), current = reader(sourceRoot, db);
  const s = await seedOtherReads(db, await seedTeam({ db, backendRoot: baselineRoot }), old);
  const evidence = { node: process.version, nativePostgres: true, liveProvider: false, before: {}, after: {}, checks: [] };
  const check = async (name, fn) => {
    try { await fn(); evidence.checks.push({ name, ok: true }); console.log('PASS', name); }
    catch (error) { evidence.checks.push({ name, ok: false, error: String(error.stack || error) }); console.error('FAIL', name, error.message); }
  };
  const snapshot = load => load('./src/services/team-analytics-service').buildTeamAnalyticsSnapshot({ agencyId: s.agencyId,
    rangeKey: '7d', allowedCreatorIds: [s.creatorA], includeMoney: true });
  const finance = (load, creatorId = s.creatorA) => load('./src/services/published-financial-read-repository')
    .readPublishedFinancialSummary({ db, creatorId, from: s.day, to: s.now });
  const traffic = load => load('./src/services/traffic-read-service').getTrafficOverview({ db, creatorId: s.creatorA,
    userId: `${s.mixed}-user`, rangeKey: 'all' });
  const days = (load, creatorId) => load('./src/services/published-earnings-read-repository')
    .readPublishedEarningsDays({ db, creatorId, from: s.day, to: s.day, now: s.now });
  const member = await db.agencyMember.findUnique({ where: { id: s.mixed } });
  const homeInput = { db, agencyId: s.agencyId, member: { ...member, broad: true }, money: true, manage: true, now: s.now,
    range: old('./src/services/analytics-range-contract').displayRangeBounds('7d', s.now),
    previous: old('./src/services/analytics-range-contract').previousDisplayRange('7d', s.now) };
  await check('delivered215 exposes lone EUR Team amount and mixed foreign bucket', async () => {
    const value = await snapshot(old); evidence.before.team = value;
    assert.equal(value.members.find(row => row.member.id === s.euro).metrics.revenueCurrency, 'EUR');
    assert.equal(value.members.find(row => row.member.id === s.mixed).metrics.revenueByCurrency.EUR, 1999);
  });
  await check('delivered215 trusts foreign historical financial rollup and daily publication', async () => {
    evidence.before.finance = await finance(old); evidence.before.days = await days(old, s.published);
    assert.equal(evidence.before.finance.finance.netCents, 1555);
    assert.equal(evidence.before.days[0].daily.currency, 'EUR'); assert.equal(evidence.before.days[0].daily.totalCents, 7444);
  });
  await check('delivered215 exposes foreign Traffic cost and subscription as scalar', async () => {
    const value = await traffic(old); evidence.before.traffic = value;
    assert.equal(value.totals.costCurrency, 'EUR'); assert.equal(value.totals.costCents, 500);
    assert.equal(value.totals.subscriptionRevenueCents, 932);
  });
  if (upgrade) evidence.upgrade = await upgrade();
  await check('new input rejection does not mutate old foreign evidence', async () => {
    assert.throws(() => current('./src/services/usd-money-contract').requireUsdCurrency('EUR'), { code: 'UNSUPPORTED_CURRENCY' });
    assert.equal((await db.creatorFinancialTransaction.findUnique({ where: { id: `usd215-financial-${s.creatorA}` } })).currency, 'EUR');
    assert.equal((await db.teamMoneyAttributionFact.findUnique({ where: { id: 'read215-euro' } })).amountCents, 803);
  });
  await check('Team affected members, overview and dialogs are unknown with explicit USD-only reason', async () => {
    const value = await snapshot(current); evidence.after.team = value;
    for (const id of [s.mixed, s.euro, s.removed]) {
      const metric = value.members.find(row => row.member.id === id).metrics;
      assert.equal(metric.revenueAttributedCents, null); assert.equal(metric.revenueCurrency, null);
      assert.equal(metric.revenueByCurrency, null); assert.equal(metric.dollarsPerMessageCents, null);
      assert.equal(metric.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY');
    }
    assert.equal(value.overview.revenueAttributedCents, null); assert.equal(value.overview.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY');
    const dialog = value.members.find(row => row.member.id === s.mixed).metrics.topDialogSessions[0];
    assert.equal(dialog.shiftRevenueCents, null); assert.equal(dialog.shiftRevenueUnavailableReason, 'UNSUPPORTED_CURRENCY');
    assert.equal(value.members.find(row => row.member.id === s.noMessages).metrics.revenueAttributedCents, 250);
    assert.equal(value.members.find(row => row.member.id === s.noMessages).metrics.revenueCurrency, 'USD');
    assert.equal(value.members.find(row => row.member.id === s.noMessages).metrics.dollarsPerMessageCents, null);
    assert.equal(value.members.find(row => row.member.id === s.mixed).metrics.responseSamples, 2);
  });
  await check('foreign-only contamination never becomes zero through canonical USD filtering', async () => {
    const value = await snapshot(current);
    assert.equal(value.members.find(row => row.member.id === s.euro).metrics.revenueAttributedCents, null);
    assert.equal(value.members.find(row => row.member.id === s.euro).metrics.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY');
  });
  await check('Creator finance and active earnings deny contaminated rollup while other creator USD is exact', async () => {
    evidence.after.finance = await finance(current); const healthy = await finance(current, s.creatorB);
    assert.equal(evidence.after.finance.ready, false); assert.equal(evidence.after.finance.state, 'UNSUPPORTED_CURRENCY');
    assert.equal(evidence.after.finance.finance.netCents, null); assert.equal(evidence.after.finance.finance.grossCents, null);
    assert.equal(healthy.ready, true); assert.equal(healthy.finance.netCents, 800); assert.equal(healthy.finance.grossCents, 1000);
    const healthyDay = await days(current, s.creatorB); assert.equal(healthyDay[0].daily.totalCents, 800); assert.equal(healthyDay[0].daily.currency, 'USD');
    const live = await days(current, s.creatorA); assert.equal(live[0].daily, null);
    assert.equal(live[0].coverage.lastErrorCode, 'UNSUPPORTED_CURRENCY');
  });
  await check('foreign facts outside requested UTC range preserve current USD authority', async () => {
    const value = await finance(current, s.oldCurrencyCreator);
    assert.equal(value.ready, true); assert.equal(value.unavailableReason, null); assert.equal(value.finance.netCents, 411);
    const live = await days(current, s.oldCurrencyCreator); assert.equal(live[0].daily.totalCents, 411); assert.equal(live[0].daily.currency, 'USD');
    const page = await current('./src/services/home-read-repository').readHomeCreatorPage({ ...homeInput, limit: 100 });
    const row = page.creators.find(row => row.id === s.oldCurrencyCreator);
    assert.equal(row.revenueCents, 411); assert.equal(row.revenueUnavailableReason, null);
  });
  await check('wrapped active-generation currency remains guarded even when raw transaction is USD', async () => {
    assert.equal((await db.creatorFinancialTransaction.findUnique({ where: { id: `usd215-financial-${s.wrappedCreator}` } })).currency, 'USD');
    const value = await finance(current, s.wrappedCreator);
    assert.equal(value.ready, false); assert.equal(value.unavailableReason, 'UNSUPPORTED_CURRENCY'); assert.equal(value.finance.netCents, null);
    const media = await current('./src/services/media-library-service').getMediaSalesSummary({ db, agencyId: s.agencyId, creatorId: s.wrappedCreator });
    assert.equal(media.summary.revenueCents, null); assert.equal(media.summary.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY');
  });
  await check('active retained receipt currency guards nullable legacy JSON without reviving retired generation evidence', async () => {
    const oldValue = await finance(old, s.receiptCurrencyCreator);
    assert.equal(oldValue.ready, true); assert.equal(oldValue.finance.netCents, 1555);
    const value = await finance(current, s.receiptCurrencyCreator);
    evidence.after.receiptCurrencyFinance = value;
    assert.equal(value.ready, false); assert.equal(value.unavailableReason, 'UNSUPPORTED_CURRENCY'); assert.equal(value.finance.netCents, null);
    const live = await days(current, s.receiptCurrencyCreator);
    assert.equal(live[0].daily, null); assert.equal(live[0].coverage.lastErrorCode, 'UNSUPPORTED_CURRENCY');
    const page = await current('./src/services/home-read-repository').readHomeCreatorPage({ ...homeInput, limit: 100 });
    assert.equal(page.creators.find(row => row.id === s.receiptCurrencyCreator).revenueCents, null);
    assert.equal(page.creators.find(row => row.id === s.receiptCurrencyCreator).revenueUnavailableReason, 'UNSUPPORTED_CURRENCY');
    const ltv = await current('./src/services/fan-ltv-read-repository').readFanLtv({ db, creatorId: s.receiptCurrencyCreator, rangeKey: '7d', now: s.now });
    assert.equal(ltv.available, false); assert.equal(ltv.unavailableReason, 'UNSUPPORTED_CURRENCY'); assert.equal(ltv.allTime, null);
    const oldMedia = await old('./src/services/media-library-service').getMediaSalesSummary({ db, agencyId: s.agencyId, creatorId: s.receiptCurrencyCreator });
    assert.equal(oldMedia.summary.revenueCents, 1555);
    const media = await current('./src/services/media-library-service').getMediaSalesSummary({ db, agencyId: s.agencyId, creatorId: s.receiptCurrencyCreator });
    evidence.after.receiptCurrencyMedia = media;
    assert.equal(media.summary.revenueCents, null); assert.equal(media.summary.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY'); assert.equal(media.summary.totalSales, 1);
    const healthy = await finance(current, s.creatorB);
    assert.equal(healthy.ready, true); assert.equal(healthy.finance.netCents, 800);
  });
  await check('pre-ledger published EUR day remains unavailable and reports currency reason', async () => {
    evidence.after.days = await days(current, s.published);
    assert.equal(evidence.after.days[0].daily, null); assert.equal(evidence.after.days[0].coverage.lastErrorCode, 'UNSUPPORTED_CURRENCY');
  });
  await check('Home list and agency aggregate quarantine currencyless contaminated sums', async () => {
    const repo = current('./src/services/home-read-repository');
    const page = await repo.readHomeCreatorPage({ ...homeInput, includeRevenuePoints: true, limit: 100 });
    const affected = page.creators.find(row => row.id === s.creatorA), healthy = page.creators.find(row => row.id === s.creatorB);
    assert.equal(affected.revenueCents, null); assert.equal(affected.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY'); assert.deepEqual(affected.revenuePoints, []);
    assert.equal(healthy.revenueCents, 800);
    const totals = await repo.readHomeTotals(homeInput); evidence.after.home = { page, totals };
    assert.equal(totals.totalCents, null); assert.equal(totals.unavailableReason, 'UNSUPPORTED_CURRENCY');
  });
  await check('Traffic cost, subscription revenue and ROI stay unavailable after legacy rows persist', async () => {
    const value = await traffic(current); evidence.after.traffic = value;
    assert.equal(value.totals.costCents, null); assert.equal(value.totals.costCurrency, null); assert.equal(value.totals.costUnavailableReason, 'UNSUPPORTED_CURRENCY');
    assert.equal(value.totals.subscriptionRevenueCents, null); assert.equal(value.totals.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY');
    const source = value.sources.find(row => row.id === s.trafficSourceId);
    assert.equal(source.currency, null); assert.equal(source.costCents, null); assert.equal(source.revenueCents, null); assert.equal(source.roiPercent, null);
    assert.equal(value.buckets.find(row => row.key === 'of_campaign').costCents, null);
  });
  await check('billing earnings aggregates never return a contaminated range as fully reported', async () => {
    const values = await current('./src/services/published-earnings-read-repository').readPublishedEarningsAggregates({
      db, creatorIds: [s.creatorA, s.creatorB], from: s.day, to: s.day, now: s.now, freshnessMs: 86400000 });
    const affected = values.get(s.creatorA); assert(!affected || affected.days < 1 || affected.staleReason === 'UNSUPPORTED_CURRENCY');
  });
  await check('Fan LTV saved foreign snapshot is unavailable with reason', async () => {
    const value = await current('./src/services/fan-ltv-read-repository').readFanLtv({ db, creatorId: s.creatorA, rangeKey: '7d', now: s.now });
    evidence.after.ltv = value; assert.equal(value.available, false); assert.equal(value.allTime, null); assert.equal(value.period, null);
    assert.equal(value.unavailableReason, 'UNSUPPORTED_CURRENCY');
  });
  await check('Media summary and asset monetary values are null for unsupported source', async () => {
    const service = current('./src/services/media-library-service');
    const summary = await service.getMediaSalesSummary({ db, agencyId: s.agencyId, creatorId: s.creatorA });
    const assets = await service.listMediaSalesAssets({ db, agencyId: s.agencyId, creatorId: s.creatorA });
    evidence.after.media = { summary, assets };
    assert.equal(summary.summary.revenueCents, null); assert.equal(summary.summary.revenueAvailable, false);
    assert.equal(summary.summary.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY'); assert.equal(summary.summary.totalSales, 1);
    assert.equal(assets.items[0].totalRevenueCents, null); assert.equal(assets.items[0].averagePriceCents, null);
  });
  await check('Campaign projection records unknown instead of foreign amount and read masks stale subtotal', async () => {
    const projection = current('./src/services/campaign-read-projection-service');
    assert.deepEqual(projection.financialMetrics({ currency: 'EUR', netCents: 1555, amountCents: 1888, transactionStatus: 'done' }), { unsupportedCurrencyTransactions: '1' });
    const value = current('./src/services/campaign-read-repository').metricsDto({ knownNetCents: '1555', grossCents: '1888' }, true, true, true);
    assert.equal(value.knownNetCents, null); assert.equal(value.netCents, null); assert.equal(value.grossCents, null);
    assert.equal(value.revenueUnavailableReason, 'UNSUPPORTED_CURRENCY');
    const page = await current('./src/services/campaign-read-repository').readCampaignPage({ db, creatorId: s.creatorA, now: s.now });
    evidence.after.campaigns = page;
    assert.equal(page.sourceCoverage.revenue.reason, 'UNSUPPORTED_CURRENCY'); assert.equal(page.sourceCoverage.revenue.ready, false);
    assert.equal(page.sourceCoverage.revenue.status, 'UNAVAILABLE');
  });
  await check('Financial scanner quarantines retained foreign receipt summaries, charts and rows', async () => {
    const creator = await db.creatorAccount.findUnique({ where: { id: s.creatorA } });
    const value = await current('./src/services/financial-transaction-scan-control-service').readManualFinancialTransactionScan({ db, creator });
    evidence.after.scanner = value;
    assert.equal(value.moneyUnavailableReason, 'UNSUPPORTED_CURRENCY'); assert.equal(value.published, false);
    assert.equal(value.summary.netCents, null); assert.equal(value.summary.earningsNetCents, null);
    assert.equal(value.charts[0].netCents, null); assert.equal(value.typeSummary[0].netCents, null);
    assert.equal(value.items[0].currency, null); assert.equal(value.items[0].netCents, null);
    assert.equal(value.reconciliation.chartNetCents, null); assert.equal(value.reconciliation.chartReady, false);
  });
  await check('compacted old scanner proof without currency evidence stays explicitly unknown', async () => {
    const creator = await db.creatorAccount.findUnique({ where: { id: s.creatorB } });
    const value = await current('./src/services/financial-transaction-scan-control-service').readManualFinancialTransactionScan({ db, creator });
    evidence.after.compactedScanner = value;
    assert.equal(value.moneyUnavailableReason, 'CURRENCY_EVIDENCE_UNAVAILABLE'); assert.equal(value.summary.netCents, null);
    assert.equal(value.published, false); assert.equal(value.status, 'PARTIAL');
  });
  await check('no-money Team capability keeps protected values null', async () => {
    const value = await current('./src/services/team-analytics-service').buildTeamAnalyticsSnapshot({ agencyId: s.agencyId, rangeKey: '7d', allowedCreatorIds: [s.creatorA], includeMoney: false });
    assert.equal(value.moneyVisible, false); assert.equal(value.overview.revenueAttributedCents, null);
    assert(value.members.every(row => row.metrics.revenueAttributedCents === null && row.metrics.revenueByCurrency === null));
  });
  evidence.ok = evidence.checks.every(row => row.ok);
  return evidence;
}

if (require.main === module) (async () => {
  const sourceRoot = path.resolve(process.env.NOD_USD_SOURCE_BACKEND || path.join(__dirname, '../..'));
  const baselineRoot = path.resolve(process.env.NOD_USD_BASELINE_BACKEND || path.join(sourceRoot, '../../baseline/backend'));
  const fixture = process.env.NOD_USD_NATIVE_FIXTURE;
  if (!fixture) throw Error('NOD_USD_NATIVE_FIXTURE must identify the disposable legacy-upgrade fixture');
  const runtime = await require(fixture).createLegacyRuntime();
  try {
    const evidence = await runReadProof({ db: runtime.db, sourceRoot, baselineRoot,
      upgrade: process.env.NOD_USD_UPGRADE === '1' ? () => runtime.upgrade() : null });
    const output = process.env.NOD_AUDIT_NATIVE_OUTPUT;
    fs.writeFileSync(path.join(output, 'usd-read-quarantine-result.json'), JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, passed: evidence.checks.filter(row => row.ok).length }));
    if (!evidence.ok) process.exitCode = 1;
  } finally { await runtime.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { runReadProof };
