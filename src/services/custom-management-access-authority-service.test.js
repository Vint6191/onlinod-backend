"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertCustomManagementCreatorAccess } = require("./custom-management-access-authority-service");

function dbFor(currentMember) {
  const locks = [];
  return {
    get locks() { return locks.slice(); },
    agencyMember: {
      findFirst: async ({ where }) => where.id === currentMember.id && where.userId === currentMember.userId && where.agencyId === currentMember.agencyId
        ? { ...currentMember, permissions: { ...(currentMember.permissions || {}) } } : null,
    },
    async $queryRawUnsafe(sql) {
      if (/FROM "Agency"[\s\S]*FOR UPDATE/.test(sql)) { locks.push("AGENCY"); return [{ id: currentMember.agencyId, deletedAt: null, status: "ACTIVE" }]; }
      assert.match(sql, /AgencyMember[\s\S]*FOR SHARE/);
      locks.push("MEMBER");
      return [{ id: currentMember.id }];
    },
  };
}
const requestMember = { id:"manager-1", userId:"user-1", agencyId:"agency-1", role:"MANAGER", roleKey:"manager", assignedCreators:["creator-a"], accessEpoch:7, permissions:{"content.review_customs":true} };

test("current scoped manager may mutate an assigned creator and membership row is commit-locked", async () => {
  const db=dbFor({ ...requestMember });
  const result=await assertCustomManagementCreatorAccess({agencyId:"agency-1",actorMember:requestMember,creatorId:"creator-a",permissionKey:"content.review_customs",db});
  assert.equal(result.creatorId,"creator-a");
  assert.deepEqual(db.locks,["AGENCY","MEMBER"]);
});

test("current scoped manager cannot mutate another creator even with the feature permission", async () => {
  const db=dbFor({ ...requestMember });
  await assert.rejects(
    () => assertCustomManagementCreatorAccess({agencyId:"agency-1",actorMember:requestMember,creatorId:"creator-b",permissionKey:"content.review_customs",db}),
    (error) => error?.code === "CUSTOM_MANAGEMENT_CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );
});

test("accessEpoch change before commit rejects the stale management request", async () => {
  const db=dbFor({ ...requestMember, assignedCreators:[], accessEpoch:8 });
  await assert.rejects(
    () => assertCustomManagementCreatorAccess({agencyId:"agency-1",actorMember:requestMember,creatorId:"creator-a",permissionKey:"content.review_customs",db}),
    (error) => error?.code === "CUSTOM_MANAGEMENT_ACCESS_STALE" && error?.status === 409,
  );
});

test("current permission revoke is authoritative even if request snapshot still has review permission", async () => {
  const db=dbFor({ ...requestMember, permissions:{"content.review_customs":false} });
  await assert.rejects(
    () => assertCustomManagementCreatorAccess({agencyId:"agency-1",actorMember:requestMember,creatorId:"creator-a",permissionKey:"content.review_customs",db}),
    (error) => error?.code === "CUSTOM_MANAGEMENT_PERMISSION_REVOKED" && error?.status === 403,
  );
});
