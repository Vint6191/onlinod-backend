'use strict';
const assert = require('node:assert/strict');
const { createScaleSqlRuntime } = require('../test-support/scale-sql-runtime.cjs');
const { scope } = require('./analytics-traffic/fixture.cjs');
const alive = setInterval(() => {}, 1000);
(async () => {
  const runtime = await createScaleSqlRuntime();
  try {
    const { db } = runtime, s = await scope(db);
    require.cache[require.resolve('../../src/prisma')] = { exports: db };
    const { runRootCommit } = require('../../src/services/db-commit-kernel');
    const { projectEventFanIdentities } = require('../../src/services/fan-data-authority-service');
    const write = fn => runRootCommit(db, ({ tx }) => fn(tx), { profile: 'JOB_CHUNK' });
    const at = new Date('2026-10-23T09:00:00Z'), first = new Date('2025-01-01T00:00:00Z'), last = new Date('2025-02-01T00:00:00Z');
    const row = i => ({ agencyId: s.agencyId, creatorId: s.creatorId, onlyFansUserId: String(100000 + i), source: 'FINANCIAL_TRANSACTION',
      username: `fan-${i}`, avatarUrl: `https://images.test/${i}`, activityObservedAt: first });
    const page = Array.from({ length: 500 }, (_, i) => row(i));
    let mark = runtime.queries.length;
    const result = await write(tx => projectEventFanIdentities(tx, page, at));
    const queries500 = runtime.queries.slice(mark);
    assert.equal(result.fans.size, 500);
    assert.ok(queries500.length <= 20, `500 distinct fans require bounded SQL statements, got ${queries500.length}`);
    assert.equal(queries500.filter(row => /INSERT INTO "CreatorFan"/.test(row.query)).length, 1);
    for (const fan of result.fans.values()) {
      assert.equal(+fan.firstSeenAt, +first); assert.equal(+fan.lastActivityObservedAt, +first);
      assert.equal(+fan.identityObservedAt, +at);
    }
    // Four source pages used to be thousands of awaited ORM field writes. The
    // protocol2,000 limit remains, while SQL and lock round trips stay bounded.
    mark = runtime.queries.length;
    const all = await write(tx => projectEventFanIdentities(tx, Array.from({ length: 2000 }, (_, i) => row(i)), at));
    const queries2000 = runtime.queries.slice(mark);
    assert.equal(all.fans.size, 2000);
    assert.ok(queries2000.length <= 40, `2000 source participants got ${queries2000.length} SQL statements`);
    assert.equal(queries2000.filter(row => /INSERT INTO "CreatorFan"/.test(row.query)).length, 4);
    const hints = page.flatMap((item, i) => [{ ...item, avatarUrl: i === 0 ? 'conflict-A' : item.avatarUrl },
      { ...item, avatarUrl: i === 0 ? 'conflict-B' : item.avatarUrl, activityObservedAt: last }]);
    mark = runtime.queries.length;
    const merged = await write(tx => projectEventFanIdentities(tx, hints, new Date(+at + 1000)));
    assert.equal(merged.ambiguousFields, 1); assert.equal(merged.fans.size, 500);
    assert.ok(runtime.queries.length - mark <= 25, 'activity endpoints are batched, not3extra writesperfan');
    for (const fan of merged.fans.values()) {
      assert.equal(+fan.firstSeenAt, +first); assert.equal(+fan.lastActivityObservedAt, +last); assert.equal(+fan.lastSeenAt, +last);
    }
    const key = `${s.creatorId}\u0000${page[0].onlyFansUserId}`;
    assert.equal(merged.fans.get(key).avatarUrl, page[0].avatarUrl);
    const sameGeneration = await write(tx => projectEventFanIdentities(tx, [{ ...page[0], username: 'contradiction', platformDisplayName: 'New valid name' }], new Date(+at + 1000)));
    assert.equal(sameGeneration.ambiguousFields, 1); assert.equal(sameGeneration.fans.get(key).username, 'fan-0');
    assert.equal(sameGeneration.fans.get(key).displayName, 'New valid name');
    const older = new Date('2024-12-01T00:00:00Z');
    const stale = await write(tx => projectEventFanIdentities(tx, [{ ...page[0], username: 'stale', activityObservedAt: older }], new Date(+at - 1000)));
    assert.equal(stale.fans.get(key).username, 'fan-0'); assert.equal(+stale.fans.get(key).firstSeenAt, +older);
    assert.equal(+stale.fans.get(key).lastActivityObservedAt, +last);
    const other = await scope(db, { agencyId: 'other-agency', creatorId: 'other-creator', userId: 'other-user' });
    const separate = await write(tx => projectEventFanIdentities(tx, [{ ...page[0], ...other, username: 'other-owner' }, page[0]], new Date(+at + 2000)));
    assert.equal(separate.fans.size, 2);
    assert.equal(separate.fans.get(`${other.creatorId}\u0000${page[0].onlyFansUserId}`).username, 'other-owner');
    assert.equal(separate.fans.get(key).username, 'fan-0');
    await assert.rejects(write(tx => projectEventFanIdentities(tx, [...Array.from({ length: 2000 }, (_, i) => row(i)), row(2001)], at)), /Invalid event participant observation batch/);
    await assert.rejects(write(async tx => { await projectEventFanIdentities(tx, [{ ...row(2500), username: 'rollback' }], at); throw Error('FAIL_BEFORE_COMMIT'); }), /FAIL_BEFORE_COMMIT/);
    assert.equal(await db.creatorFan.count({ where: { creatorId: s.creatorId, onlyFansUserId: row(2500).onlyFansUserId } }), 0);
    console.log('EVENT_FAN_IDENTITY_BATCH_SCALE_PASS', JSON.stringify({ native: runtime.native, fans: 2000, queries500: queries500.length, queries2000: queries2000.length, ambiguity: true, activityEndpoints: true, scopeIsolation: true, rollback: true }));
  } finally { await runtime.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearInterval(alive));
