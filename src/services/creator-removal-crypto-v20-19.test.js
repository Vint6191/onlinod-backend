"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { retireCreatorCryptoMaterialOnRemoval } = require("./creator-agency-removal");

function matches(where, row) {
  if (!where) return true;
  if (Array.isArray(where.OR) && !where.OR.some((item) => matches(item, row))) return false;
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") continue;
    const actual = row?.[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, "not")) {
        if (actual === expected.not) return false;
        continue;
      }
      if (!matches(expected, actual)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function apply(row, data) {
  for (const [key, value] of Object.entries(data || {})) {
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) {
      row[key] = Number(row[key] || 0) + Number(value.increment);
    } else {
      row[key] = value;
    }
  }
}

function makeDb() {
  const state = {
    snapshots: [
      { id: "snap-live", agencyId: "agency-1", creatorId: "creator-1", active: true, encryptedPayload: "legacy-cipher", iv: "iv", tag: "tag", algorithm: "aes-256-gcm", revokedAt: null, payloadRetiredAt: null },
      { id: "snap-old", agencyId: "agency-1", creatorId: "creator-1", active: false, encryptedPayload: "old-cipher", iv: "iv2", tag: "tag2", algorithm: "aes-256-gcm", revokedAt: new Date("2026-08-20T00:00:00Z"), payloadRetiredAt: null },
      { id: "other", agencyId: "agency-1", creatorId: "creator-2", active: true, encryptedPayload: "keep-me", iv: "x", tag: "y", algorithm: "aes-256-gcm", revokedAt: null, payloadRetiredAt: null },
    ],
    wraps: [
      { id: "wrap-live", agencyId: "agency-1", creatorId: "creator-1", deviceId: "device-1", keyVersion: 3, revokedAt: null },
      { id: "wrap-old", agencyId: "agency-1", creatorId: "creator-1", deviceId: "device-2", keyVersion: 2, revokedAt: new Date("2026-08-20T00:00:00Z") },
      { id: "wrap-other", agencyId: "agency-1", creatorId: "creator-2", deviceId: "device-1", keyVersion: 1, revokedAt: null },
    ],
    proxies: [
      { id: "proxy-dedicated", agencyId: "agency-1", ownerCreatorId: "creator-1", enabled: true, version: 7, encryptedPayload: "proxy-cipher", iv: "piv", tag: "ptag", algorithm: "aes-256-gcm-client-e2e-v1", keyVersion: 3, hasCredentials: true, usernameHint: "u***" },
      { id: "proxy-shared", agencyId: "agency-1", ownerCreatorId: null, enabled: true, version: 2, encryptedPayload: "shared-cipher", iv: "siv", tag: "stag", algorithm: "aes-256-gcm-client-e2e-v1", keyVersion: 1, hasCredentials: true, usernameHint: "s***" },
    ],
    profiles: [
      { id: "profile-removed", agencyId: "agency-1", creatorId: "creator-1", mode: "PROXY", proxyEndpointId: "proxy-shared", version: 4, updatedByUserId: "old-user" },
      { id: "profile-other", agencyId: "agency-1", creatorId: "creator-2", mode: "DIRECT", proxyEndpointId: null, version: 2, updatedByUserId: null },
    ],
    sessions: [
      { id: "session-active", agencyId: "agency-1", creatorId: "creator-1", status: "ACTIVE", revision: 9, encryptedPayload: "active-session", iv: "aiv", tag: "atag", algorithm: "aes-256-gcm-client-e2e-v1", credentialHash: "cred", coherenceHash: "coh", revokedAt: null, revokeReason: null },
      { id: "session-revoked-residual", agencyId: "agency-1", creatorId: "creator-1", status: "REVOKED", revision: 4, encryptedPayload: "residual-session", iv: "riv", tag: "rtag", algorithm: "aes-256-gcm-client-e2e-v1", credentialHash: "old-cred", coherenceHash: "old-coh", revokedAt: new Date("2026-08-20T00:00:00Z"), revokeReason: "OLD_REVOKE" },
      { id: "session-other", agencyId: "agency-1", creatorId: "creator-2", status: "ACTIVE", revision: 2, encryptedPayload: "keep-session", iv: "oiv", tag: "otag", algorithm: "aes-256-gcm-client-e2e-v1", credentialHash: "other", coherenceHash: "other", revokedAt: null, revokeReason: null },
    ],
  };
  function updateMany(rows, { where, data }) {
    let count = 0;
    for (const row of rows) {
      if (!matches(where, row)) continue;
      apply(row, data);
      count += 1;
    }
    return { count };
  }
  return {
    state,
    db: {
      accessSnapshot: { updateMany: async (args) => updateMany(state.snapshots, args) },
      creatorDeviceKeyWrap: { updateMany: async (args) => updateMany(state.wraps, args) },
      agencyProxyEndpoint: { updateMany: async (args) => updateMany(state.proxies, args) },
      creatorNetworkProfile: { updateMany: async (args) => updateMany(state.profiles, args) },
      creatorSessionState: { updateMany: async (args) => updateMany(state.sessions, args) },
    },
  };
}

