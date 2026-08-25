"use strict";

function normalizeUsername(value) {
  const clean = String(value || "").trim().replace(/^@+/, "");
  return clean ? clean.toLowerCase() : null;
}

function agencyRemovalPhrase(creator) {
  const username = normalizeUsername(creator?.username);
  if (!username) throw new Error("Creator username is required for agency removal");
  return `DELETE @${username}`;
}

function removeCreatorFromAssignedCreators(value, creatorId) {
  const id = String(creatorId || "");
  const filterIds = (items) => items.map(String).filter((item) => item && item !== id);
  if (Array.isArray(value)) {
    const next = filterIds(value);
    const changed = next.length !== value.length;
    return { changed, value: changed ? next : value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { changed: false, value };
  if (Array.isArray(value.ids)) {
    const next = filterIds(value.ids);
    const changed = next.length !== value.ids.length;
    return { changed, value: changed ? { ...value, ids: next } : value };
  }
  if (Array.isArray(value.creatorIds)) {
    const next = filterIds(value.creatorIds);
    const changed = next.length !== value.creatorIds.length;
    return { changed, value: changed ? { ...value, creatorIds: next } : value };
  }
  return { changed: false, value };
}


async function retireCreatorCryptoMaterialOnRemoval({
  db,
  agencyId,
  creatorId,
  retiredAt = new Date(),
  actorUserId = null,
  sourceRequestId = null,
  revokeReason = "CREATOR_REMOVED_FROM_AGENCY",
}) {
  const id = String(creatorId || "").trim();
  const agency = String(agencyId || "").trim();
  if (!id || !agency) throw new Error("agencyId and creatorId are required for creator crypto retirement");

  // Canonical broker state is unique per creator. Revoke a live execution once,
  // then separately crypto-shred *any* residual payload regardless of status.
  // The second operation intentionally does not rewrite revision/revokedAt/reason,
  // so an older already-REVOKED row keeps its original lifecycle provenance.
  const revokedCanonicalSessions = await db.creatorSessionState.updateMany({
    where: { agencyId: agency, creatorId: id, status: "ACTIVE" },
    data: {
      revision: { increment: 1 },
      status: "REVOKED",
      capturedAt: retiredAt,
      capturedByUserId: actorUserId || null,
      capturedByDeviceId: null,
      sourceRequestId: sourceRequestId || `creator-removal:${id}:${retiredAt.getTime()}`,
      revokedAt: retiredAt,
      revokeReason: String(revokeReason || "CREATOR_REMOVED_FROM_AGENCY"),
    },
  });

  const [retiredCanonicalSessionSecrets, creatorWraps, dedicatedProxies, retiredNetworkProfiles] = await Promise.all([
    db.creatorSessionState.updateMany({
      where: {
        agencyId: agency,
        creatorId: id,
        OR: [
          { encryptedPayload: { not: null } },
          { iv: { not: null } },
          { tag: { not: null } },
          { algorithm: { not: null } },
          { credentialHash: { not: null } },
          { coherenceHash: { not: null } },
        ],
      },
      data: {
        status: "REVOKED",
        encryptedPayload: null,
        iv: null,
        tag: null,
        algorithm: null,
        credentialHash: null,
        coherenceHash: null,
      },
    }),
    db.creatorDeviceKeyWrap.updateMany({
      where: { agencyId: agency, creatorId: id, revokedAt: null },
      data: { revokedAt: retiredAt },
    }),
    db.agencyProxyEndpoint.updateMany({
      where: {
        agencyId: agency,
        ownerCreatorId: id,
        OR: [
          { enabled: true },
          { encryptedPayload: { not: null } },
          { hasCredentials: true },
          { keyVersion: { not: null } },
          { usernameHint: { not: null } },
        ],
      },
      data: {
        enabled: false,
        version: { increment: 1 },
        encryptedPayload: null,
        iv: null,
        tag: null,
        algorithm: null,
        keyVersion: null,
        hasCredentials: false,
        usernameHint: null,
      },
    }),
    // A soft-deleted creator must not keep a live network assignment. In
    // particular, release an old/shared proxy without destroying its credentials.
    // Dedicated secret ownership remains on the disabled endpoint as historical
    // provenance, while the creator profile becomes inert and idempotent.
    db.creatorNetworkProfile.updateMany({
      where: {
        agencyId: agency,
        creatorId: id,
        OR: [
          { mode: { not: "DIRECT" } },
          { proxyEndpointId: { not: null } },
        ],
      },
      data: {
        mode: "DIRECT",
        proxyEndpointId: null,
        version: { increment: 1 },
        updatedByUserId: actorUserId || null,
      },
    }),
  ]);

  return {
    revokedCanonicalSessionCount: Number(revokedCanonicalSessions?.count || 0),
    retiredCanonicalSessionSecretCount: Number(retiredCanonicalSessionSecrets?.count || 0),
    revokedCreatorKeyWrapCount: Number(creatorWraps?.count || 0),
    retiredDedicatedProxyCount: Number(dedicatedProxies?.count || 0),
    retiredNetworkProfileCount: Number(retiredNetworkProfiles?.count || 0),
  };
}

module.exports = {
  agencyRemovalPhrase,
  removeCreatorFromAssignedCreators,
  retireCreatorCryptoMaterialOnRemoval,
};
