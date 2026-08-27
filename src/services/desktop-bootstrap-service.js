"use strict";

const { assignedCreatorIds, hasBroadCreatorAccess } = require("../middleware/automation-permissions");
const { normalizedAccessEpoch } = require("./access-epoch-service");

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
  const creators = await listAccessibleCreatorRows({ db, agencyId, member });
  const accessEpoch = normalizedAccessEpoch(member.accessEpoch);
  return {
    ok: true,
    bootstrapVersion: 1,
    accessEpoch,
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
      creators: creators.map(creatorManifestEntry),
    },
  };
}

module.exports = {
  CREATOR_RUNTIME_INCLUDE,
  listAccessibleCreatorRows,
  accessibleCreatorIdSet,
  creatorManifestEntry,
  buildDesktopBootstrap,
};
