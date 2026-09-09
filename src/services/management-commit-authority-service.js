"use strict";

const { canAccessCreator } = require("../middleware/automation-permissions");
const { canUsePermission, isOwner } = require("./team-access-control");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");

function fail(code, message, status = 403, details = null) {
  const error = Object.assign(new Error(message), { code, status });
  if (details) error.details = details;
  return error;
}

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function epoch(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isOwnerOrAdmin(member) {
  if (isOwner(member)) return true;
  const legacy = String(member?.role || "").trim().toUpperCase();
  const roleKey = String(member?.roleKey || "").trim().toLowerCase();
  return legacy === "ADMIN" || legacy === "MANAGER" || roleKey === "admin" || roleKey === "manager";
}

async function lockAgencyLifecycle({ tx, agencyId }) {
  // Management writes are ordinary Agency work: join the shared lifecycle barrier,
  // then serialize only on the actor/target rows they actually mutate. Destructive
  // Agency retirement/restore owns the exclusive side of this same barrier.
  const barrier = await lockAgencyLifecycleBarrier({ db: tx, agencyId, mode: "shared" });
  const row = barrier.row;
  if (!row) throw fail("MANAGEMENT_AGENCY_NOT_FOUND", "Agency not found", 404);
  if (row.deletedAt) throw fail("MANAGEMENT_AGENCY_RETIRED", "Agency is no longer active", 409);
  return row;
}

async function lockLiveActor({ tx, agencyId, actorMember }) {
  const memberId = clean(actorMember?.id);
  const userId = clean(actorMember?.userId);
  if (!memberId || !userId) throw fail("MANAGEMENT_ACTOR_REQUIRED", "Current agency membership is required", 403);

  if (typeof tx?.$queryRawUnsafe === "function") {
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "AgencyMember" WHERE "id" = $1 AND "userId" = $2 AND "agencyId" = $3 FOR SHARE`,
      memberId,
      userId,
      String(agencyId),
    );
  }
  if (!tx?.agencyMember?.findFirst) {
    throw fail("MANAGEMENT_ACCESS_STORAGE_REQUIRED", "Agency member storage is required for commit-time authorization", 500);
  }
  const current = await tx.agencyMember.findFirst({
    where: { id: memberId, userId, agencyId: String(agencyId), deletedAt: null, deactivatedAt: null },
  });
  if (!current) throw fail("MANAGEMENT_ACCESS_REVOKED", "Agency membership is no longer active", 403);

  const admitted = epoch(actorMember?.accessEpoch);
  const live = epoch(current.accessEpoch);
  if (admitted != null && live != null && admitted !== live) {
    throw fail(
      "MANAGEMENT_ACCESS_STALE",
      "Management access changed while this request was in flight; refresh and retry",
      409,
      { admittedAccessEpoch: admitted, currentAccessEpoch: live },
    );
  }
  return current;
}

async function assertManagementCommitAuthority({
  tx,
  agencyId,
  actorMember,
  permissionKey = null,
  creatorIds = [],
  ownerOrAdmin = false,
  agencyAlreadyLocked = false,
}) {
  if (!tx || !agencyId) throw fail("MANAGEMENT_COMMIT_CONTEXT_REQUIRED", "Management commit context is required", 500);
  if (!agencyAlreadyLocked) await lockAgencyLifecycle({ tx, agencyId });
  const member = await lockLiveActor({ tx, agencyId, actorMember });

  if (ownerOrAdmin && !isOwnerOrAdmin(member)) {
    throw fail("MANAGEMENT_OWNER_OR_ADMIN_REQUIRED", "OWNER or ADMIN authority is required", 403);
  }
  if (permissionKey && !(await canUsePermission({ member, key: permissionKey, db: tx }))) {
    throw fail("MANAGEMENT_PERMISSION_REVOKED", `${permissionKey} permission is required`, 403, { permissionKey });
  }

  const targets = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : [creatorIds]).map((id) => clean(id)).filter(Boolean)));
  const denied = targets.filter((creatorId) => !canAccessCreator(member, creatorId));
  if (denied.length) {
    throw fail("MANAGEMENT_CREATOR_SCOPE_REVOKED", "Creator access changed while this request was in flight", 403, { creatorIds: denied });
  }

  return {
    member,
    accessEpoch: epoch(member.accessEpoch),
    creatorIds: targets,
  };
}

module.exports = {
  assertManagementCommitAuthority,
  lockAgencyLifecycle,
  lockLiveActor,
};
