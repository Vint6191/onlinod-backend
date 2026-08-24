"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  enforceOpaqueSecrets: enforceOpaqueSecretsRaw,
  getCryptoMigrationStatus,
} = require("./client-e2e-keyring-service");

const ACTOR_PROOF = Buffer.alloc(32, 0x07).toString("base64");
const ACTOR_PROOF_HASH = crypto.createHash("sha256").update(Buffer.from(ACTOR_PROOF, "base64")).digest("base64");
function enforceOpaqueSecrets(args) { return enforceOpaqueSecretsRaw({ ...args, actorProof: args.actorProof ?? ACTOR_PROOF }); }

const owner = { role: "OWNER", roleKey: "owner" };

function makeDb({ legacySessions = 0, legacyProxies = 0, legacyAccessSnapshots = 0, residualSessionSecret = false, residualProxySecret = false, rootExposure = false, creatorExposure = false, creatorDeleted = false } = {}) {
  const root = {
    agencyId: "agency-1",
    version: 2,
    status: "ACTIVE",
    enforceOpaqueSecrets: false,
    enforcedAt: null,
    initializedAt: new Date("2026-08-23T18:00:00Z"),
    updatedAt: new Date("2026-08-23T18:00:00Z"),
    recoveryProofHash: ACTOR_PROOF_HASH,
  };
  const sessions = Array.from({ length: legacySessions }, (_, index) => ({
    creatorId: `creator-${index + 1}`,
    revision: 10 + index,
    updatedAt: new Date("2026-08-23T18:00:00Z"),
    creator: { displayName: `Creator ${index + 1}`, username: `creator${index + 1}` },
  }));
  const proxies = Array.from({ length: legacyProxies }, (_, index) => ({
    id: `proxy-${index + 1}`,
    label: `Proxy ${index + 1}`,
    version: 3,
    ownerCreatorId: index === 0 ? null : `creator-${index + 1}`,
    updatedAt: new Date("2026-08-23T18:00:00Z"),
    ownerCreator: index === 0 ? null : { displayName: `Creator ${index + 1}`, username: `creator${index + 1}` },
    creatorProfile: index === 0 ? null : { creatorId: `creator-${index + 1}`, mode: "PROXY", creator: { displayName: `Creator ${index + 1}`, username: `creator${index + 1}` } },
  }));
  const accessSnapshots = Array.from({ length: legacyAccessSnapshots }, (_, index) => ({
    id: `snapshot-${index + 1}`,
    agencyId: "agency-1",
    creatorId: `creator-${index + 1}`,
    encryptedPayload: `cipher-${index + 1}`,
    iv: "iv",
    tag: "tag",
    algorithm: "aes-256-gcm",
    active: true,
    revokedAt: null,
    payloadRetiredAt: null,
  }));
  const identities = [
    { deviceId: "owner-device", agencyId: "agency-1", userId: "owner-user", status: "ACTIVE", revokedAt: null },
    ...(rootExposure ? [{ deviceId: "former-owner-device", agencyId: "agency-1", userId: "former-owner-user", status: "ACTIVE", revokedAt: null }] : []),
    ...(creatorExposure ? [{ deviceId: "access-revoked-device", agencyId: "agency-1", userId: "access-revoked-user", status: "ACTIVE", revokedAt: null }] : []),
  ];
  const members = [
    { agencyId: "agency-1", userId: "owner-user", role: "OWNER", roleKey: "owner", assignedCreators: null, deletedAt: null, deactivatedAt: null },
    ...(rootExposure ? [{ agencyId: "agency-1", userId: "former-owner-user", role: "OPERATOR", roleKey: "chatter", assignedCreators: [], deletedAt: null, deactivatedAt: null }] : []),
    ...(creatorExposure ? [{ agencyId: "agency-1", userId: "access-revoked-user", role: "WORKER", roleKey: "chatter", assignedCreators: [], deletedAt: null, deactivatedAt: null }] : []),
  ];
  const ownerWraps = [
    { id: "owner-wrap", agencyId: "agency-1", rootVersion: 2, deviceId: "owner-device", revokedAt: null },
    ...(rootExposure ? [{ id: "former-owner-wrap", agencyId: "agency-1", rootVersion: 2, deviceId: "former-owner-device", revokedAt: new Date("2026-08-23T19:00:00Z") }] : []),
  ];
  const keyStates = [{ agencyId: "agency-1", creatorId: "creator-1", rootVersion: 2, activeVersion: 1 }];
  const creatorWraps = creatorExposure
    ? [{ id: "access-revoked-wrap", agencyId: "agency-1", creatorId: "creator-1", keyVersion: 1, deviceId: "access-revoked-device", revokedAt: null }]
    : [];
  const matches = (where, row) => {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = row?.[key];
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        if (Array.isArray(expected.in)) return expected.in.includes(actual);
        if (Array.isArray(expected.notIn)) return !expected.notIn.includes(actual);
        if (Object.prototype.hasOwnProperty.call(expected, "not")) return actual !== expected.not;
      }
      return actual === expected;
    });
  };
  const db = {
    workerDevice: {
      findFirst: async ({ where }) => where.id === "owner-device" && where.agencyId === "agency-1" && where.userId === "owner-user"
        ? { id: "owner-device", agencyId: "agency-1", userId: "owner-user" }
        : null,
    },
    agencyCryptoRoot: {
      findUnique: async () => ({ ...root }),
      update: async ({ data }) => { Object.assign(root, data, { updatedAt: new Date() }); return { ...root }; },
    },
    agencyCryptoOwnerKeyWrap: {
      findFirst: async ({ where } = {}) => ownerWraps.find((row) => matches(where, row)) || null,
      findMany: async ({ where } = {}) => ownerWraps.filter((row) => matches(where, row)).map((row) => ({ ...row })),
    },
    creatorAccount: {
      findMany: async ({ where } = {}) => {
        if (where.agencyId !== "agency-1" || creatorDeleted) return [];
        return [{ id: "creator-1" }];
      },
    },
    creatorCryptoKeyState: {
      findMany: async ({ where } = {}) => keyStates.filter((row) => matches(where, row)).map((row) => ({ ...row })),
    },
    creatorDeviceKeyWrap: {
      findMany: async ({ where } = {}) => creatorWraps.filter((row) => matches(where, row)).map((row) => ({ ...row })),
    },
    deviceCryptoIdentity: {
      findUnique: async ({ where } = {}) => {
        const composite = where?.agencyId_deviceId || {};
        return identities.find((row) => row.agencyId === composite.agencyId && row.deviceId === composite.deviceId) || null;
      },
      findMany: async ({ where } = {}) => identities.filter((row) => matches(where, row)).map((row) => ({ ...row })),
    },
    agencyMember: {
      findUnique: async ({ where } = {}) => {
        const key = where?.agencyId_userId || {};
        const row = members.find((item) => item.agencyId === key.agencyId && item.userId === key.userId);
        return row ? { ...row } : null;
      },
      findMany: async ({ where } = {}) => members.filter((row) => matches(where, row)).map((row) => ({ ...row })),
    },
    creatorSessionState: {
      count: async () => sessions.length,
      findMany: async () => sessions.map((row) => structuredClone(row)),
      updateMany: async () => ({ count: residualSessionSecret ? 1 : 0 }),
    },
    agencyProxyEndpoint: {
      count: async () => proxies.length,
      findMany: async () => proxies.map((row) => structuredClone(row)),
      updateMany: async () => ({ count: residualProxySecret ? 1 : 0 }),
    },
    accessSnapshot: {
      count: async () => accessSnapshots.filter((row) => row.encryptedPayload != null).length,
      updateMany: async ({ data }) => {
        let count = 0;
        for (const row of accessSnapshots) {
          if (row.encryptedPayload == null) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
  };
  db.$transaction = async (fn) => fn(db);
  return { root, proxies, identities, ownerWraps, accessSnapshots, db };
}

test("opaque enforcement is forbidden until a recovery proof is pinned", async () => {
  const { db, root } = makeDb({ legacySessions: 0, legacyProxies: 0 });
  root.recoveryProofHash = null;
  const status = await getCryptoMigrationStatus({ db, agencyId: "agency-1", userId: "owner-user", member: owner });
  assert.equal(status.root.recoveryProofAvailable, false);
  assert.equal(status.readyToEnforce, false);
  await assert.rejects(
    enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" }),
    (error) => error?.code === "CRYPTO_ACTOR_PROOF_UNAVAILABLE",
  );
  assert.equal(root.enforceOpaqueSecrets, false);
});

test("opaque enforcement is forbidden while any legacy creator session remains", async () => {
  const { db, root } = makeDb({ legacySessions: 1, legacyProxies: 0 });
  await assert.rejects(
    enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" }),
    (error) => error?.code === "CRYPTO_MIGRATION_INCOMPLETE" && error?.legacySessions === 1 && error?.legacyProxyCredentials === 0,
  );
  assert.equal(root.enforceOpaqueSecrets, false);
});

test("opaque enforcement is forbidden while any legacy proxy credential remains", async () => {
  const { db, root } = makeDb({ legacySessions: 0, legacyProxies: 1 });
  await assert.rejects(
    enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" }),
    (error) => error?.code === "CRYPTO_MIGRATION_INCOMPLETE" && error?.legacySessions === 0 && error?.legacyProxyCredentials === 1,
  );
  assert.equal(root.enforceOpaqueSecrets, false);
});

test("opaque enforcement becomes irreversible only after both legacy counts reach zero", async () => {
  const { db, root } = makeDb({ legacySessions: 0, legacyProxies: 0 });
  const result = await enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" });
  assert.equal(result.enforced, true);
  assert.equal(root.enforceOpaqueSecrets, true);
  assert.ok(root.enforcedAt instanceof Date);
});

test("migration status reports exact counts and blocks unclaimed legacy proxy credentials", async () => {
  const { db } = makeDb({ legacySessions: 2, legacyProxies: 2 });
  const result = await getCryptoMigrationStatus({ db, agencyId: "agency-1", userId: "owner-user", member: owner });
  assert.equal(result.legacySessionCount, 2);
  assert.equal(result.legacyProxyCredentialCount, 2);
  assert.equal(result.totalLegacyCount, 4);
  assert.equal(result.readyToEnforce, false);
  assert.equal(result.proxies[0].autoMigratable, false);
  assert.equal(result.proxies[0].blocker, "PROXY_OWNER_REQUIRED");
  assert.equal(result.proxies[1].autoMigratable, true);
  assert.equal(result.proxies[1].blocker, null);
});


test("migration status treats a DIRECT creator's owned dedicated legacy proxy as auto-migratable", async () => {
  const { db, proxies } = makeDb({ legacySessions: 0, legacyProxies: 2 });
  proxies[1].creatorProfile = { creatorId: "creator-2", mode: "DIRECT", creator: { displayName: "Creator 2", username: "creator2" } };
  const result = await getCryptoMigrationStatus({ db, agencyId: "agency-1", userId: "owner-user", member: owner });
  const owned = result.proxies.find((row) => row.proxyId === "proxy-2");
  assert.equal(owned.ownerCreatorId, "creator-2");
  assert.equal(owned.assignedCreatorId, null);
  assert.equal(owned.autoMigratable, true);
  assert.equal(owned.blocker, null);
});

test("opaque enforcement is forbidden when a former owner still knows a root generation protecting active state", async () => {
  const { db, root } = makeDb({ legacySessions: 0, legacyProxies: 0, rootExposure: true });
  const status = await getCryptoMigrationStatus({ db, agencyId: "agency-1", userId: "owner-user", member: owner });
  assert.equal(status.rootRotationRequired, true);
  assert.equal(status.rootExposureDeviceCount, 1);
  assert.equal(status.readyToEnforce, false);
  await assert.rejects(
    enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" }),
    (error) => error?.code === "CRYPTO_ROOT_ROTATION_REQUIRED" && error?.rootExposureCount === 1,
  );
  assert.equal(root.enforceOpaqueSecrets, false);
});


test("opaque enforcement is forbidden while a still-active device that lost creator access knows the current CDK", async () => {
  const { db, root } = makeDb({ creatorExposure: true });
  const status = await getCryptoMigrationStatus({ db, agencyId: "agency-1", userId: "owner-user", member: owner });
  assert.equal(status.untrustedCreatorRotationRequired, true);
  assert.equal(status.untrustedCreatorExposureDeviceCount, 1);
  assert.deepEqual(status.untrustedCreatorExposureCreatorIds, ["creator-1"]);
  assert.equal(status.readyToEnforce, false);
  await assert.rejects(
    enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" }),
    (error) => error?.code === "CRYPTO_CREATOR_ROTATION_REQUIRED"
      && error?.creatorExposureCount === 1
      && error?.creatorExposureCreatorIds?.[0] === "creator-1",
  );
  assert.equal(root.enforceOpaqueSecrets, false);
});

test("soft-deleted creators are not active creator-key exposure debt for irreversible enforcement", async () => {
  const { db, root } = makeDb({ creatorExposure: true, creatorDeleted: true });
  const status = await getCryptoMigrationStatus({ db, agencyId: "agency-1", userId: "owner-user", member: owner });
  assert.equal(status.untrustedCreatorRotationRequired, false);
  assert.deepEqual(status.untrustedCreatorExposureCreatorIds, []);
  assert.equal(status.readyToEnforce, true);
  const result = await enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" });
  assert.equal(result.enforced, true);
  assert.equal(root.enforceOpaqueSecrets, true);
});

test("opaque enforcement uses immutable crypto identity even when WorkerDevice telemetry moved away", async () => {
  const { db, root } = makeDb({ legacySessions: 0, legacyProxies: 0 });
  db.workerDevice.findFirst = async () => null;
  const result = await enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" });
  assert.equal(result.enforced, true);
  assert.equal(root.enforceOpaqueSecrets, true);
});

test("deleted crypto identity cannot erase historical owner-root exposure debt", async () => {
  const { db, identities, ownerWraps } = makeDb({ legacySessions: 0, legacyProxies: 0 });
  identities.splice(0, identities.length);
  ownerWraps.push({ id: "orphan-owner-wrap", agencyId: "agency-1", rootVersion: 2, deviceId: "lost-owner-device", revokedAt: new Date("2026-08-23T19:00:00Z") });
  const status = await getCryptoMigrationStatus({ db, agencyId: "agency-1", userId: "owner-user", member: owner });
  assert.equal(status.rootRotationRequired, true);
  assert.ok(status.rootExposureDeviceCount >= 1);
  assert.equal(status.readyToEnforce, false);
});

test("opaque enforcement crypto-shreds legacy AccessSnapshot secret material atomically instead of treating it as canonical migration debt", async () => {
  const { db, root, accessSnapshots } = makeDb({ legacyAccessSnapshots: 2 });
  const status = await getCryptoMigrationStatus({ db, agencyId: "agency-1", userId: "owner-user", member: owner });
  assert.equal(status.legacyAccessSnapshotSecretCount, 2);
  assert.equal(status.legacyAccessSnapshotRetirementRequired, true);
  assert.equal(status.readyToEnforce, true);

  const result = await enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" });
  assert.equal(result.retiredLegacyAccessSnapshots, 2);
  assert.equal(root.enforceOpaqueSecrets, true);
  for (const row of accessSnapshots) {
    assert.equal(row.encryptedPayload, null);
    assert.equal(row.iv, null);
    assert.equal(row.tag, null);
    assert.equal(row.algorithm, null);
    assert.equal(row.active, false);
    assert.ok(row.payloadRetiredAt instanceof Date);
  }
});

test("idempotent enforcement cleans residual AccessSnapshot ciphertext from an earlier V20.19 intermediate", async () => {
  const { db, root, accessSnapshots } = makeDb({ legacyAccessSnapshots: 1 });
  root.enforceOpaqueSecrets = true;
  root.enforcedAt = new Date("2026-08-23T20:00:00Z");
  const result = await enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" });
  assert.equal(result.enforced, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.retiredLegacyAccessSnapshots, 1);
  assert.equal(accessSnapshots[0].encryptedPayload, null);
  assert.ok(accessSnapshots[0].payloadRetiredAt instanceof Date);
});

test("opaque enforcement retires inconsistent residual SERVER_V1 ciphertext even when active migration counters are zero", async () => {
  const { db } = makeDb({ residualSessionSecret: true, residualProxySecret: true });
  const result = await enforceOpaqueSecrets({ db, agencyId: "agency-1", userId: "owner-user", member: owner, deviceId: "owner-device" });
  assert.equal(result.retiredLegacySessionResiduals, 1);
  assert.equal(result.retiredLegacyProxyResiduals, 1);
});
