"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readCurrentDesktopMemberAuthority,
  withStableDesktopCurrentAccess,
} = require("./desktop-current-access-authority-service");

function member({ accessEpoch = 1, creatorIds = ["creator-a"] } = {}) {
  return {
    id: "member-1",
    userId: "user-1",
    agencyId: "agency-1",
    role: "MANAGER",
    roleKey: "manager",
    assignedCreators: creatorIds,
    accessEpoch,
  };
}

function fakeDb(sequence) {
  const rows = Array.from(sequence);
  const calls = [];
  return {
    calls,
    agencyMember: {
      async findFirst(args) {
        calls.push(args);
        if (!rows.length) throw new Error("fake authority sequence exhausted");
        return rows.shift();
      },
    },
  };
}

test("Desktop current-access authority requires live Member + User + Agency", async () => {
  const db = fakeDb([member()]);
  const row = await readCurrentDesktopMemberAuthority({
    db, agencyId: "agency-1", userId: "user-1", memberId: "member-1",
  });
  assert.equal(row.id, "member-1");
  const where = db.calls[0].where;
  assert.equal(where.deletedAt, null);
  assert.equal(where.deactivatedAt, null);
  assert.deepEqual(where.user, { is: { disabledAt: null } });
  assert.deepEqual(where.agency, { is: { deletedAt: null } });
});

test("stable desktop access discards work authorized by a Member snapshot revoked during the operation", async () => {
  const oldMember = member({ accessEpoch: 7, creatorIds: ["creator-old"] });
  const newMember = member({ accessEpoch: 8, creatorIds: ["creator-new"] });
  const db = fakeDb([oldMember, newMember, newMember, newMember]);
  const seen = [];
  const result = await withStableDesktopCurrentAccess({
    db,
    agencyId: "agency-1",
    userId: "user-1",
    memberId: "member-1",
    work: async (current) => {
      seen.push(current.accessEpoch);
      return current.assignedCreators[0];
    },
  });
  assert.deepEqual(seen, [7, 8]);
  assert.equal(result.value, "creator-new");
  assert.equal(result.member.accessEpoch, 8);
});

test("stable desktop access also retries when Creator catalog generation changes around authorization", async () => {
  const current = member({ accessEpoch: 9, creatorIds: ["creator-a"] });
  const db = fakeDb([current, current, current, current]);
  const generations = [11, 12, 12, 12];
  let workCalls = 0;
  const result = await withStableDesktopCurrentAccess({
    db,
    agencyId: "agency-1",
    userId: "user-1",
    memberId: "member-1",
    readGeneration: async () => generations.shift(),
    work: async () => { workCalls += 1; return "visible"; },
  });
  assert.equal(workCalls, 2);
  assert.equal(result.value, "visible");
  assert.equal(result.generation, 12);
});

test("stable desktop access fails closed when authority disappears after protected work", async () => {
  const db = fakeDb([member({ accessEpoch: 3 }), null]);
  await assert.rejects(
    () => withStableDesktopCurrentAccess({
      db,
      agencyId: "agency-1",
      userId: "user-1",
      memberId: "member-1",
      work: async () => "must-not-escape",
    }),
    (error) => error?.code === "DESKTOP_MEMBER_AUTHORITY_REVOKED" && error?.status === 403,
  );
});

test("stable desktop access fails retryably under continuous authority churn", async () => {
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    rows.push(member({ accessEpoch: i * 2 + 1 }), member({ accessEpoch: i * 2 + 2 }));
  }
  const db = fakeDb(rows);
  await assert.rejects(
    () => withStableDesktopCurrentAccess({
      db,
      agencyId: "agency-1",
      userId: "user-1",
      memberId: "member-1",
      maxAttempts: 3,
      work: async () => "stale",
    }),
    (error) => error?.code === "DESKTOP_CURRENT_ACCESS_SNAPSHOT_UNSTABLE" && error?.status === 503 && error?.retryable === true,
  );
});
