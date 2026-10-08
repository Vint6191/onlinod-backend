"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyActorProof, findRootExposureDebt, findUntrustedCreatorExposureDebt } = require('./client-e2e-keyring-service');
const ACTOR_PROOF = Buffer.alloc(32, 0x07).toString('base64');
const ACTOR_PROOF_HASH = crypto.createHash('sha256').update(Buffer.from(ACTOR_PROOF, 'base64')).digest('base64');

// The optional V20.19 migration endpoint was permanently removed in V20.22.
// Its continuing security obligations are tested through current debt readers,
// actor proof and the irreversible schema fence; no legacy API is reintroduced.
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
  db.$transaction = async (fn) => fn({ ...(db), $transaction: undefined });
  return { root, proxies, identities, ownerWraps, accessSnapshots, db };
}

test('owner key changes still require a pinned recovery proof', () => {
  const { root } = makeDb(); root.recoveryProofHash = null;
  assert.throws(() => verifyActorProof(root, ACTOR_PROOF), error => error.code === 'CRYPTO_ACTOR_PROOF_UNAVAILABLE');
});
test('owner proof rejects a wrong secret and accepts the pinned value', () => {
  const { root } = makeDb();
  assert.throws(() => verifyActorProof(root, Buffer.alloc(32, 9).toString('base64')), error => error.code === 'CRYPTO_ACTOR_PROOF_MISMATCH');
  assert.doesNotThrow(() => verifyActorProof(root, ACTOR_PROOF));
});
test('former-owner knowledge remains root exposure after wrap revocation', async () => {
  const { db } = makeDb({ rootExposure: true });
  assert.deepEqual(await findRootExposureDebt({ db, agencyId: 'agency-1' }), {
    deviceIds: ['former-owner-device'], exposures: [{ deviceId: 'former-owner-device', rootVersion: 2 }],
  });
});
test('an active device that lost creator scope retains current CDK exposure debt', async () => {
  const { db } = makeDb({ creatorExposure: true });
  assert.deepEqual(await findUntrustedCreatorExposureDebt({ db, agencyId: 'agency-1' }), {
    deviceIds: ['access-revoked-device'], creatorIds: ['creator-1'],
    exposures: [{ deviceId: 'access-revoked-device', creatorId: 'creator-1', keyVersion: 1 }],
  });
});
test('soft-deleted creators are excluded from active CDK exposure debt', async () => {
  const { db } = makeDb({ creatorExposure: true, creatorDeleted: true });
  assert.deepEqual(await findUntrustedCreatorExposureDebt({ db, agencyId: 'agency-1' }), { deviceIds: [], creatorIds: [], exposures: [] });
});
test('current crypto trust uses immutable identity independently of WorkerDevice telemetry', async () => {
  const { db } = makeDb();
  db.workerDevice.findFirst = () => { throw Error('telemetry must not decide key knowledge'); };
  assert.deepEqual((await findRootExposureDebt({ db, agencyId: 'agency-1' })).deviceIds, []);
});
test('deleted identity cannot erase historical owner-root exposure', async () => {
  const { db, identities, ownerWraps } = makeDb(); identities.length = 0;
  ownerWraps.push({ agencyId: 'agency-1', rootVersion: 2, deviceId: 'lost-owner-device', revokedAt: new Date() });
  assert.deepEqual((await findRootExposureDebt({ db, agencyId: 'agency-1' })).deviceIds, ['lost-owner-device', 'owner-device']);
});
test('rotating the root alone cannot clear knowledge while a live creator still references its old generation', async () => {
  const { db, root } = makeDb({ rootExposure: true }); root.version = 3;
  assert.deepEqual((await findRootExposureDebt({ db, agencyId: 'agency-1' })).exposures, [{ deviceId: 'former-owner-device', rootVersion: 2 }]);
});
test('current security debt does not inspect or mutate retired legacy secret stores', async () => {
  const { db } = makeDb({ legacySessions: 2, legacyProxies: 3, legacyAccessSnapshots: 4 });
  for (const key of ['creatorSessionState', 'agencyProxyEndpoint', 'accessSnapshot']) db[key] = new Proxy({}, { get() { throw Error('legacy secret store accessed'); } });
  assert.deepEqual((await findRootExposureDebt({ db, agencyId: 'agency-1' })).exposures, []);
  assert.deepEqual((await findUntrustedCreatorExposureDebt({ db, agencyId: 'agency-1' })).exposures, []);
});
test('CLIENT_E2E is structurally mandatory and cannot be downgraded through a migration API', () => {
  const root = path.resolve(__dirname, '../..');
  const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
  const mode = schema.match(/enum SecretEncryptionMode \{([\s\S]*?)\n\}/)?.[1];
  assert(mode); assert.match(mode, /CLIENT_E2E_V1/); assert.doesNotMatch(mode, /SERVER_V1/);
  const route = fs.readFileSync(path.join(root, 'src/routes/client-e2e-keyring.js'), 'utf8');
  assert.match(route, /getCryptoSecurityDebt/); assert.doesNotMatch(route, /migration-status|enforce-opaque|migrate-opaque/);
  const exports = require('./client-e2e-keyring-service');
  assert.equal(exports.enforceOpaqueSecrets, undefined); assert.equal(exports.getCryptoMigrationStatus, undefined);
  const migration = fs.readFileSync(path.join(root, 'prisma/migrations/20260825010000_client_e2e_enum_finalization_v20_22/migration.sql'), 'utf8');
  assert.match(migration, /SERVER_V1 creator session rows remain/); assert.match(migration, /SERVER_V1 proxy rows remain/);
  assert.match(migration, /CREATE TYPE "SecretEncryptionMode" AS ENUM \('CLIENT_E2E_V1'\)/);
});
