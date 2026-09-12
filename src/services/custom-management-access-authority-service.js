"use strict";

const { assertManagementCommitAuthority } = require("./management-commit-authority-service");
const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");

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

function translateManagementError(error) {
  const code = String(error?.code || "");
  const mapped = {
    MANAGEMENT_ACCESS_REVOKED: "CUSTOM_MANAGEMENT_ACCESS_REVOKED",
    MANAGEMENT_USER_DISABLED: "CUSTOM_MANAGEMENT_ACCESS_REVOKED",
    MANAGEMENT_ACCESS_STALE: "CUSTOM_MANAGEMENT_ACCESS_STALE",
    MANAGEMENT_PERMISSION_REVOKED: "CUSTOM_MANAGEMENT_PERMISSION_REVOKED",
    MANAGEMENT_CREATOR_SCOPE_REVOKED: "CUSTOM_MANAGEMENT_CREATOR_ACCESS_FORBIDDEN",
    MANAGEMENT_CREATOR_RETIRED: "CUSTOM_MANAGEMENT_CREATOR_ACCESS_FORBIDDEN",
  }[code];
  if (!mapped) throw error;
  error.code = mapped;
  throw error;
}

async function lockCurrentAgencyMember({ agencyId, actorMember, db, agencyAlreadyLocked = false }) {
  if (!agencyId) throw fail("CUSTOM_MANAGEMENT_ACTOR_REQUIRED", "Current agency membership is required", 403);
  if (!agencyAlreadyLocked) await lockAgencyPipelineLifecycle({ db, agencyId: String(agencyId) });
  try {
    const commit = await assertManagementCommitAuthority({
      tx: db,
      agencyId: String(agencyId),
      actorMember,
      agencyAlreadyLocked: true,
    });
    return commit.member;
  } catch (error) {
    return translateManagementError(error);
  }
}

async function assertCustomManagementCreatorAccess({ agencyId, actorMember, creatorId, permissionKey, db }) {
  const targetCreatorId = clean(creatorId);
  if (!targetCreatorId) throw fail("CUSTOM_MANAGEMENT_CREATOR_REQUIRED", "Creator scope is required", 400);

  // One global human Creator mutation prefix:
  //   Agency lifecycle -> Creator FOR UPDATE -> live User/Member/access -> business rows.
  // Callers may re-enter lockCreatorPipelineLifecycle later in the same transaction;
  // the Creator row is already owned, so that re-lock cannot invert with retirement.
  await lockAgencyPipelineLifecycle({ db, agencyId: String(agencyId) });
  await lockCreatorPipelineLifecycle({ db, agencyId: String(agencyId), creatorId: targetCreatorId });
  try {
    const commit = await assertManagementCommitAuthority({
      tx: db,
      agencyId: String(agencyId),
      actorMember,
      permissionKey: permissionKey || null,
      creatorIds: [targetCreatorId],
      agencyAlreadyLocked: true,
      creatorRowsAlreadyLocked: true,
    });
    return { member: commit.member, creatorId: targetCreatorId, accessEpoch: epoch(commit.accessEpoch) };
  } catch (error) {
    return translateManagementError(error);
  }
}

module.exports = {
  assertCustomManagementCreatorAccess,
  lockCurrentAgencyMember,
};
