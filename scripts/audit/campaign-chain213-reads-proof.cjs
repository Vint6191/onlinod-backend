'use strict';
// Run against an explicitly supplied disposable native database installed by
// the production installer. Never reads an ambient application DATABASE_URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.resolve(process.env.NOD_CAMPAIGN_BACKEND_ROOT || path.join(__dirname, '../..'));
const connectionFile = process.env.NOD_CAMPAIGN_DATABASE_FILE;
if (!connectionFile) throw Error('NOD_CAMPAIGN_DATABASE_FILE must name the disposable database connection file');
const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
const url = connection.url || connection.DATABASE_URL;
if (!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw Error('LOCAL_DISPOSABLE_DATABASE_REQUIRED');
process.env.DATABASE_URL = url;
const { PrismaClient } = require(path.join(root, 'node_modules/@prisma/client'));
const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
const currencyQueries = [];
db.$on('query', event => { if (event.query.startsWith('/* traffic-cost-currencies:')) currencyQueries.push({ query: event.query, params: JSON.parse(event.params) }); });
require.cache[require.resolve(path.join(root, 'src/prisma'))] = { exports: db };
const kernel = require(path.join(root, 'src/services/db-commit-kernel'));
const projection = require(path.join(root, 'src/services/traffic-projection-service'));
const reads = require(path.join(root, 'src/services/traffic-read-service'));
const campaignProjection = require(path.join(root, 'src/services/campaign-read-projection-service'));
const campaignReads = require(path.join(root, 'src/services/campaign-read-repository'));
const receipts = require(path.join(root, 'src/services/subscription-receipt-projection-service'));
const output = process.env.NOD_CAMPAIGN_READS_OUTPUT;
const prefix = `reads213-${randomUUID().slice(0,8)}`;
const scope = { agencyId: prefix + '-agency', creatorId: prefix + '-creator', userId: prefix + '-user' };
const evidence = { node: process.version, checks: [], cases: {}, nativePostgres: true, liveProvider: false, scope };
const check = async (name, fn) => {
  try { const result = await fn(); evidence.checks.push({ name, ok: true, ...(result ? { result } : {}) }); console.log('PASS', name); }
  catch (error) { evidence.checks.push({ name, ok: false, error: String(error.stack || error) }); console.error('FAIL', name, error.message); }
};
async function write(fn) {
  return kernel.runRootCommit(db, async ({ tx }) => {
    await require(path.join(root, 'src/services/campaign-causal-activation-service')).enterCampaignWriterGeneration({ db: tx });
    return fn(tx);
  }, { profile: 'JOB_CHUNK' });
}
async function drain() {
  for (let turn = 0; turn < 100; turn++) {
    const result = await projection.runTrafficProjectionSweep({ db, limit: 8 });
    assert.equal(result.ok, true, JSON.stringify(result));
    const debt = await db.domainWorkItem.count({ where: { creatorId: scope.creatorId, workClass: { in: ['TRAFFIC_FACT','TRAFFIC_FAN','TRAFFIC_BACKFILL'] }, isOutstanding: true } });
    if (!debt) return turn + 1;
  }
  throw Error('TRAFFIC_PROJECTION_DID_NOT_CONVERGE');
}
async function drainCampaigns() {
  for (let turn = 0; turn < 80; turn++) {
    const report = await campaignProjection.runCampaignProjectionSweep({ db, limit: 8 }); assert.equal(report.ok, true, JSON.stringify(report));
    if ((await campaignReads.readiness(db, scope.creatorId, new Date())).ready) return turn + 1;
  }
  throw Error('CAMPAIGN_PROJECTION_DID_NOT_CONVERGE');
}
const overview = (extra = {}) => reads.getTrafficOverview({ db, ...scope, rangeKey: 'all', ...extra });
const setCost = (sourceId, currency, costCents = 500) => write(async tx => {
  await require(path.join(root, 'src/services/traffic-projection-authority')).enterTrafficProjection(tx, scope.creatorId);
  return tx.trafficSource.update({ where: { id: sourceId }, data: { costCents, currency, costRevision: { increment: 1 } } });
});
async function main() {
  const version = await db.$queryRawUnsafe('SELECT version() AS version'); evidence.engine = version[0].version;
  await write(async tx => {
    await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true),set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
    await tx.user.create({ data: { id: scope.userId, email: scope.userId + '@example.test', passwordHash: 'synthetic-read-fixture' } });
    await tx.agency.create({ data: { id: scope.agencyId, name: 'Campaign read proof' } });
    await tx.agencyMember.create({ data: { id: prefix + '-member', ...{ agencyId: scope.agencyId, userId: scope.userId }, role: 'OWNER', roleKey: 'owner', assignedCreators: 'all', permissions: {} } });
    await tx.creatorAccount.create({ data: { id: scope.creatorId, agencyId: scope.agencyId, displayName: 'Campaign read fixture', remoteId: prefix, status: 'READY' } });
  });
  const now = new Date(), ago = days => new Date(+now - days * 86400000), fan = prefix + '-fan';
  const oldCampaign = prefix + '-campaign-a', newCampaign = prefix + '-campaign-b';
  await write(async tx => {
    await tx.creatorFan.create({ data: { id: fan, agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserId: '9007199254740993', username: 'read_fixture' } });
    await tx.creatorFanValueCurrent.create({ data: { id: prefix + '-value', agencyId: scope.agencyId, creatorId: scope.creatorId, fanRecordId: fan,
      platformReportedTotalSpendCents: 9000n, messagesSpentCents: 7000n, valueObservedAt: now, source: 'USER_PROFILE' } });
    await tx.creatorCampaign.createMany({ data: [oldCampaign,newCampaign].map((id, index) => ({ id, agencyId: scope.agencyId, creatorId: scope.creatorId,
      externalCampaignId: prefix + '-external-' + index, name: 'Source ' + index, collectedAt: ago(index ? 1 : 2) })) });
    await tx.creatorCampaignFan.createMany({ data: [oldCampaign,newCampaign].map((id, index) => ({ id: prefix + '-membership-' + index, agencyId: scope.agencyId,
      creatorId: scope.creatorId, campaignId: id, fanRecordId: fan, attributedAt: ago(index ? 3 : 10), collectedAt: ago(index ? 1 : 2) })) });
  });
  await drain();
  const sources = await db.trafficSource.findMany({ where: { creatorId: scope.creatorId } });
  const oldSource = sources.find(row => row.canonicalCampaignId === oldCampaign), newSource = sources.find(row => row.canonicalCampaignId === newCampaign);
  const job = { agencyId: scope.agencyId, creatorId: scope.creatorId, params: {} };
  const fact = { eventHash: prefix + '-subscription', eventType: 'paid_subscribed', fanId: '9007199254740993', amountCents: 1000, subscribedAt: ago(8).toISOString(), currency: 'USD' };
  const projected = await receipts.projectCanonicalSubscriptionReceipt({ db, job, fact });
  await drain();
  await check('Traffic keeps its latest-observed membership attribution while Campaigns uses receipt-time attribution', async () => {
    const receipt = await db.creatorSubscriptionLedger.findUnique({ where: { id: projected.ledgerId } });
    assert.equal(receipt.sourceId, newSource.id);
    const [attribution] = await db.$queryRawUnsafe('SELECT onlinod_campaign_read_attribution_v3($1,$2,$3,phase3_utc_timestamp($4::timestamptz)) AS campaign', scope.agencyId, scope.creatorId, fan, ago(8));
    assert.equal(attribution.campaign, oldCampaign);
    return { traffic: newSource.id, campaign: oldCampaign };
  });
  await check('A shared fan is counted once in total spend and once in each source membership', async () => {
    const result = await overview(); evidence.cases.sharedFan = result;
    assert.equal(result.projection.ready, true); assert.equal(result.totals.sourceMembers, 2);
    assert.equal(result.totals.valueSnapshotMembers, 1); assert.equal(result.totals.fanValueCents, 9000);
    assert(result.sources.every(row => row.claimers === 1 && row.fanValueCents === 9000));
    assert.equal(result.totals.subscriptionRevenueCents, 1000);
  });
  await check('Unknown value components remain null while the known lifetime spend is preserved', async () => {
    const result = await reads.getTrafficSourceMembers({ db, ...scope, sourceId: newSource.id, rangeKey: 'all' });
    evidence.cases.members = result;
    assert.equal(result.members[0].fanId, '9007199254740993'); assert.equal(result.members[0].totalSummCents, 9000);
    assert.equal(result.members[0].tipsSummCents, null); assert.equal(result.totals.tipsSummCents, null);
    assert.equal(result.members[0].ledgerRevenueCents, 1000);
  });
  await check('Replay, amount correction, source move and receipt deletion converge without double counting', async () => {
    await receipts.projectCanonicalSubscriptionReceipt({ db, job, fact }); await drain();
    assert.equal((await overview()).totals.paidSubscriptions, 1);
    await receipts.projectCanonicalSubscriptionReceipt({ db, job, fact: { ...fact, amountCents: 1234 } }); await drain();
    assert.equal((await overview()).totals.subscriptionRevenueCents, 1234);
    await write(tx => tx.creatorSubscriptionLedger.update({ where: { id: projected.ledgerId }, data: { sourceId: oldSource.id } })); await drain();
    let result = await overview();
    assert.equal(result.totals.subscriptionRevenueCents, 1234); assert.equal(result.sources.find(row => row.id === oldSource.id).revenueCents, 1234);
    assert.equal(result.sources.find(row => row.id === newSource.id).revenueCents, 0);
    await write(tx => tx.creatorSubscriptionLedger.delete({ where: { id: projected.ledgerId } })); await drain();
    result = await overview(); assert.equal(result.totals.subscriptionRevenueCents, 0); assert.equal(result.totals.paidSubscriptions, 0);
    await receipts.projectCanonicalSubscriptionReceipt({ db, job, fact }); await drain();
  });
  await check('Foreign cost writes are rejected and preserve the last authorized USD contribution', async () => {
    await setCost(newSource.id, 'USD', 500);
    const before = await db.trafficSource.findUnique({ where: { id: newSource.id } });
    await assert.rejects(() => setCost(newSource.id, 'EUR'), /USD_CURRENCY_REQUIRED/);
    const after = await db.trafficSource.findUnique({ where: { id: newSource.id } });
    assert.equal(after.costRevision, before.costRevision);
    const result = await overview(), row = result.sources.find(item => item.id === newSource.id);
    evidence.cases.rejectedForeignCost = row; evidence.cases.usdAfterRejectedCost = result;
    assert.equal(row.currency, 'USD'); assert.equal(row.revenueCents, 1000); assert.equal(row.costCents, 500);
    assert.equal(row.roiPercent, 100); assert.equal(row.valueRoiPercent, 1700);
  });
  await check('USD source cost retains meaningful revenue and lifetime value ROI', async () => {
    await setCost(newSource.id, 'USD');
    const row = (await overview()).sources.find(item => item.id === newSource.id);
    assert.equal(row.roiPercent, 100); assert.equal(row.valueRoiPercent, 1700);
  });
  await check('Zero cost has no ROI denominator and negative cost is rejected by the actual command contract', async () => {
    await setCost(newSource.id, 'USD', 0);
    const row = (await overview()).sources.find(item => item.id === newSource.id);
    assert.equal(row.roiPercent, null); assert.equal(row.valueRoiPercent, null);
    const { payloads } = require(path.join(root, 'src/services/human-control-command-contract'));
    assert.equal(payloads['traffic.cost'].safeParse({ sourceId: newSource.id, expectedRevision: 1, costCents: -1, currency: 'USD' }).success, false);
  });
  await check('Traffic page boundaries expose every source without accumulating or duplicating rows', async () => {
    const first = await overview({ limit: 1 }), second = await overview({ limit: 1, after: first.pagination.nextCursor });
    assert.equal(first.pagination.hasMore, true); assert.equal(second.pagination.hasMore, false);
    assert.equal(new Set([...first.sources,...second.sources].map(row => row.id)).size, 2);
    assert.equal(first.totals.subscriptionRevenueCents, second.totals.subscriptionRevenueCents);
  });
  await check('Rejected foreign source edits leave exact USD total and type costs across pages', async () => {
    await setCost(oldSource.id, 'USD', 500); await setCost(newSource.id, 'USD', 700);
    await assert.rejects(() => setCost(newSource.id, 'EUR', 1700), /USD_CURRENCY_REQUIRED/);
    const result = await overview({ limit: 1 }); evidence.cases.usdCostsAfterRejectedEdit = result;
    assert.equal(result.totals.costCents, 1200); assert.equal(result.totals.costCurrency, 'USD');
    assert.equal(result.totals.costUnavailableReason, null);
    assert.equal(result.buckets[0].costCents, 1200); assert.equal(result.buckets[0].costUnavailableReason, null);
    const next = await overview({ limit: 1, after: result.pagination.nextCursor });
    assert.equal(next.totals.costCents, 1200); assert.equal(next.totals.costUnavailableReason, null);
  });
  await check('USD totals preserve known amounts and an explicit zero retracts only that source cost', async () => {
    await setCost(oldSource.id, 'USD', 500); await setCost(newSource.id, 'USD', 700);
    let result = await overview(); assert.equal(result.totals.costCents, 1200); assert.equal(result.totals.costCurrency, 'USD');
    assert.equal(result.totals.costUnavailableReason, null); assert.equal(result.buckets[0].costCents, 1200); assert.equal(result.buckets[0].costCurrency, 'USD');
    await setCost(oldSource.id, 'USD', 0); result = await overview();
    assert.equal(result.totals.costCents, 700); assert.equal(result.totals.costCurrency, 'USD');
    await setCost(newSource.id, 'USD', 0); result = await overview();
    assert.equal(result.totals.costCents, 0); assert.equal(result.totals.costCurrency, 'USD');
  });
  await check('A blank currency is rejected by command and database admission without changing known USD zero', async () => {
    // Historical unsupported quarantine is seeded before migration in the
    // USD cutover audit. New invalid writes must not bypass this SQL guard.
    const { payloads } = require(path.join(root, 'src/services/human-control-command-contract'));
    assert.equal(payloads['traffic.cost'].safeParse({ sourceId: oldSource.id, expectedRevision: 1, costCents: 500, currency: '' }).success, false);
    await assert.rejects(() => setCost(oldSource.id, '', 500), /USD_CURRENCY_REQUIRED/);
    const result = await overview(); evidence.cases.rejectedBlankCurrency = result;
    const source = result.sources.find(row => row.id === oldSource.id);
    assert.equal(source.costCents, 0); assert.equal(source.costCurrency, 'USD'); assert.equal(source.roiUnavailableReason, 'NO_COST');
    assert.equal(result.totals.costCents, 0); assert.equal(result.totals.costUnavailableReason, null);
    assert.equal(result.buckets[0].costCents, 0); assert.equal(result.buckets[0].costUnavailableReason, null);
  });
  await check('Unsupported cost witnesses use the installer-owned partial index for total and type scopes', async () => {
    await setCost(oldSource.id, 'USD', 500); await setCost(newSource.id, 'USD', 700);
    currencyQueries.length = 0; await overview(); assert.equal(currencyQueries.length, 2);
    const indexState = await require(path.join(root, 'scripts/database/analytics-traffic-indexes')).ensureIndexes(db);
    const [currencyIndex] = await db.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname='TrafficSource_unsupported_usd_idx'`);
    assert.match(currencyIndex?.indexdef || '', /currency IS DISTINCT FROM 'USD'/);
    const plans = [];
    await write(async tx => {
      // A two-row fixture naturally favors a sequential scan. This verifies
      // the real parameterized query's indexed path, not production load.
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan=off');
      for (const { query, params } of currencyQueries) {
        assert.match(query, /currency IS DISTINCT FROM 'USD'/);
        const result = await tx.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + query, ...params);
        plans.push(result[0]['QUERY PLAN']);
      }
    });
    for (const plan of plans) assert.match(JSON.stringify(plan), /TrafficSource_unsupported_usd_idx/);
    evidence.cases.currencyIndexPlans = { indexState, currencyIndex, forcedIndexedPath: true, plans };
  });
  await check('Campaign projection completion retains missing provider proof and does not certify revenue as zero', async () => {
    await drainCampaigns();
    const result = await campaignReads.readCampaignPage({ db, creatorId: scope.creatorId, rangeKey: 'all' }); evidence.cases.campaign = result;
    assert.equal(result.projection.ready, true); assert.equal(result.totals.memberships, 2); assert.equal(result.totals.uniqueFans, 1);
    assert.equal(result.totals.netCents, null); assert.equal(result.sourceCoverage.revenue.reason, 'FINANCIAL_BASELINE_MISSING');
  });
  const moneyEarly = prefix + '-money-early', moneyLate = prefix + '-money-late';
  const campaignPage = (extra = {}) => campaignReads.readCampaignPage({ db, creatorId: scope.creatorId, rangeKey: 'all', ...extra });
  await check('Campaign money follows arrival at payment time independently of firstSeenAt and source recollection time', async () => {
    await write(tx => tx.creatorFinancialTransaction.createMany({ data: [
      { id: moneyEarly, externalTransactionId: 'early', amountCents: 100, netCents: 80, occurredAt: ago(8) },
      { id: moneyLate, externalTransactionId: 'late', amountCents: 200, netCents: 160, occurredAt: ago(2) },
    ].map(item => ({ ...item, creatorId: scope.creatorId, agencyId: scope.agencyId, fanRecordId: fan, transactionType: 'tip', transactionStatus: 'done' })) }));
    await drainCampaigns();
    const result = await campaignPage(); evidence.cases.campaignPayments = result;
    assert.equal(result.totals.knownNetCents, 240); assert.equal(result.totals.transactionsCount, 2);
    assert.equal(result.rows.find(row => row.id === oldCampaign).knownNetCents, 80);
    assert.equal(result.rows.find(row => row.id === newCampaign).knownNetCents, 160);
    const recent = await campaignPage({ rangeKey: '7d' }); assert.equal(recent.totals.knownNetCents, 160); assert.equal(recent.totals.transactionsCount, 1);
    const fans = await campaignReads.readCampaignFanPage({ db, creatorId: scope.creatorId, campaignId: newCampaign, rangeKey: '7d', filter: 'PAYING' });
    assert.equal(fans.fans.length, 1); assert.equal(fans.fans[0].revenue.knownNetCents, 160);
    assert(+new Date(fans.fans[0].fan.firstSeenAt) > +new Date(fans.fans[0].attributedAt));
    assert.equal(fans.fans[0].fan.onlyFansUserId, '9007199254740993');
  });
  await check('Earlier membership correction moves existing Campaign revenue once and idempotent replay does not grow totals', async () => {
    await write(tx => tx.creatorCampaignFan.update({ where: { id: prefix + '-membership-1' }, data: { attributedAt: ago(9) } }));
    await drainCampaigns(); let result = await campaignPage();
    assert.equal(result.rows.find(row => row.id === oldCampaign).knownNetCents, 0);
    assert.equal(result.rows.find(row => row.id === newCampaign).knownNetCents, 240);
    await write(tx => tx.creatorCampaignFan.update({ where: { id: prefix + '-membership-1' }, data: { attributedAt: ago(9) } }));
    await drainCampaigns(); result = await campaignPage(); assert.equal(result.totals.knownNetCents, 240); assert.equal(result.totals.transactionsCount, 2);
  });
  await check('A corrected financial fan changes the Campaign payer page and converges across source, creator and value counts', async () => {
    const secondFan = prefix + '-fan-2';
    await write(async tx => {
      await tx.creatorFan.create({ data: { id: secondFan, agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserId: '9007199254740995' } });
      await tx.creatorCampaignFan.create({ data: { id: prefix + '-membership-2', agencyId: scope.agencyId, creatorId: scope.creatorId, campaignId: oldCampaign, fanRecordId: secondFan, attributedAt: ago(5) } });
      await tx.creatorFinancialTransaction.update({ where: { id: moneyLate }, data: { fanRecordId: secondFan } });
    });
    await drainCampaigns(); const result = await campaignPage();
    assert.equal(result.totals.knownNetCents, 240); assert.equal(result.totals.uniqueFans, 2); assert.equal(result.totals.memberships, 3);
    assert.equal(result.totals.platformReportedFanSpendCents, null); assert.equal(result.totals.knownPlatformReportedFanSpendCents, 9000);
    assert.equal(result.rows.find(row => row.id === oldCampaign).knownNetCents, 160);
    const oldFans = await campaignReads.readCampaignFanPage({ db, creatorId: scope.creatorId, campaignId: oldCampaign, rangeKey: '7d', filter: 'PAYING', limit: 1 });
    const newFans = await campaignReads.readCampaignFanPage({ db, creatorId: scope.creatorId, campaignId: newCampaign, rangeKey: '7d', filter: 'PAYING', limit: 1 });
    assert.deepEqual(oldFans.fans.map(row => row.fan.id), [secondFan]); assert.equal(newFans.fans.length, 0);
    const all = await campaignReads.readCampaignFanPage({ db, creatorId: scope.creatorId, campaignId: oldCampaign, rangeKey: 'all', filter: 'ALL', limit: 1 });
    assert.equal(all.pagination.hasMore, true);
    const next = await campaignReads.readCampaignFanPage({ db, creatorId: scope.creatorId, campaignId: oldCampaign, rangeKey: 'all', filter: 'ALL', limit: 1, cursor: all.pagination.nextCursor });
    assert.equal(next.pagination.hasMore, false); assert.notEqual(all.fans[0].fan.id, next.fans[0].fan.id);
    await assert.rejects(() => campaignReads.readCampaignFanPage({ db, creatorId: scope.creatorId, campaignId: oldCampaign, rangeKey: '7d', filter: 'ALL', limit: 1, cursor: all.pagination.nextCursor }), error => error.code === 'CAMPAIGN_CURSOR_SCOPE_MISMATCH');
  });
  await check('Campaign amount correction, unknown NET, known zero and undo retract old metric contributions', async () => {
    await write(tx => tx.creatorFinancialTransaction.update({ where: { id: moneyLate }, data: { netCents: null } })); await drainCampaigns();
    let result = await campaignPage(); assert.equal(result.totals.knownNetCents, 80); assert.equal(result.totals.unknownNetTransactions, 1);
    await write(tx => tx.creatorFinancialTransaction.update({ where: { id: moneyLate }, data: { netCents: 0 } })); await drainCampaigns();
    result = await campaignPage(); assert.equal(result.totals.knownNetCents, 80); assert.equal(result.totals.unknownNetTransactions, 0); assert.equal(result.totals.transactionsCount, 2);
    await write(tx => tx.creatorFinancialTransaction.update({ where: { id: moneyLate }, data: { transactionStatus: 'undo' } })); await drainCampaigns();
    result = await campaignPage(); assert.equal(result.totals.knownNetCents, 80); assert.equal(result.totals.transactionsCount, 1);
  });
  evidence.ok = evidence.checks.every(row => row.ok);
  if (output) fs.writeFileSync(output, JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? String(value) : value, 2));
  if (!evidence.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => db.$disconnect());
