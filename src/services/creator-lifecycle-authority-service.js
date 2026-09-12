"use strict";

const { retireCreatorCryptoMaterialOnRemoval } = require("./creator-agency-removal");
const { retireCreatorCurrentAccess } = require("./creator-access-scope-authority-service");
const { lockTeamControlPlaneTopology } = require("./team-control-plane-authority-service");
const { assertCreatorCustomPipelineRetirable, lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
const { assertCreatorMassCampaignRetirable } = require("./mass-campaign-authority-service");
const { publishDomainWork, WORK_CLASS } = require("./domain-work-authority-service");
const { publishDesktopControlEvent } = require("./desktop-control-events");
const { assertManagementCommitAuthority } = require("./management-commit-authority-service");
const { authorizeCreatorAccountWrite, assertTeamControlPlaneWriteAdmission } = require("./phase2-release-compatibility-authority-service");

function clean(value, max = 220) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

async function retireCreatorWithinTransaction({
  tx,
  agencyId,
  creatorId,
  actorUserId = null,
  mode = "SOFT",
  retiredAt = new Date(),
  sourceRequestId = null,
  revokeReason = null,
  managementActorMember = null,
  managementPermissionKey = null,
  agencyAlreadyLocked = false,
} = {}) {
  const agency = clean(agencyId);
  const creator = clean(creatorId);
  const hard = String(mode || "SOFT").toUpperCase() === "HARD";
  if (!tx || !agency || !creator) throw Object.assign(new Error("Creator lifecycle transaction context is required"), { code: "CREATOR_LIFECYCLE_CONTEXT_REQUIRED", status: 500 });

  // Release admission must precede even the Agency lifecycle prefix. The topology
  // service repeats this check as a fail-closed invariant for future callers.
  await assertTeamControlPlaneWriteAdmission(tx);
  if (!agencyAlreadyLocked) await lockAgencyPipelineLifecycle({ db: tx, agencyId: agency, allowDeleted: true });
  // Creator retirement mutates Team current-authority topology: it removes this
  // Creator from live Member/Invitation scopes and severs current Team edges.
  // Join the Agency-wide Team control-plane fence after the Agency lifecycle
  // barrier and before any Role/Creator/User/Member rows.
  await lockTeamControlPlaneTopology({ tx, agencyId: agency, agencyAlreadyLocked: true, allowDeleted: true });
  await lockCreatorPipelineLifecycle({ db: tx, agencyId: agency, creatorId: creator, allowDeleted: true });
  const current = await tx.creatorAccount.findFirst({ where: { id: creator, agencyId: agency }, select: { id: true, deletedAt: true, status: true } });
  if (!current) throw Object.assign(new Error("Creator not found"), { code: "CREATOR_NOT_FOUND", status: 404 });

  if (managementActorMember) {
    // Normal Agency UI retirement is a management commit, not merely a lifecycle
    // side effect. Revalidate User/member/permission/accessEpoch/scope after the
    // canonical Agency -> Creator FOR UPDATE locks and before any destructive
    // scope/crypto mutation. Internal destructive/platform-admin callers omit
    // managementActorMember and use their own higher authority.
    await assertManagementCommitAuthority({
      tx, agencyId: agency, actorMember: managementActorMember,
      permissionKey: managementPermissionKey || "creators.manage",
      creatorIds: [creator], agencyAlreadyLocked: true, creatorRowsAlreadyLocked: true,
    });
  }

  // Live retirement must prove external-effect safety. A previously retired row
  // can still be re-entered to converge legacy/incomplete access-control cleanup;
  // HARD re-entry additionally rechecks destructive external-effect guards.
  if (!current.deletedAt || hard) {
    await assertCreatorCustomPipelineRetirable({ db: tx, agencyId: agency, creatorId: creator });
    await assertCreatorMassCampaignRetirable({ db: tx, agencyId: agency, creatorId: creator, requireFreshProviderSnapshot: hard ? !current.deletedAt : true });
  }

  const scope = await retireCreatorCurrentAccess({ tx, agencyId: agency, creatorId: creator });
  // creatorId on TeamShiftCreator is durable historical attribution; creatorRefId
  // is the current operational edge. Soft removal must sever that live edge too,
  // not wait for a later physical hard-delete SET NULL cascade.
  if (tx.teamShiftCreator?.updateMany) {
    await tx.teamShiftCreator.updateMany({ where: { creatorRefId: creator }, data: { creatorRefId: null } });
  }
  // These revocations are intentionally idempotent. Re-running them on an already
  // retired Creator repairs legacy/partially-applied lifecycle state without
  // resurrecting any authority.
  const cryptoRetirement = await retireCreatorCryptoMaterialOnRemoval({
    db: tx,
    agencyId: agency,
    creatorId: creator,
    retiredAt,
    actorUserId,
    sourceRequestId: sourceRequestId || `creator-retirement:${creator}:${retiredAt.getTime()}`,
    revokeReason: revokeReason || (hard ? "CREATOR_HARD_DELETE_PENDING" : "CREATOR_REMOVED_FROM_AGENCY"),
  });
  await tx.deviceCreatorBinding.updateMany({ where: { creatorId: creator }, data: { status: "REVOKED" } });
  await tx.jobInstance.updateMany({
    where: { creatorId: creator, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
    data: { status: "CANCELLED", completedAt: retiredAt, leaseUntil: null, leaseTokenHash: null, claimedAt: null, claimedByDeviceId: null },
  });
  if (!current.deletedAt) {
    await authorizeCreatorAccountWrite(tx);
    await tx.creatorAccount.update({ where: { id: creator }, data: { status: "DISABLED", deletedAt: retiredAt } });
  }

  if (hard) {
    await publishDomainWork({
      db: tx,
      agencyId: agency,
      workClass: WORK_CLASS.DESTRUCTIVE_CREATOR_CLEANUP,
      objectType: "Phase2CreatorDestructiveCleanup",
      objectId: creator,
      partitionKey: creator,
      creatorId: null,
      availableAt: retiredAt,
    });
  }

  return {
    alreadyRetired: Boolean(current.deletedAt),
    memberEpochs: scope.members || [],
    removedFromMemberAssignments: Number(scope.removedFromMemberAssignments || 0),
    removedFromInvitationAssignments: Number(scope.removedFromInvitationAssignments || 0),
    ...cryptoRetirement,
  };
}

function publishCreatorRetirementControlEvents({ agencyId, creatorId, reason, memberEpochs = [], sourceDeviceId = null, requestId = null } = {}) {
  const agency = clean(agencyId);
  const creator = clean(creatorId);
  if (!agency || !creator) return;
  // One agency-wide revoke invalidates broad "all" access without O(all members)
  // epoch writes. Explicit scoped members changed by the lifecycle get their own
  // epoch event so any cached scope snapshot is fenced as well.
  publishDesktopControlEvent({ type: "CREATOR_REVOKED", agencyId: agency, creatorId: creator, reason: reason || "CREATOR_RETIRED", sourceDeviceId, requestId });
  for (const member of memberEpochs || []) {
    if (!member?.id || !member?.accessEpoch) continue;
    publishDesktopControlEvent({
      type: "ACCESS_EPOCH_CHANGED",
      agencyId: agency,
      accessEpoch: Number(member.accessEpoch),
      targetUserId: member.userId || null,
      targetMemberId: member.id,
      sourceDeviceId,
      requestId,
    });
  }
}

module.exports = { retireCreatorWithinTransaction, publishCreatorRetirementControlEvents };
