"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withHeartbeatMemberGeneration } = require("./device-heartbeat-generation-service");

function fakeDb(member) {
  const calls = [];
  const tx = {
    $queryRawUnsafe: async (sql, ...args) => { calls.push(["lock", sql, args]); return [{ id: member?.id || null }]; },
    agencyMember: { findFirst: async () => { calls.push(["member"]); return member; } },
  };
  return {
    calls,
    $transaction: async (work) => { calls.push(["begin"]); try { const value = await work(tx); calls.push(["commit"]); return value; } catch (error) { calls.push(["rollback"]); throw error; } },
  };
}

test("heartbeat generation fence locks current member before revision-sensitive work", async () => {
  const db = fakeDb({ id: "member-1", agencyId: "agency-1", userId: "user-1", accessEpoch: 7 });
  let workRuns = 0;
  const result = await withHeartbeatMemberGeneration({
    db, agencyId: "agency-1", userId: "user-1", memberId: "member-1", expectedAccessEpoch: 7,
    work: async ({ accessEpoch }) => { workRuns += 1; return accessEpoch; },
  });
  assert.equal(result, 7);
  assert.equal(workRuns, 1);
  assert.deepEqual(db.calls.map((entry) => entry[0]), ["begin", "lock", "member", "commit"]);
  assert.match(db.calls[1][1], /FOR SHARE/);
  assert.doesNotMatch(db.calls[1][1], /deletedAt|deactivatedAt/, 'identity row must be locked even while inactive so reactivation cannot appear between lock and current-state read');
});

test("heartbeat generation fence rejects stale expected accessEpoch before work", async () => {
  const db = fakeDb({ id: "member-1", agencyId: "agency-1", userId: "user-1", accessEpoch: 8 });
  let workRuns = 0;
  await assert.rejects(
    withHeartbeatMemberGeneration({
      db, agencyId: "agency-1", userId: "user-1", memberId: "member-1", expectedAccessEpoch: 7,
      work: async () => { workRuns += 1; },
    }),
    (error) => error?.code === "DEVICE_HEARTBEAT_ACCESS_EPOCH_STALE",
  );
  assert.equal(workRuns, 0);
  assert.equal(db.calls.at(-1)[0], "rollback");
});

test("heartbeat generation fence rejects disappeared member before work", async () => {
  const db = fakeDb(null);
  let workRuns = 0;
  await assert.rejects(
    withHeartbeatMemberGeneration({
      db, agencyId: "agency-1", userId: "user-1",
      work: async () => { workRuns += 1; },
    }),
    (error) => error?.code === "DEVICE_HEARTBEAT_MEMBER_STALE",
  );
  assert.equal(workRuns, 0);
});
