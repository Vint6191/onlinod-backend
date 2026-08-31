"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertExecutionAccessFence } = require('./execution-access-fence-service');

function dbFor(member, creator = { id: 'creator-a', status: 'READY' }) {
  return {
    agencyMember: { findFirst: async () => member },
    creatorAccount: { findFirst: async () => creator },
  };
}

const baseMember = {
  id: 'member-a', userId: 'user-a', agencyId: 'agency-a', role: 'CHATTER', roleKey: 'chatter',
  accessEpoch: 7, assignedCreators: ['creator-a'], deletedAt: null, deactivatedAt: null,
};

test('Audit13 execution access fence accepts exact member/epoch/creator grant', async () => {
  const result = await assertExecutionAccessFence({
    db: dbFor({ ...baseMember }), userId: 'user-a', agencyId: 'agency-a', memberId: 'member-a', accessEpoch: 7, creatorId: 'creator-a',
  });
  assert.equal(result.accessEpoch, 7);
});

test('Audit13 accessEpoch change invalidates an already claimed lease', async () => {
  await assert.rejects(() => assertExecutionAccessFence({
    db: dbFor({ ...baseMember, accessEpoch: 8 }), userId: 'user-a', agencyId: 'agency-a', memberId: 'member-a', accessEpoch: 7, creatorId: 'creator-a',
  }), (error) => error?.code === 'EXECUTION_ACCESS_EPOCH_STALE');
});

test('Audit13 creator assignment removal invalidates an already claimed lease', async () => {
  await assert.rejects(() => assertExecutionAccessFence({
    db: dbFor({ ...baseMember, assignedCreators: [] }), userId: 'user-a', agencyId: 'agency-a', memberId: 'member-a', accessEpoch: 7, creatorId: 'creator-a',
  }), (error) => error?.code === 'EXECUTION_CREATOR_ACCESS_REVOKED');
});

test('Audit13 transaction fence uses row lock when transaction raw query is available', async () => {
  const events = [];
  const db = {
    async $queryRawUnsafe() { events.push('FOR SHARE'); return [{ ...baseMember }]; },
    creatorAccount: { findFirst: async () => ({ id: 'creator-a', status: 'READY' }) },
  };
  await assertExecutionAccessFence({
    db, userId: 'user-a', agencyId: 'agency-a', memberId: 'member-a', accessEpoch: 7, creatorId: 'creator-a', lock: true,
  });
  assert.deepEqual(events, ['FOR SHARE']);
});
