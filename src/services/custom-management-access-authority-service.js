"use strict";

const { canAccessCreator } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { lockAgencyPipelineLifecycle } = require("./custom-content-pipeline-authority-service");

function fail(code, message, status = 403) {
  return Object.assign(new Error(message), { code, status });
}
function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}
function epoch(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function lockCurrentAgencyMember({ agencyId, actorMember, db }) {
  const memberId = clean(actorMember?.id);
  const userId = clean(actorMember?.userId);
  if (!agencyId || !memberId || !userId) {
    throw fail("CUSTOM_MANAGEMENT_ACTOR_REQUIRED", "Current agency membership is required", 403);
  }
  if (!db?.agencyMember?.findFirst) {
    throw fail("CUSTOM_MANAGEMENT_ACCESS_STORAGE_REQUIRED", "Agency member storage is required for commit-time management access", 500);
  }

  // Every human Customs control-plane write uses one root lock order:
  //   Agency lifecycle -> current AgencyMember -> Creator/business rows.
  // This is deliberately centralized here. A caller that forgets to take the
  // Agency fence cannot otherwise deadlock creator removal (Creator -> member
  // scope rewrite) or commit after Agency retirement. Re-locking the same Agency
  // row from callers that already joined the lifecycle fence is transaction-local
  // and harmless.
  await lockAgencyPipelineLifecycle({ db, agencyId: String(agencyId) });

  // Serialize creator-scope / permission changes with the management write. We lock
  // only the membership identity here and then read the canonical row through Prisma,
  // so JSON permission/scope semantics stay in one application representation.
  if (typeof db.$queryRawUnsafe === "function") {
    await db.$queryRawUnsafe(
      `SELECT "id" FROM "AgencyMember" WHERE "id" = $1 AND "userId" = $2 AND "agencyId" = $3 FOR SHARE`,
      memberId,
      userId,
      String(agencyId),
    );
  }
  const current = await db.agencyMember.findFirst({
    where: { id: memberId, userId, agencyId: String(agencyId), deletedAt: null, deactivatedAt: null },
  });
  if (!current) throw fail("CUSTOM_MANAGEMENT_ACCESS_REVOKED", "Agency membership is no longer active", 403);

  const requestEpoch = epoch(actorMember?.accessEpoch);
  const currentEpoch = epoch(current.accessEpoch);
  if (requestEpoch != null && currentEpoch != null && requestEpoch !== currentEpoch) {
    throw fail("CUSTOM_MANAGEMENT_ACCESS_STALE", "Management access changed while this request was in flight; refresh and retry", 409);
  }
  return current;
}

async function assertCustomManagementCreatorAccess({ agencyId, actorMember, creatorId, permissionKey, db }) {
  const targetCreatorId = clean(creatorId);
  if (!targetCreatorId) throw fail("CUSTOM_MANAGEMENT_CREATOR_REQUIRED", "Creator scope is required", 400);
  const member = await lockCurrentAgencyMember({ agencyId, actorMember, db });
  if (permissionKey && !(await canUsePermission({ member, key: permissionKey, db }))) {
    throw fail("CUSTOM_MANAGEMENT_PERMISSION_REVOKED", `${permissionKey} permission is required`, 403);
  }
  if (!canAccessCreator(member, targetCreatorId)) {
    throw fail("CUSTOM_MANAGEMENT_CREATOR_ACCESS_FORBIDDEN", "You do not have access to this creator", 403);
  }
  return { member, creatorId: targetCreatorId, accessEpoch: epoch(member.accessEpoch) };
}

module.exports = {
  assertCustomManagementCreatorAccess,
  lockCurrentAgencyMember,
};
