'use strict';
// Read-boundary proof against installed native PostgreSQL. The persisted
// projections below are explicit fixtures; production SQL and DTO construction
// are executed unchanged. Money reconciliation/HTTP ownership have separate
// integration proofs and are not inferred from these seeded projections.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

async function runTeamReadsProof({ db, backendRoot = path.resolve(__dirname, '../..') }) {
  const load = createRequire(path.join(backendRoot, 'package.json'));
  const { runRootCommit } = load('./src/services/db-commit-kernel');
  const now = new Date((await db.$queryRawUnsafe('SELECT clock_timestamp() AS now'))[0].now);
  const when = new Date(now.getTime() - 3_600_000);
  const day = new Date(when); day.setUTCHours(0, 0, 0, 0);
  const agencyId = 'team215-reads';
  const creatorA = 'team215-creator-a', creatorB = 'team215-creator-b';
  const memberIds = ['mixed', 'removed', 'single', 'no-messages'].map(id => `team215-${id}`);
  const [mixed, removed, single, noMessages] = memberIds;
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
      { agencyId, memberId: single, creatorKey: creatorA, creatorId: creatorA, day, messagesSent: 2 },
    ] });
    for (const [id, memberId, creatorId, currency, amountCents, active, occurredAt] of [
      ['mixed-usd', mixed, creatorA, 'USD', 1001, true, when],
      ['mixed-second-usd', mixed, creatorA, 'USD', 1999, true, when],
      ['other-creator', mixed, creatorB, 'USD', 3333, true, when],
      ['removed-usd', removed, creatorA, 'USD', 511, true, when],
      ['removed-second-usd', removed, creatorA, 'USD', 722, true, when],
      ['single', single, creatorA, 'USD', 803, true, when],
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

  const sql = [];
  const reads = new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === '$queryRawUnsafe') return (...args) => { sql.push(String(args[0])); return value.apply(target, args); };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const prismaPath = load.resolve('./src/prisma');
  const oldPrisma = require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: reads };
  const service = load('./src/services/team-analytics-service');
  const checks = [];
  const check = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected); checks.push({ name, ok: true }); }
    catch { checks.push({ name, ok: false, actual, expected }); }
  };
  try {
    const snapshot = await service.buildTeamAnalyticsSnapshot({ agencyId, rangeKey: '7d', includeMoney: true, allowedCreatorIds: [creatorA] });
    const rows = new Map(snapshot.members.map(row => [row.member.id, row]));
    const metric = rows.get(mixed).metrics;
    check('canonical USD gross and no refunded/out-of-range/cross-creator amount', metric.revenueByCurrency, { USD: 3000 });
    check('supported USD manual efficiency uses exact gross', metric.dollarsPerMessageCents, 750);
    check('positive revenue with no manual denominator is unknown', rows.get(noMessages).metrics.dollarsPerMessageCents, null);
    check('single USD manual efficiency retains its currency', { cents: rows.get(single).metrics.dollarsPerMessageCents, currency: rows.get(single).metrics.revenueCurrency }, { cents: 402, currency: 'USD' });
    check('top dialog carries canonical USD gross', metric.topDialogSessions.map(row => ({ creatorId: row.accountId, money: row.shiftRevenueByCurrency, cents: row.shiftRevenueCents })),
      [{ creatorId: creatorA, money: { USD: 3000 }, cents: 3000 }]);
    check('removed member with only USD tips remains historical', rows.get(removed)?.metrics.revenueByCurrency ?? null, { USD: 1233 });
    check('overview includes historical removed-member USD amounts', snapshot.overview.revenueByCurrency, { USD: 5286 });
    check('response denominator excludes BACKLOG and HANDOFF', { count: metric.responseSamples, median: metric.medianResponseSeconds, sla5: metric.slaReply5mPct, sla15: metric.slaReply15mPct },
      { count: 2, median: 330, sla5: 50, sla15: 100 });
    const both = await service.buildTeamAnalyticsSnapshot({ agencyId, rangeKey: '7d', includeMoney: true, allowedCreatorIds: [creatorA, creatorB] });
    const bothMixed = both.members.find(row => row.member.id === mixed).metrics;
    check('same fan across two creators stays in separate dialog buckets', bothMixed.topDialogSessions.map(row => ({ creatorId: row.accountId, money: row.shiftRevenueByCurrency })),
      [{ creatorId: creatorA, money: { USD: 3000 } }, { creatorId: creatorB, money: { USD: 3333 } }]);
    sql.length = 0;
    const restricted = await service.buildTeamAnalyticsSnapshot({ agencyId, rangeKey: '7d', includeMoney: false, allowedCreatorIds: [creatorA] });
    const restrictedMetric = restricted.members.find(row => row.member.id === mixed).metrics;
    check('view without money capability omits every monetary value', {
      visible: restricted.moneyVisible, cents: restrictedMetric.revenueAttributedCents, currencies: restrictedMetric.revenueByCurrency,
      efficiency: restrictedMetric.dollarsPerMessageCents, dialogMoney: restrictedMetric.topDialogSessions.some(row => Object.keys(row).some(key => key.startsWith('shiftRevenue'))),
    }, { visible: false, cents: null, currencies: null, efficiency: null, dialogMoney: false });
    check('view without money capability does not query monetary SQL', sql.some(query => /TeamMoney|CreatorSale|CreatorTip|FinancialTransaction/.test(query)), false);
    const today = await service.buildTeamAnalyticsSnapshot({ agencyId, rangeKey: '24h', includeMoney: false, allowedCreatorIds: [creatorA] });
    check('Today remains a rolling 24-hour contract', new Date(today.range.endAt).getTime() - new Date(today.range.startAt).getTime(), 86_400_000);

    // Exercise the installed canonical trigger: distinct transport observations
    // still share one business contribution, first actor and first timestamp.
    await runRootCommit(db, async ({ tx }) => {
      const add = async (id, values = {}) => tx.teamActivityEvent.create({ data: {
        id: `read215-event-${id}`, agencyId, memberId: mixed, creatorId: creatorA, accountId: creatorA,
        type: 'message_sent', eventKind: 'MESSAGE_SEND_CONFIRMED', source: 'electron_team_v13',
        actionSource: 'MANUAL', lifecycle: 'CONFIRMED', messageId: 'read215-message', dialogId: 'same-fan',
        fanId: 'same-fan', localId: id, ts: when, ...values,
      } });
      await add('legacy-local');
      await add('scoped-local-v2', { memberId: single, ts: new Date(when.getTime() + 10_000) });
      await add('original-outside-24h', { messageId: 'read215-outside-message', ts: new Date(now.getTime() - 25 * 3_600_000) });
      await add('replay-inside-24h', { messageId: 'read215-outside-message', memberId: single });
      await add('unkeyed', { messageId: null });
      await add('future', { messageId: 'read215-future', ts: new Date(now.getTime() + 3_600_000) });
      for (const [kind, contentId, mediaCount] of [['CONTENT_POST_PUBLISHED_CONFIRMED', 'post-one', 3], ['CONTENT_STORY_PUBLISHED_CONFIRMED', 'story-one', 2]]) {
        await add(`${contentId}-legacy`, { eventKind: kind, messageId: null, contentId, mediaCount });
        await add(`${contentId}-scoped`, { eventKind: kind, messageId: null, contentId, mediaCount, memberId: single });
      }
      await add('broadcast-legacy', { eventKind: 'BROADCAST_DISPATCH_CONFIRMED', messageId: null, broadcastDispatchId: 'dispatch-one' });
      await add('broadcast-scoped', { eventKind: 'BROADCAST_DISPATCH_CONFIRMED', messageId: null, broadcastDispatchId: 'dispatch-one', memberId: single });
      await add('broadcast-unconfirmed', { eventKind: 'BROADCAST_DISPATCH_CONFIRMED', messageId: null, broadcastDispatchId: 'dispatch-unconfirmed', lifecycle: 'PLANNED' });
      // Represents the existing retained baseline authority, independently of
      // whether its older transport row is still present in raw detail.
      for (const id of ['baseline-a', 'baseline-b']) await tx.teamActivityContribution.create({ data: { id: `read215-${id}`, agencyId, memberId: single,
        creatorId: creatorA, creatorKey: creatorA, eventKind: 'MESSAGE_SEND_CONFIRMED', semanticKey: `${creatorA}:message:${id}`,
        state: 'APPLIED_BASELINE', day, sourceEventAt: when, messagesSent: 1 } });
    });
    const exact = await service.buildTeamAnalyticsSnapshot({ agencyId, rangeKey: '24h', includeMoney: false, allowedCreatorIds: [creatorA] });
    const exactRows = new Map(exact.members.map(row => [row.member.id, row.metrics]));
    check('24h uses first-actor contributions and excludes unkeyed/outside-window replays', {
      first: exactRows.get(mixed).messagesSent, other: exactRows.get(single).messagesSent,
      posts: exactRows.get(mixed).postsCreated, stories: exactRows.get(mixed).storiesCreated,
      content: exactRows.get(mixed).contentActions, media: exactRows.get(mixed).contentMediaItemsPublished,
      dispatches: exactRows.get(mixed).broadcastDispatches, otherContent: exactRows.get(single).contentActions,
      otherDispatches: exactRows.get(single).broadcastDispatches,
    }, { first: 1, other: 2, posts: 1, stories: 1, content: 2, media: 5, dispatches: 1, otherContent: 0, otherDispatches: 0 });
    check('ready contribution history remains explicitly complete', exact.projection.historical.families.manualActivity.status, 'FULL');
    await db.phase2WorkCoverage.updateMany({ where: { agencyId, family: 'TEAM_ACTIVITY_CONTRIBUTION' },
      data: { active: false, enumerationState: 'RUNNING', unresolvedCount: 1 } });
    await db.teamHistoricalAnalyticsCoverage.update({ where: { agencyId }, data: { activityContributionCutoverAt: when } });
    const partial = await service.buildTeamAnalyticsSnapshot({ agencyId, rangeKey: '24h', includeMoney: false, allowedCreatorIds: [creatorA] });
    check('incomplete legacy contribution coverage stays partial with known values', {
      manual: partial.projection.historical.families.manualActivity.status,
      content: partial.projection.historical.families.content.status,
      unresolved: partial.projection.historical.families.manualActivity.unresolvedContributions,
      observed: partial.members.find(row => row.member.id === mixed).metrics.messagesSent,
    }, { manual: 'PARTIAL', content: 'PARTIAL', unresolved: 1, observed: 1 });
    return { ok: checks.every(item => item.ok), backendRoot, checks };
  } finally {
    if (oldPrisma) require.cache[prismaPath] = oldPrisma; else delete require.cache[prismaPath];
  }
}

module.exports = { runTeamReadsProof };
if (require.main === module) (async () => {
  const backendRoot = process.env.NOD_NATIVE_BACKEND_ROOT || path.resolve(__dirname, '../..');
  const fixture = require(process.env.NOD_TEAM_NATIVE_FIXTURE);
  const runtime = await fixture.createNativeRuntime();
  try {
    const result = await runTeamReadsProof({ db: runtime.db, backendRoot });
    if (process.env.NOD_AUDIT_NATIVE_OUTPUT) fs.writeFileSync(path.join(process.env.NOD_AUDIT_NATIVE_OUTPUT, 'team-reads-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
