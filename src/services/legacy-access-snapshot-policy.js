"use strict";

function policyError(code, message, status = 409, extra = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (extra && typeof extra === "object") Object.assign(error, extra);
  return error;
}

async function getAgencyCryptoRoot(db, agencyId) {
  return db.agencyCryptoRoot.findUnique({
    where: { agencyId },
    select: { agencyId: true, version: true, enforceOpaqueSecrets: true, enforcedAt: true },
  });
}

async function assertLegacyAccessSnapshotWritable({ db, agencyId }) {
  const root = await getAgencyCryptoRoot(db, agencyId);
  if (root?.enforceOpaqueSecrets === true) {
    throw policyError(
      "CRYPTO_LEGACY_ACCESS_SNAPSHOT_WRITE_DISABLED",
      "Legacy server-decryptable AccessSnapshot writes are disabled after opaque-secret enforcement",
      409,
    );
  }
  return root;
}

async function assertLegacyAccessSnapshotReadable({ db, agencyId }) {
  const root = await getAgencyCryptoRoot(db, agencyId);
  if (root?.enforceOpaqueSecrets === true) {
    throw policyError(
      "CRYPTO_LEGACY_ACCESS_SNAPSHOT_READ_DISABLED",
      "Legacy server-side AccessSnapshot decryption is disabled after opaque-secret enforcement",
      409,
    );
  }
  return root;
}

function legacyAccessSnapshotSecretWhere(agencyId) {
  return { agencyId, encryptedPayload: { not: null } };
}

async function countLegacyAccessSnapshotSecrets({ db, agencyId }) {
  return db.accessSnapshot.count({ where: legacyAccessSnapshotSecretWhere(agencyId) });
}

async function cryptoShredLegacyAccessSnapshotSecrets({ db, agencyId, retiredAt = new Date() }) {
  // Revocation provenance and payload-retirement provenance are different
  // events.  A snapshot that was revoked earlier must retain that timestamp
  // even if its legacy server-decryptable payload is shredded only now.
  await db.accessSnapshot.updateMany({
    where: {
      ...legacyAccessSnapshotSecretWhere(agencyId),
      active: true,
      revokedAt: null,
    },
    data: {
      active: false,
      revokedAt: retiredAt,
    },
  });

  const result = await db.accessSnapshot.updateMany({
    where: legacyAccessSnapshotSecretWhere(agencyId),
    data: {
      encryptedPayload: null,
      iv: null,
      tag: null,
      algorithm: null,
      active: false,
      payloadRetiredAt: retiredAt,
    },
  });
  return Number(result?.count || 0);
}

async function cryptoShredLegacyAccessSnapshotById({ db, agencyId, snapshotId, retiredAt = new Date() }) {
  const id = String(snapshotId || "").trim();
  if (!id) throw policyError("ACCESS_SNAPSHOT_ID_REQUIRED", "snapshotId is required", 400);

  // Fill provenance only while it is missing.  This is deliberately expressed
  // as conditional UPDATEs rather than read/modify/write so a stale manual
  // revoke cannot overwrite timestamps already committed by enforcement or
  // creator removal.
  await db.accessSnapshot.updateMany({
    where: { id, agencyId, revokedAt: null },
    data: { active: false, revokedAt: retiredAt },
  });
  await db.accessSnapshot.updateMany({
    where: { id, agencyId, payloadRetiredAt: null, encryptedPayload: { not: null } },
    data: { payloadRetiredAt: retiredAt },
  });
  const result = await db.accessSnapshot.updateMany({
    where: { id, agencyId },
    data: {
      encryptedPayload: null,
      iv: null,
      tag: null,
      algorithm: null,
      active: false,
    },
  });
  return Number(result?.count || 0);
}

module.exports = {
  assertLegacyAccessSnapshotReadable,
  assertLegacyAccessSnapshotWritable,
  countLegacyAccessSnapshotSecrets,
  cryptoShredLegacyAccessSnapshotSecrets,
  cryptoShredLegacyAccessSnapshotById,
  legacyAccessSnapshotSecretWhere,
};
