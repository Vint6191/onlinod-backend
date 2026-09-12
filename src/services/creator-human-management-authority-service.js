"use strict";

const { assertManagementCommitAuthority, lockAgencyLifecycle } = require("./management-commit-authority-service");
const { authorizeCreatorAccountWrite } = require("./phase2-release-compatibility-authority-service");

function codedError(code, message, status = 409, details = null) {
  const error = Object.assign(new Error(message), { code, status });
  if (details) error.details = details;
  return error;
}

async function assertHumanCreatorCreateAuthority({ tx, agencyId, actorMember }) {
  await authorizeCreatorAccountWrite(tx);
  return assertManagementCommitAuthority({
    tx,
    agencyId,
    actorMember,
    permissionKey: "creators.manage",
    requireBroadCreatorScope: true,
  });
}

async function lockHumanCreatorMutation({ tx, agencyId, creatorId, actorMember }) {
  await authorizeCreatorAccountWrite(tx);
  const agency = await lockAgencyLifecycle({ tx, agencyId });
  let locked = null;
  if (typeof tx?.$queryRawUnsafe === "function") {
    const rows = await tx.$queryRawUnsafe(
      `SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR UPDATE`,
      String(creatorId),
      String(agencyId),
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw codedError("CREATOR_NOT_FOUND", "Creator not found or no longer active", 404);
    }
  } else if (tx?.creatorAccount?.findFirst) {
    locked = await tx.creatorAccount.findFirst({
      where: { id: String(creatorId), agencyId: String(agencyId), deletedAt: null },
    });
    if (!locked) throw codedError("CREATOR_NOT_FOUND", "Creator not found or no longer active", 404);
  } else {
    throw codedError("MANAGEMENT_CREATOR_STORAGE_REQUIRED", "Creator storage is required for commit-time authorization", 500);
  }

  await assertManagementCommitAuthority({
    tx,
    agencyId,
    actorMember,
    permissionKey: "creators.manage",
    creatorIds: [creatorId],
    agencyAlreadyLocked: true,
    creatorRowsAlreadyLocked: true,
  });

  if (!locked && tx?.creatorAccount?.findFirst) {
    locked = await tx.creatorAccount.findFirst({
      where: { id: String(creatorId), agencyId: String(agencyId), deletedAt: null },
    });
  }
  return { agency, creator: locked };
}

async function assertHumanCreatorMutationAuthorityAfterLocks({ tx, agencyId, creatorId, actorMember }) {
  await authorizeCreatorAccountWrite(tx);
  return assertManagementCommitAuthority({
    tx,
    agencyId,
    actorMember,
    permissionKey: "creators.manage",
    creatorIds: [creatorId],
    agencyAlreadyLocked: true,
    creatorRowsAlreadyLocked: true,
  });
}

async function currentCreatorCatalogGeneration({ db, agencyId }) {
  if (!db || !agencyId || !db.agencyCreatorCatalogState?.findUnique) return 0;
  const row = await db.agencyCreatorCatalogState.findUnique({
    where: { agencyId: String(agencyId) },
    select: { generation: true },
  });
  const generation = Number(row?.generation || 0);
  return Number.isInteger(generation) && generation >= 0 ? generation : 0;
}

module.exports = {
  assertHumanCreatorCreateAuthority,
  lockHumanCreatorMutation,
  assertHumanCreatorMutationAuthorityAfterLocks,
  currentCreatorCatalogGeneration,
};
