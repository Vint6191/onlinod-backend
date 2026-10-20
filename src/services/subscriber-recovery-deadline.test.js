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
  assert.ok(options[0].timeout >= 44_900 && options[0].timeout <= 45_000);
  assert.equal(options[0].maxWait, 1_000);
});

test('a failed durable wake cannot mark a published run as handed off', async () => {
  let markers = 0;
  const db = { $queryRawUnsafe: async sql => { if (sql.includes('INSERT INTO')) throw closed; return [{ authorityNow: new Date() }]; },
    subscriberDirectoryState: { findUnique: async () => ({ currentRunId: 'r', publishedGeneration: 1 }) },
    subscriberScanRun: { update: async () => { markers++; } } };
  await assert.rejects(service._test.ensureSubscriberDerivedPlanningWake(db, {
    id: 'r', agencyId: 'a', creatorId: 'c', status: 'PUBLISHED', publicationStatus: 'COMPLETE', publicationGeneration: 1,
  }), { code: 'P2028' });
  assert.equal(markers, 0);
});

test('generation repair does not treat a database failure as absent state', async () => {
  let creates = 0;
  const db = { $queryRawUnsafe: async () => [{ maxGeneration: 1, maxPublishedGeneration: 0 }],
    subscriberDirectoryState: { findUnique: async () => { throw closed; }, create: async () => { creates++; } } };
  await assert.rejects(service.repairSubscriberDirectoryStateGeneration({ db, agencyId: 'a', creatorId: 'c' }), { code: 'P2028' });
  assert.equal(creates, 0);
});

test('fractional remaining pump time is admitted by the strict commit kernel', async () => {
  const options = [];
  const tx = {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async sql => sql.includes('AS "authorityNow"') ? [{ authorityNow: new Date() }] : [],
  };
  const db = { $transaction: async (work, opt) => { options.push(opt); return work(tx); } };
  const { claimSubscriberDirectoryMaintenanceSignal } = require('./subscriber-directory-maintenance-signal-service');
  const result = await claimSubscriberDirectoryMaintenanceSignal({ db, statementTimeoutMs: 743.912345 });
  assert.equal(result, null);
  assert.equal(options.length, 1, 'the fractional soft clock must reach SQL admission instead of failing option validation');
  assert.ok(Number.isInteger(options[0].maxWait) && Number.isInteger(options[0].timeout));
  assert.equal(options[0].maxWait, 5000);
  assert.ok(options[0].timeout >= 14900 && options[0].timeout <= 15000);
});

for (const failedRead of ['existing publication job', 'directory state', 'newest generation']) {
  test(`subscriber scheduling preserves the original database failure when reading ${failedRead}`, async () => {
    const fault = Object.assign(new Error('Timed out fetching a new connection from the connection pool.'), { code: 'P2024' });
    let runReads = 0, creates = 0;
    const tx = {
      $executeRawUnsafe: async () => 1,
      $queryRawUnsafe: async sql => sql.includes('INSERT INTO "SubscriberDirectoryMaintenanceSignal"')
        ? [{ id: 'repair-signal' }] : [{ authorityNow: new Date() }],
      subscriberScanRun: {
        findFirst: async () => {
          runReads++;
          if (runReads === 1 && failedRead === 'existing publication job') return { id: 'debt', jobId: 'job' };
          if (runReads === 3 && failedRead === 'newest generation') throw fault;
          return null;
        },
        create: async () => { creates++; throw Error('scheduling must stop before creating a replacement'); },
      },
      subscriberDirectoryState: { findUnique: async () => {
        if (failedRead === 'directory state') throw fault;
        return null;
      } },
      jobInstance: { findUnique: async () => { throw fault; } },
    };
    const db = { $queryRawUnsafe: tx.$queryRawUnsafe, $transaction: async work => work(tx) };
    await assert.rejects(service.scheduleSubscriberScan({ db, agencyId: 'agency', creatorId: 'creator' }), error => error === fault);
    assert.equal(creates, 0, 'a failed authority read is not permission to replace the current scan');
  });
}


test('absolute recollection retry preserves the database deadline despite application clock skew', async () => {
  const at = new Date('2026-10-20T12:00:00Z'), retryAt = new Date(+at + 120000);
  let stored;
  const db = { $queryRawUnsafe: async () => [{ authorityNow: at }],
    $executeRawUnsafe: async (_sql, ...args) => { stored = args[2]; return 1; } };
  const { releaseSubscriberDirectoryMaintenanceSignal } = require('./subscriber-directory-maintenance-signal-service');
  const originalNow = Date.now;
  try {
    Date.now = () => +at + 3600000;
    await releaseSubscriberDirectoryMaintenanceSignal({ db, signal: { id: 'signal', claimToken: 'owner', revision: 1 }, retryAt });
  } finally { Date.now = originalNow; }
  assert.equal(+stored, +retryAt);
});
