'use strict';
const assert = require('node:assert/strict');

// Pause a real SQL result, then let an independent request commit before the
// remaining reads. The writer promise is created outside the read transaction's
// async context, just as a separate HTTP request would be. No rows are mocked.
async function withConcurrentRead(h, scope, input, write, pattern = /SELECT\s+i\."fanId", i\."dialogId"/) {
  let release, intercepted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const writer = gate.then(started => started ? write() : null);
  const instrument = target => new Proxy(target, { get(obj, key) {
    if (key === '$transaction' && typeof obj.$transaction === 'function') {
      return (work, options) => obj.$transaction(tx => work(instrument(tx)), options);
    }
    if (key === '$queryRawUnsafe') return async (sql, ...args) => {
      const rows = await obj.$queryRawUnsafe(sql, ...args);
      if (!intercepted && pattern.test(sql)) { intercepted = true; release(true); await writer; }
      return rows;
    };
    const value = Reflect.get(obj, key);
    return typeof value === 'function' ? value.bind(obj) : value;
  } });
  try {
    const result = await h.subs.listHiddenOnline({ ...scope, ...input, db: instrument(h.db) });
    assert.equal(intercepted, true, 'Concurrency gate must intercept the actual page SELECT');
    return result;
  } finally { release(false); await writer; }
}

