"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadAuthority({ permission = true } = {}) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../middleware/automation-permissions") {
      return { canAccessCreator: (member, creatorId) => member?.assignedCreators === "all" || (Array.isArray(member?.assignedCreators) && member.assignedCreators.includes(creatorId)) };
    }
    if (request === "./team-access-control") {
      return { canUsePermission: async () => permission, isOwner: (member) => String(member?.roleKey || "").toLowerCase() === "owner" || String(member?.role || "").toUpperCase() === "OWNER" };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./management-commit-authority-service")];
    return require("./management-commit-authority-service");
  } finally {
    Module._load = original;
  }
}

function dbWith(member, { liveCreatorIds = ["creator-1"] } = {}) {
  return {
    agency: { findUnique: async () => ({ id: "agency-1", deletedAt: null, status: "ACTIVE" }) },
    creatorAccount: {
      findMany: async ({ where }) => (where?.id?.in || []).filter((id) => liveCreatorIds.includes(id)).map((id) => ({ id })),
    },
    agencyMember: { findFirst: async ({ where }) => member && where.id === member.id && where.userId === member.userId ? { ...member } : null },
  };
}

const admitted = { id: "member-1", userId: "user-1", agencyId: "agency-1", accessEpoch: 7, role: "ADMIN", roleKey: "admin", assignedCreators: ["creator-1"] };

test("ManagementCommitAuthority admits only the live matching actor/epoch/permission/scope", async () => {
  const { assertManagementCommitAuthority } = loadAuthority();
  const out = await assertManagementCommitAuthority({ tx: dbWith(admitted), agencyId: "agency-1", actorMember: admitted, permissionKey: "workspace.manage_schedule", creatorIds: ["creator-1"] });
  assert.equal(out.member.id, "member-1");
  assert.equal(out.accessEpoch, 7);
});

test("ManagementCommitAuthority rejects an in-flight request after accessEpoch changes", async () => {
  const { assertManagementCommitAuthority } = loadAuthority();
  await assert.rejects(
    () => assertManagementCommitAuthority({ tx: dbWith({ ...admitted, accessEpoch: 8 }), agencyId: "agency-1", actorMember: admitted }),
    (error) => error?.code === "MANAGEMENT_ACCESS_STALE" && error?.status === 409,
  );
});

test("ManagementCommitAuthority rejects permission revoked after preflight", async () => {
  const { assertManagementCommitAuthority } = loadAuthority({ permission: false });
  await assert.rejects(
    () => assertManagementCommitAuthority({ tx: dbWith(admitted), agencyId: "agency-1", actorMember: admitted, permissionKey: "workspace.edit_roles" }),
    (error) => error?.code === "MANAGEMENT_PERMISSION_REVOKED" && error?.status === 403,
  );
});

test("ManagementCommitAuthority rejects creator scope revoked after preflight", async () => {
  const { assertManagementCommitAuthority } = loadAuthority();
  await assert.rejects(
    () => assertManagementCommitAuthority({ tx: dbWith({ ...admitted, assignedCreators: ["creator-2"] }), agencyId: "agency-1", actorMember: admitted, creatorIds: ["creator-1"] }),
    (error) => error?.code === "MANAGEMENT_CREATOR_SCOPE_REVOKED" && error?.status === 403,
  );
});

test("ManagementCommitAuthority rejects owner/admin demotion at commit", async () => {
  const { assertManagementCommitAuthority } = loadAuthority();
  await assert.rejects(
    () => assertManagementCommitAuthority({ tx: dbWith({ ...admitted, role: "OPERATOR", roleKey: "chatter" }), agencyId: "agency-1", actorMember: admitted, ownerOrAdmin: true }),
    (error) => error?.code === "MANAGEMENT_OWNER_OR_ADMIN_REQUIRED" && error?.status === 403,
  );
});


test("ManagementCommitAuthority ownerOrAdmin contract rejects preset Manager", async () => {
  const { assertManagementCommitAuthority } = loadAuthority();
  const manager = { ...admitted, role: "MANAGER", roleKey: "manager" };
  await assert.rejects(
    () => assertManagementCommitAuthority({ tx: dbWith(manager), agencyId: "agency-1", actorMember: manager, ownerOrAdmin: true }),
    (error) => error?.code === "MANAGEMENT_OWNER_OR_ADMIN_REQUIRED" && error?.status === 403,
  );
});

test("ManagementCommitAuthority ownerOrAdmin contract accepts explicit ADMIN", async () => {
  const { assertManagementCommitAuthority } = loadAuthority();
  const out = await assertManagementCommitAuthority({ tx: dbWith(admitted), agencyId: "agency-1", actorMember: admitted, ownerOrAdmin: true });
  assert.equal(out.member.id, admitted.id);
});

test("ManagementCommitAuthority validates scope without SHARE lock when canonical Creator FOR UPDATE is already owned", async () => {
  const { assertManagementCommitAuthority } = loadAuthority();
  const sql = [];
  const db = dbWith(admitted);
  db.$queryRawUnsafe = async (query, ...args) => {
    sql.push(String(query));
    if (String(query).includes('FROM "User"')) return [{ id: admitted.userId }];
    if (String(query).includes('FROM "AgencyMember"')) return [{ id: admitted.id }];
    throw new Error(`unexpected raw query: ${query}`);
  };
  const out = await assertManagementCommitAuthority({
    tx: db, agencyId: "agency-1", actorMember: admitted, permissionKey: "creators.manage",
    creatorIds: ["creator-1"], agencyAlreadyLocked: true, creatorRowsAlreadyLocked: true,
  });
  assert.equal(out.member.id, admitted.id);
  assert.equal(sql.some((query) => query.includes('FROM "CreatorAccount"')), false);
  assert.equal(sql.some((query) => query.includes('FROM "User"') && query.includes('FOR SHARE')), true);
});
