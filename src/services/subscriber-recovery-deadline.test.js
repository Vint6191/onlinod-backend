'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const original = Module._load;
let followingCalls = 0;
const closed = Object.assign(new Error('Transaction not found'), { code: 'P2028' });
Module._load = function (name, parent, main) {
  if (name === '../prisma') return {};
  if (name === './automation-write-commit-fence-service') return { lockAutomationWriteCommitFence: async () => {} };
  if (name === './follow-back-service') return { ensureAutomaticFollowBack: async () => { throw closed; } };
  if (name === './follow-automation-service') return { ensureAutomaticFollowAutomation: async () => { followingCalls++; return { ok: true }; } };
  if (name === './bump-service') return { ensureAutomaticBumps: async () => { followingCalls++; return { ok: true }; } };
  return original.call(this, name, parent, main);
};
const service = require('./subscriber-directory-service');
Module._load = original;

test('a small maintenance slice never shrinks an admitted recovery transaction to milliseconds', async () => {
  const options = [];
  const tx = { $executeRawUnsafe: async () => 1, $queryRawUnsafe: async sql => {
    if (sql.includes('maxGeneration')) return [{ maxGeneration: 0, maxPublishedGeneration: 0 }];
    return [{ authorityNow: new Date() }];
  }, subscriberScanRun: { findFirst: async () => null } };
  const db = { ...tx, $transaction: async (work, opt) => { options.push(opt); return work(tx); } };
  const r = await service.recoverSubscriberPublicationDebt({ db, agencyId: 'a', creatorId: 'c', maxRuntimeMs: 500 });
  assert.equal(r.ok, true); assert.equal(options.length, 1);
  assert.ok(options[0].timeout >= 14_900 && options[0].timeout <= 15_000);
  assert.equal(options[0].maxWait, 1_000);
});

test('closed maintenance transaction fails immediately; no subsequent planners run or report success', async () => {
  followingCalls = 0;
  await assert.rejects(service._test.planSubscriberDerivedAutomation({ run: { id: 'r', agencyId: 'a', creatorId: 'c' },
    db: {}, fencedMaintenance: true }), { code: 'P2028' });
  assert.equal(followingCalls, 0);
});

test('generation repair does not treat a database failure as absent state', async () => {
  let creates = 0;
  const db = { $queryRawUnsafe: async () => [{ maxGeneration: 1, maxPublishedGeneration: 0 }],
    subscriberDirectoryState: { findUnique: async () => { throw closed; }, create: async () => { creates++; } } };
  await assert.rejects(service.repairSubscriberDirectoryStateGeneration({ db, agencyId: 'a', creatorId: 'c' }), { code: 'P2028' });
  assert.equal(creates, 0);
});