async function runSubscriberReadCases(h, check) {
  const summary = h.load('./src/services/published-subscriber-summary');
  const { readHomeCreatorPage } = h.load('./src/services/home-read-repository');
  const { readCreatorOverview } = h.load('./src/services/creator-overview-service');
  const { getAutomationOverview } = h.load('./src/services/follow-back-service');
  const { dbAuthorityNow } = h.load('./src/services/db-time-authority-service');
  const fan = (id, name, spend = 100) => ({ id, name, username: 'user' + id, lastSeen: null, totalSpentCents: spend });
  const publish = async (s, rows) => { const run = await h.start(s); await h.page(run, rows); return h.finish(run); };
  async function assertSurfaces(s, expected, fresh) {
    const now = await dbAuthorityNow({ db: h.db });
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const prior = new Date(+today - 86400000);
    const input = { db: h.db, agencyId: s.agencyId, member: s.member, billing: false, money: true, now,
      range: { startDay: today, endDay: today }, previous: { startDay: prior, endDay: prior } };
    const [status, list, creator, home, page, overview, automation] = await Promise.all([
      h.subs.getSubscriberDirectoryStatus(s), h.subs.listHiddenOnline({ ...s, status: 'all' }),
      summary.readCreatorAudience({ db: h.db, creatorId: s.creatorId, now }), summary.readHomeAudience(input),
      readHomeCreatorPage(input), readCreatorOverview({ db: h.db, creatorId: s.creatorId, rangeKey: '7d' }),
      getAutomationOverview(s),
    ]);
    const published = expected !== null;
    assert.equal(status.published, published); assert.equal(list.published, published);
    assert.equal(automation.subscriberDirectory?.published ?? false, published);
    assert.equal(status.fresh, fresh);
    assert.equal(creator.subscriberCount, expected); assert.equal(creator.stale, !fresh);
    assert.equal(home.totalSubscribers, expected); assert.equal(home.coverage.reportingCreators, Number(published));
    assert.equal(home.coverage.staleCreators, Number(published && !fresh));
    const card = page.creators.find(item => item.id === s.creatorId); assert.ok(card);
    assert.equal(card.subscriberCount, expected); assert.equal(card.subscribersStale, !fresh);
    assert.equal(overview.audience.subscriberCount, expected); assert.equal(overview.audience.stale, !fresh);
    if (published) assert.equal(list.state.totalCount, expected);
    return { status, list };
  }

  await check('Audience read surfaces agree on unknown, published, refresh, stopped refresh and proven empty', async () => {
    const s = await h.scope('read_lifecycle');
    await assertSurfaces(s, null, false);
    const initial = await h.start(s); await assertSurfaces(s, null, false);
    await h.page(initial, [fan('301', 'Alpha'), fan('302', 'Beta')]); await h.finish(initial);
    const published = await assertSurfaces(s, 2, true);
    const refresh = await h.start(s); await h.page(refresh, [fan('303', 'Unpublished')], { hasMore: true });
    const during = await assertSurfaces(s, 2, false);
    assert.equal(during.list.state.currentRunId, published.list.state.currentRunId);
    assert.deepEqual(during.list.items.map(item => item.fanId).sort(), ['301', '302']);
    await h.fail(refresh); await assertSurfaces(s, 2, false);
    await publish(s, []); const empty = await assertSurfaces(s, 0, true);
    assert.equal(empty.list.items.length, 0); assert.equal(empty.status.state.disappearedCount, 2);
    assert.equal(await h.db.creatorFan.count({ where: { creatorId: s.creatorId } }), 3, 'Empty source does not erase independent current facts');
  });

  await check('Audience search treats percent, underscore and backslash literally before pagination', async () => {
    const s = await h.scope('read_literal');
    await publish(s, [fan('401', 'Alpha_One'), fan('402', 'Rate%Value'), fan('403', 'Path\\Name'), fan('404', 'Plain')]);
    for (const [search, id] of [['_', '401'], ['%', '402'], ['\\', '403'], ['plain', '404']]) {
      const result = await h.subs.listHiddenOnline({ ...s, search, limit: 1 });
      assert.deepEqual(result.items.map(item => item.fanId), [id]); assert.equal(result.count, 1); assert.equal(result.hasMore, false);
    }
    const wrongAgency = await h.scope('read_wrong_agency');
    const absent = await h.subs.listHiddenOnline({ agencyId: wrongAgency.agencyId, creatorId: s.creatorId });
    assert.equal(absent.published, false); assert.equal(absent.count, 0); assert.equal(absent.state, null);
  });

  await check('Concurrent publication cannot mix search, ordering, totals or current profile between snapshots', async () => {
    const s = await h.scope('read_publication_race');
    const first = await publish(s, [fan('501', 'Alpha', 100), fan('502', 'Beta', 200)]);
    const filtered = await withConcurrentRead(h, s, { search: 'Alpha' },
      () => publish(s, [fan('501', 'Omega', 500), fan('502', 'Beta', 200)]));
    assert.equal(filtered.state.currentRunId, first.state.currentRunId);
    assert.deepEqual(filtered.items.map(item => [item.name, item.totalSpentCents]), [['Alpha', 100]]);
    assert.equal(filtered.count, 1);
    const second = await h.subs.listHiddenOnline({ ...s, search: 'Omega' }); assert.equal(second.count, 1);
    const ordered = await withConcurrentRead(h, s, { sort: 'spent_desc', limit: 1 },
      () => publish(s, [fan('501', 'Omega', 1), fan('502', 'Beta', 900)]));
    assert.deepEqual(ordered.items.map(item => [item.fanId, item.totalSpentCents]), [['501', 500]]);
    assert.equal(ordered.state.currentRunId, second.state.currentRunId);
    assert.equal(ordered.count, 2); assert.equal(ordered.hasMore, true);
    const current = await h.subs.listHiddenOnline({ ...s, sort: 'spent_desc', limit: 1 });
    assert.deepEqual(current.items.map(item => [item.fanId, item.totalSpentCents]), [['502', 900]]);
  });

  await check('Concurrent ignore changes remain atomic with the filtered page and its count', async () => {
    const s = await h.scope('read_override_race');
    await publish(s, [fan('601', 'One'), fan('602', 'Two')]);
    const before = await withConcurrentRead(h, s, { status: 'active' },
      () => h.subs.setHiddenOnlineStatus({ ...s, fanId: '601', status: 'ignored', db: h.db }));
    assert.equal(before.count, 2); assert.equal(before.items.length, 2);
    assert.ok(before.items.every(item => item.status === 'active'));
    const after = await h.subs.listHiddenOnline({ ...s, status: 'active' });
    assert.deepEqual(after.items.map(item => item.fanId), ['602']); assert.equal(after.count, 1);
    const ignored = await h.subs.listHiddenOnline({ ...s, status: 'ignored' });
    assert.deepEqual(ignored.items.map(item => item.fanId), ['601']); assert.equal(ignored.count, 1);
  });
}
module.exports = { runSubscriberReadCases };
