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
  return legacy === "ADMIN" || roleKey === "admin";
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
    // Persistent User disable is part of operational eligibility. Lock the User
    // before the membership row so an in-flight admin disable cannot race a
    // management commit that was admitted while the User was still active.
    const userRows = await tx.$queryRawUnsafe(
      `SELECT "id" FROM "User" WHERE "id"=$1 AND "disabledAt" IS NULL FOR SHARE`,
      userId,
    );
    if (!Array.isArray(userRows) || userRows.length !== 1) {
      throw fail("MANAGEMENT_USER_DISABLED", "User is no longer operationally eligible", 403);
    }
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "AgencyMember" WHERE "id" = $1 AND "userId" = $2 AND "agencyId" = $3 FOR SHARE`,
      memberId,
      userId,
      String(agencyId),
    );
  } else if (tx?.user?.findUnique) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, disabledAt: true } });
    if (!user || user.disabledAt) throw fail("MANAGEMENT_USER_DISABLED", "User is no longer operationally eligible", 403);
  }
  if (!tx?.agencyMember?.findFirst) {
    throw fail("MANAGEMENT_ACCESS_STORAGE_REQUIRED", "Agency member storage is required for commit-time authorization", 500);
  }
  const current = await tx.agencyMember.findFirst({
    where: { id: memberId, userId, agencyId: String(agencyId), deletedAt: null, deactivatedAt: null, user: { is: { disabledAt: null } } },
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
  creatorRowsAlreadyLocked = false,
}) {
  if (!tx || !agencyId) throw fail("MANAGEMENT_COMMIT_CONTEXT_REQUIRED", "Management commit context is required", 500);
  if (!agencyAlreadyLocked) await lockAgencyLifecycle({ tx, agencyId });

  // Creator lifecycle is a commit-time authority, not an admission-time fact.
  // Lock every referenced Creator before the actor/member row so every management
  // writer and Creator retirement obeys one order: Agency -> Creator -> Member.
  // FOR SHARE conflicts with both Creator FOR UPDATE and non-key lifecycle UPDATE
  // (deletedAt/status) while still allowing concurrent read-side scope proofs.
  const targets = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : [creatorIds]).map((id) => clean(id)).filter(Boolean))).sort();
  if (targets.length) {
    if (creatorRowsAlreadyLocked) {
      // Caller owns the canonical Creator FOR UPDATE lifecycle lock already.
      // Re-acquiring FOR SHARE before that lock would create a SHARE->UPDATE
      // upgrade topology. A plain in-transaction live-state proof is enough here:
      // the existing FOR UPDATE fence prevents retirement/state from changing.
      if (!tx?.creatorAccount?.findMany) {
        throw fail("MANAGEMENT_CREATOR_STORAGE_REQUIRED", "Creator storage is required for commit-time authorization", 500);
      }
      const rows = await tx.creatorAccount.findMany({
        where: { agencyId: String(agencyId), deletedAt: null, id: { in: targets } },
        select: { id: true },
        take: targets.length,
      });
      const live = new Set(rows.map((row) => String(row.id)));
      const missing = targets.filter((id) => !live.has(id));
      if (missing.length) throw fail("MANAGEMENT_CREATOR_RETIRED", "Creator is no longer active", 409, { creatorIds: missing });
    } else if (typeof tx?.$queryRawUnsafe === "function") {
      for (const creatorId of targets) {
        const locked = await tx.$queryRawUnsafe(
          `SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE`,
          creatorId,
          String(agencyId),
        );
        if (!Array.isArray(locked) || locked.length !== 1) {
          throw fail("MANAGEMENT_CREATOR_RETIRED", "Creator is no longer active", 409, { creatorIds: [creatorId] });
        }
      }
    } else if (tx?.creatorAccount?.findMany) {
      const rows = await tx.creatorAccount.findMany({
        where: { agencyId: String(agencyId), deletedAt: null, id: { in: targets } },
        select: { id: true },
        take: targets.length,
      });
      const live = new Set(rows.map((row) => String(row.id)));
      const missing = targets.filter((id) => !live.has(id));
      if (missing.length) throw fail("MANAGEMENT_CREATOR_RETIRED", "Creator is no longer active", 409, { creatorIds: missing });
    } else {
      throw fail("MANAGEMENT_CREATOR_STORAGE_REQUIRED", "Creator storage is required for commit-time authorization", 500);
    }
  }

  const member = await lockLiveActor({ tx, agencyId, actorMember });

  if (ownerOrAdmin && !isOwnerOrAdmin(member)) {
    throw fail("MANAGEMENT_OWNER_OR_ADMIN_REQUIRED", "OWNER or ADMIN authority is required", 403);
  }
  if (permissionKey && !(await canUsePermission({ member, key: permissionKey, db: tx }))) {
    throw fail("MANAGEMENT_PERMISSION_REVOKED", `${permissionKey} permission is required`, 403, { permissionKey });
  }

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