test("soft creator removal crypto-shreds legacy snapshot/proxy secrets and revokes current CDK wraps without deleting history", async () => {
  const { db, state } = makeDb();
  const retiredAt = new Date("2026-08-24T13:45:00Z");
  const result = await retireCreatorCryptoMaterialOnRemoval({ db, agencyId: "agency-1", creatorId: "creator-1", retiredAt });

  assert.deepEqual(result, {
    revokedAccessSnapshotCount: 1,
    retiredAccessSnapshotSecretCount: 2,
    revokedCreatorKeyWrapCount: 1,
    retiredDedicatedProxyCount: 1,
    retiredNetworkProfileCount: 1,
    revokedCanonicalSessionCount: 1,
    retiredCanonicalSessionSecretCount: 2,
  });

  const liveSnapshot = state.snapshots.find((row) => row.id === "snap-live");
  const oldSnapshot = state.snapshots.find((row) => row.id === "snap-old");
  for (const snapshot of [liveSnapshot, oldSnapshot]) {
    assert.equal(snapshot.encryptedPayload, null);
    assert.equal(snapshot.iv, null);
    assert.equal(snapshot.tag, null);
    assert.equal(snapshot.algorithm, null);
    assert.equal(snapshot.active, false);
    assert.equal(snapshot.payloadRetiredAt, retiredAt);
  }
  assert.equal(liveSnapshot.revokedAt, retiredAt);
  assert.equal(oldSnapshot.revokedAt.toISOString(), "2026-08-20T00:00:00.000Z", "existing revocation provenance must not be overwritten by later crypto-shred");
  assert.equal(state.snapshots.find((row) => row.creatorId === "creator-2").encryptedPayload, "keep-me");

  assert.equal(state.wraps.find((row) => row.id === "wrap-live").revokedAt, retiredAt);
  assert.ok(state.wraps.find((row) => row.id === "wrap-old").revokedAt instanceof Date, "historical wrap row is preserved");
  assert.equal(state.wraps.find((row) => row.id === "wrap-other").revokedAt, null);


  const activeSession = state.sessions.find((row) => row.id === "session-active");
  const residualSession = state.sessions.find((row) => row.id === "session-revoked-residual");
  assert.equal(activeSession.status, "REVOKED");
  assert.equal(activeSession.revision, 10);
  assert.equal(activeSession.revokedAt, retiredAt);
  assert.equal(activeSession.revokeReason, "CREATOR_REMOVED_FROM_AGENCY");
  for (const session of [activeSession, residualSession]) {
    assert.equal(session.encryptedPayload, null);
    assert.equal(session.iv, null);
    assert.equal(session.tag, null);
    assert.equal(session.algorithm, null);
    assert.equal(session.credentialHash, null);
    assert.equal(session.coherenceHash, null);
  }
  assert.equal(residualSession.revision, 4, "crypto-shredding an already revoked residual must not invent a new runtime revision");
  assert.equal(residualSession.revokedAt.toISOString(), "2026-08-20T00:00:00.000Z", "existing session revocation provenance must be preserved");
  assert.equal(residualSession.revokeReason, "OLD_REVOKE", "existing session revoke reason must be preserved");
  assert.equal(state.sessions.find((row) => row.id === "session-other").encryptedPayload, "keep-session");

  const dedicated = state.proxies.find((row) => row.id === "proxy-dedicated");
  assert.equal(dedicated.enabled, false);
  assert.equal(dedicated.version, 8);
  assert.equal(dedicated.encryptedPayload, null);
  assert.equal(dedicated.iv, null);
  assert.equal(dedicated.tag, null);
  assert.equal(dedicated.algorithm, null);
  assert.equal(dedicated.keyVersion, null);
  assert.equal(dedicated.hasCredentials, false);
  assert.equal(dedicated.usernameHint, null);

  const shared = state.proxies.find((row) => row.id === "proxy-shared");
  assert.equal(shared.enabled, true);
  assert.equal(shared.encryptedPayload, "shared-cipher", "shared proxy credentials must not be destroyed with one creator");

  const removedProfile = state.profiles.find((row) => row.creatorId === "creator-1");
  assert.equal(removedProfile.mode, "DIRECT", "soft-delete must release any shared proxy assignment owned by the removed creator profile");
  assert.equal(removedProfile.proxyEndpointId, null);
  assert.equal(removedProfile.version, 5);
  assert.equal(state.profiles.find((row) => row.creatorId === "creator-2").version, 2);
});

test("creator crypto retirement is idempotent and does not keep incrementing an already retired dedicated proxy", async () => {
  const { db, state } = makeDb();
  const retiredAt = new Date("2026-08-24T13:45:00Z");
  await retireCreatorCryptoMaterialOnRemoval({ db, agencyId: "agency-1", creatorId: "creator-1", retiredAt });
  const second = await retireCreatorCryptoMaterialOnRemoval({ db, agencyId: "agency-1", creatorId: "creator-1", retiredAt: new Date("2026-08-24T13:46:00Z") });
  assert.deepEqual(second, { revokedAccessSnapshotCount: 0, retiredAccessSnapshotSecretCount: 0, revokedCreatorKeyWrapCount: 0, retiredDedicatedProxyCount: 0, retiredNetworkProfileCount: 0, revokedCanonicalSessionCount: 0, retiredCanonicalSessionSecretCount: 0 });
  assert.equal(state.proxies.find((row) => row.id === "proxy-dedicated").version, 8);
});

test("both agency and platform-admin soft-delete paths call crypto retirement inside their creator delete transaction", () => {
  const creators = fs.readFileSync(path.join(__dirname, "..", "routes", "creators.js"), "utf8");
  const admin = fs.readFileSync(path.join(__dirname, "..", "routes", "admin.js"), "utf8");
  assert.match(creators, /retireCreatorCryptoMaterialOnRemoval\(\{[\s\S]*?db: tx,[\s\S]*?creatorId: existing\.id,[\s\S]*?retiredAt: removedAt/);
  assert.match(admin, /retireCreatorCryptoMaterialOnRemoval\(\{[\s\S]*?db: tx,[\s\S]*?creatorId: before\.id,[\s\S]*?retiredAt: deletedAt/);
  assert.doesNotMatch(creators, /accessSnapshot\.updateMany\(\{ where: \{ creatorId: existing\.id, active: true \}/);
});
