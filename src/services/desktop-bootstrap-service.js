"use strict";

const { assignedCreatorIds, hasBroadCreatorAccess } = require("../middleware/automation-permissions");
const { normalizedAccessEpoch } = require("./access-epoch-service");
const { currentCreatorCatalogGeneration } = require("./creator-human-management-authority-service");
const {
  desktopMemberAuthorityFingerprint,
  desktopMemberAuthorityRevokedError,
  readCurrentDesktopMemberAuthority,
} = require("./desktop-current-access-authority-service");

const CREATOR_RUNTIME_INCLUDE = Object.freeze({
  sessionState: {
    select: {
      status: true,
      revision: true,
      payloadVersion: true,
      portableReady: true,
      platformUserId: true,
      capturedByDeviceId: true,
      updatedAt: true,
    },
  },
  networkProfile: {
    select: {
      mode: true,
      proxyEndpointId: true,
      version: true,
      updatedAt: true,
    },
  },
  cryptoKeyState: {
    select: {
      activeVersion: true,
      rootVersion: true,
      updatedAt: true,
    },
  },
});

function creatorScopeWhere({ agencyId, member }) {
  if (hasBroadCreatorAccess(member)) return { agencyId, deletedAt: null };
  const ids = assignedCreatorIds(member);
  return {
    agencyId,
    deletedAt: null,
    id: { in: ids.length ? ids : ["__none__"] },
  };
}

async function listAccessibleCreatorRows({ db, agencyId, member }) {
  return db.creatorAccount.findMany({
    where: creatorScopeWhere({ agencyId, member }),
    include: CREATOR_RUNTIME_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 10000,
  });
}

const CREATOR_CATALOG_SNAPSHOT_ATTEMPTS = 4;

function creatorCatalogSnapshotError() {
  const error = new Error("Creator catalog changed continuously while desktop bootstrap was being built");
  error.code = "CREATOR_CATALOG_SNAPSHOT_UNSTABLE";
  error.status = 503;
  error.retryable = true;
  return error;
}

async function readStableAccessibleCreatorCatalog({ db, agencyId, userId, member, maxAttempts = CREATOR_CATALOG_SNAPSHOT_ATTEMPTS }) {
  const attempts = Math.max(1, Math.min(10, Number(maxAttempts) || CREATOR_CATALOG_SNAPSHOT_ATTEMPTS));
  const memberId = String(member?.id || "").trim();
  const expectedUserId = String(userId || member?.userId || "").trim();
  if (!memberId || !expectedUserId) throw desktopMemberAuthorityRevokedError();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Creator membership and member-specific access are separate authorities.
    // Read both sides of the creator query so a scope/role/User lifecycle commit
    // cannot pair an obsolete creator list with a newer accessEpoch.
    const memberBefore = await readCurrentDesktopMemberAuthority({
      db, agencyId, userId: expectedUserId, memberId,
    });
    const generationBefore = await currentCreatorCatalogGeneration({ db, agencyId });
    const creators = await listAccessibleCreatorRows({ db, agencyId, member: memberBefore });
    const generationAfter = await currentCreatorCatalogGeneration({ db, agencyId });
    const memberAfter = await readCurrentDesktopMemberAuthority({
      db, agencyId, userId: expectedUserId, memberId,
    });

    if (generationBefore === generationAfter
        && desktopMemberAuthorityFingerprint(memberBefore) === desktopMemberAuthorityFingerprint(memberAfter)) {
      return {
        creators,
        member: memberAfter,
        accessEpoch: normalizedAccessEpoch(memberAfter.accessEpoch),
        creatorCatalogGeneration: generationAfter,
      };
    }
  }
  throw creatorCatalogSnapshotError();
}

async function accessibleCreatorIdSet({ db, agencyId, member, creatorIds }) {
  const requested = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (requested.length === 0) return new Set();
  const base = creatorScopeWhere({ agencyId, member });
  let visibleIds = requested;
  if (base.id?.in) {
    const assigned = new Set(base.id.in);
    visibleIds = requested.filter((id) => assigned.has(id));
  }
  if (visibleIds.length === 0) return new Set();
  const rows = await db.creatorAccount.findMany({
    where: { agencyId, deletedAt: null, id: { in: visibleIds } },
    select: { id: true },
    take: Math.min(10000, visibleIds.length),
  });
  return new Set(rows.map((row) => String(row.id)));
}

function creatorManifestEntry(creator) {
  const session = creator?.sessionState || null;
  const network = creator?.networkProfile || null;
  const keyState = creator?.cryptoKeyState || null;
  const expectedOnlyFansUserId = String(session?.platformUserId || creator?.remoteId || "").trim() || null;
  return {
    creatorId: String(creator.id),
    expectedOnlyFansUserId,
    sessionRevision: Number.isInteger(Number(session?.revision)) ? Number(session.revision) : 0,
    sessionStatus: String(session?.status || "ABSENT"),
    keyVersion: Number.isInteger(Number(keyState?.activeVersion)) ? Number(keyState.activeVersion) : 0,
    networkMode: String(network?.mode || "DIRECT").toUpperCase() === "PROXY" ? "PROXY" : "DIRECT",
    networkVersion: Number.isInteger(Number(network?.version)) ? Number(network.version) : 0,
    accessAllowed: true,
  };
}

async function buildDesktopBootstrap({ db, agencyId, userId, member, deviceId }) {
  if (!db || !agencyId || !userId || !member?.id || !deviceId) {
    const error = new Error("Desktop bootstrap requires agency, user, member and bound device context");
    error.code = "DESKTOP_BOOTSTRAP_CONTEXT_REQUIRED";
    error.status = 401;
    throw error;
  }
  const { creators, creatorCatalogGeneration, accessEpoch } = await readStableAccessibleCreatorCatalog({
    db, agencyId, userId, member,
  });
  return {
    ok: true,
    bootstrapVersion: 1,
    accessEpoch,
    creatorCatalogGeneration,
    scope: {
      agencyId: String(agencyId),
      userId: String(userId),
      memberId: String(member.id),
      deviceId: String(deviceId),
    },
    creators,
    manifest: {
      version: 1,
      accessEpoch,
      creatorCatalogGeneration,
      creators: creators.map(creatorManifestEntry),
    },
  };
}

module.exports = {
  CREATOR_RUNTIME_INCLUDE,
  listAccessibleCreatorRows,
  desktopMemberAuthorityFingerprint,
  readCurrentDesktopMemberAuthority,
  readStableAccessibleCreatorCatalog,
  accessibleCreatorIdSet,
  creatorManifestEntry,
  buildDesktopBootstrap,
};
