"use strict";

const { assignedCreatorIds, hasBroadCreatorAccess } = require("../middleware/automation-permissions");
const { normalizedAccessEpoch } = require("./access-epoch-service");

function desktopMemberAuthorityFingerprint(member) {
  const broad = hasBroadCreatorAccess(member);
  const creatorIds = broad
    ? []
    : Array.from(new Set(assignedCreatorIds(member).map(String).filter(Boolean))).sort();
  return JSON.stringify([
    normalizedAccessEpoch(member?.accessEpoch),
    String(member?.role || "").toUpperCase(),
    String(member?.roleKey || "").toLowerCase(),
    broad ? "all" : "scoped",
    creatorIds,
  ]);
}

function desktopAuthorityProof(member, creatorCatalogGeneration) {
  const generation = Number(creatorCatalogGeneration);
  return {
    accessEpoch: normalizedAccessEpoch(member?.accessEpoch),
    creatorCatalogGeneration: Number.isInteger(generation) && generation >= 0 ? generation : 0,
  };
}

function desktopMemberAuthorityRevokedError() {
  const error = new Error("Desktop member authority is no longer operationally eligible");
  error.code = "DESKTOP_MEMBER_AUTHORITY_REVOKED";
  error.status = 403;
  return error;
}

async function readCurrentDesktopMemberAuthority({ db, agencyId, userId, memberId = null }) {
  if (!db?.agencyMember?.findFirst || !agencyId || !userId) throw desktopMemberAuthorityRevokedError();
  const member = await db.agencyMember.findFirst({
    where: {
      ...(memberId ? { id: String(memberId) } : {}),
      agencyId: String(agencyId),
      userId: String(userId),
      deletedAt: null,
      deactivatedAt: null,
      user: { is: { disabledAt: null } },
      agency: { is: { deletedAt: null } },
    },
    select: {
      id: true,
      userId: true,
      agencyId: true,
      role: true,
      roleKey: true,
      assignedCreators: true,
      accessEpoch: true,
    },
  });
  if (!member) throw desktopMemberAuthorityRevokedError();
  return member;
}

function desktopCurrentAccessSnapshotUnstableError() {
  const error = new Error("Desktop current-access authority changed continuously while the response was being authorized");
  error.code = "DESKTOP_CURRENT_ACCESS_SNAPSHOT_UNSTABLE";
  error.status = 503;
  error.retryable = true;
  return error;
}

async function withStableDesktopCurrentAccess({
  db, agencyId, userId, memberId = null, readGeneration = null, work, maxAttempts = 4,
}) {
  if (typeof work !== "function") throw new TypeError("Desktop current-access work callback is required");
  const attempts = Math.max(1, Math.min(10, Number(maxAttempts) || 4));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const memberBefore = await readCurrentDesktopMemberAuthority({ db, agencyId, userId, memberId });
    const generationBefore = typeof readGeneration === "function" ? await readGeneration() : null;
    const value = await work(memberBefore);
    const generationAfter = typeof readGeneration === "function" ? await readGeneration() : null;
    const memberAfter = await readCurrentDesktopMemberAuthority({ db, agencyId, userId, memberId });
    const generationStable = typeof readGeneration !== "function" || generationBefore === generationAfter;
    if (generationStable
        && desktopMemberAuthorityFingerprint(memberBefore) === desktopMemberAuthorityFingerprint(memberAfter)) {
      return { value, member: memberAfter, generation: generationAfter };
    }
  }
  throw desktopCurrentAccessSnapshotUnstableError();
}

module.exports = {
  desktopMemberAuthorityFingerprint,
  desktopAuthorityProof,
  desktopMemberAuthorityRevokedError,
  desktopCurrentAccessSnapshotUnstableError,
  readCurrentDesktopMemberAuthority,
  withStableDesktopCurrentAccess,
};
