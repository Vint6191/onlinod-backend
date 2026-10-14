"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");
const authority = require("./domain-work-authority-service");
const release = require("./database-write-contract-service");
const busy = () => Object.assign(new Error("Raw query failed"), { code: "P2010",
  meta: { code: "55P03", message: "PHASE2_CREATOR_LIFECYCLE_BUSY agency=a creator=busy table=DomainWorkItem" } });

// Inject the production Prisma error at the physical UPDATE, after preceding
// short transactions have committed. This tests rollback ownership, not a mock
// that makes the whole multi-tranche batch artificially atomic.
function fixture({ failure = busy(), shards = [1, 2, 3], missingLocator = false } = {}) {
  const now = new Date(), committed = [], rolledBack = [], selections = [], attempts = [];
  let selected = null, pending = null, fail = true, txNo = 0;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    async $transaction(work) {
      const number = ++txNo; pending = null;
      try {
        const result = await work({ ...db, $transaction: undefined });
        if (pending) committed.push(pending);
        return result;
      } catch (error) { rolledBack.push(number); throw error; }
    },
    async $queryRawUnsafe(sql, ...params) {
      if (sql.includes('FROM "DomainWorkClaimTopologyState"') && sql.includes('FOR SHARE'))
        return [{ generation: authority.DOMAIN_WORK_CLAIM_TOPOLOGY_ID, activationState: 'ACTIVE' }];
      if (sql.includes('FROM "Phase2ReleaseCompatibilityAuthority"') && sql.includes('FOR SHARE'))
        return [{ requiredGeneration: release.DOMAIN_WORK_EXECUTOR_GENERATION, activationState: 'ACTIVE' }];
      if (sql.includes('set_config')) return [];
      if (sql.trim() === 'SELECT clock_timestamp() AS "authorityNow"') return [{ authorityNow: now }];
      if (sql.includes('UPDATE "DomainWorkClaimAgencyState"')) return [{ agencyId: 'a' }];
      if (sql.includes('UPDATE "DomainWorkClaimShardState"')) {
        const excluded = params.slice(4);
        selected = shards.find(shard => !excluded.includes(shard) && !committed.some(row => row.shard === shard));
        selections.push({ selected, excluded });
        return selected == null ? [] : [{ claimShard: selected }];
      }
      if (sql.includes('SELECT f."partitionKey"')) return missingLocator ? [] : [{ partitionKey: `creator-${selected}` }];
      if (sql.includes('UPDATE "DomainWorkItem"')) {
        const shard = sql.includes('WITH scoped_creators') ? 2 : selected;
        attempts.push(shard);
        pending = { id: `work-${shard}`, shard, ownerToken: 'worker', agencyId: 'a' };
        if (shard === 2 && fail) throw failure;
        return [pending];
      }
      return [];
    },
  };
  return { db: commitDatabaseFixture(db), committed, rolledBack, selections, attempts, unlock() { fail = false; } };
}
const claim = f => authority.claimDomainWorkBatch({ db: f.db, agencyId: 'a', workClass: authority.WORK_CLASS.CAMPAIGN_VALUE,
  ownerToken: 'worker', limit: 3, perAgencyQuantum: 3, perPartitionQuantum: 1 });

for (const missingLocator of [false, true]) test(`busy creator preserves earlier claims and admits later shard (physical repair=${missingLocator})`, async () => {
  const f = fixture({ missingLocator });
  const result = await claim(f);
  assert.deepEqual(result.items.map(row => row.id), ['work-1', 'work-3']);
  assert.deepEqual(f.committed.map(row => row.id), ['work-1', 'work-3']);
  assert.equal(f.rolledBack.length, 1);
  assert.deepEqual(f.attempts, [1, 2, 3]);
  assert.ok(f.selections.some(row => row.selected === 3 && row.excluded.includes(2)));
  f.unlock();
  assert.deepEqual((await claim(f)).items.map(row => row.id), ['work-2'], 'next pump retries rolled-back work');
});

test('a fully contended shard returns promptly without claiming or quarantining work', async () => {
  const f = fixture({ shards: [2] });
  assert.deepEqual((await claim(f)).items, []);
  assert.deepEqual(f.attempts, [2]);
  assert.equal(f.committed.length, 0);
});

test('creator-scoped atomic claim retries lifecycle contention on the next pump', async () => {
  const f = fixture();
  const input = { db: f.db, agencyId: 'a', creatorIds: ['busy'], workClass: authority.WORK_CLASS.CAMPAIGN_VALUE, ownerToken: 'worker' };
  const result = await authority.claimDomainWorkBatch(input);
  assert.equal(result.reason, 'creator_lifecycle_contended');
  assert.equal(f.committed.length, 0);
  f.unlock();
  assert.equal((await authority.claimDomainWorkBatch(input)).items.length, 1);
});

for (const failure of [Object.assign(new Error('lock_timeout'), { code: '55P03' }),
  Object.assign(new Error('PHASE2_CREATOR_DELETED'), { code: 'P2010', meta: { code: 'P0001' } }),
  Object.assign(new Error('PHASE2_CREATOR_LIFECYCLE_BUSY'), { code: 'XX000' })]) {
  test(`unrelated database error remains visible: ${failure.message}/${failure.code}`, async () => {
    const f = fixture({ failure, shards: [2] });
    await assert.rejects(claim(f), error => error === failure);
    assert.equal(f.committed.length, 0);
  });
}
