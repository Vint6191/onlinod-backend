'use strict';
// Actual current-schema SQL and heartbeat service; synthetic provider waiters.
const assert = require('node:assert/strict');
const { fixture, scope } = require('./analytics-traffic/fixture.cjs');
const { heartbeatDurableProviderWaiters } = require('../../src/services/provider-request-credit-authority-service');
const keep = setInterval(() => {}, 1000);

async function main() {
  const f = await fixture();
  try {
    const { db } = f;
    const current = await scope(db);
    await db.$executeRawUnsafe(`INSERT INTO "OfProviderRequestGateWaiter"
      ("waiterId","ownerInstanceId","agencyId","creatorId","deviceId",capability,priority,category,operation,"leaseUntil")
      SELECT 'waiter-'||n,'replica-a',$1,$2,'device-'||(n%100),'read','background','background_other','earnings.chart','2099-01-01'::timestamp
      FROM generate_series(0,5000) n`, current.agencyId, current.creatorId);
    await db.$executeRawUnsafe(`INSERT INTO "OfProviderRequestGateWaiter"
      ("waiterId","ownerInstanceId","agencyId","creatorId","deviceId",capability,priority,category,operation,"leaseUntil") VALUES
      ('foreign-waiter','replica-b',$1,$2,'device-b','read','normal','default','earnings.chart','2099-01-01'),
      ('expired-waiter','replica-a',$1,$2,'device-a','read','normal','default','earnings.chart','2000-01-01')`, current.agencyId, current.creatorId);
    const before = await db.$queryRawUnsafe(`SELECT "waiterId",ticket FROM "OfProviderRequestGateWaiter" ORDER BY ticket`);
    const ids = Array.from({ length: 5001 }, (_, index) => `waiter-${index}`);
    const result = await heartbeatDurableProviderWaiters({ db, ownerInstanceId: 'replica-a', waiterIds: [...ids, 'foreign-waiter', 'expired-waiter'] });
    assert.equal(result.touched, 5001);
    const [counts] = await db.$queryRawUnsafe(`SELECT
      count(*) FILTER (WHERE "waiterId" LIKE 'waiter-%' AND "leaseUntil">clock_timestamp() AT TIME ZONE 'UTC'
        AND "leaseUntil"<(clock_timestamp() AT TIME ZONE 'UTC')+interval '21 seconds') AS renewed,
      count(*) FILTER (WHERE "waiterId"='waiter-5000' AND "leaseUntil"<'2099-01-01') AS tail,
      count(*) FILTER (WHERE "waiterId"='foreign-waiter' AND "leaseUntil"='2099-01-01') AS foreign_untouched,
      count(*) FILTER (WHERE "waiterId"='expired-waiter' AND "leaseUntil"='2000-01-01') AS expired_untouched
      FROM "OfProviderRequestGateWaiter"`);
    assert.equal(Number(counts.renewed), 5001);
    assert.equal(Number(counts.tail), 1);
    assert.equal(Number(counts.foreign_untouched), 1);
    assert.equal(Number(counts.expired_untouched), 1);
    const after = await db.$queryRawUnsafe(`SELECT "waiterId",ticket FROM "OfProviderRequestGateWaiter" ORDER BY ticket`);
    assert.deepEqual(after, before, 'heartbeat must preserve the durable FIFO tickets');
    console.log('PASS actual SQL renews all 5,001 live waiters, including the former tail; foreign and expired rows untouched; FIFO preserved');
  } finally { await f.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keep));
