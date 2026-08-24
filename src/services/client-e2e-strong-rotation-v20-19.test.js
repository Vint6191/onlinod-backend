"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  approveDevice: approveDeviceRaw,
  registerDeviceIdentity,
  recoverOwnerDevice,
  getCryptoStatus,
  listCryptoDevices,
  findUntrustedCreatorExposureDebt,
  revokeOwnerRootAccessForMember,
  getCreatorKeyState,
  initializeCreatorKeyState,
  assertDeviceCanUseCreatorKey,
  commitCreatorKeyRotation: commitCreatorKeyRotationRaw,
  getDeviceRevocationPlan,
  getDeviceApprovalPlan,
  beginRootRotation: beginRootRotationRaw,
  getRootRotationBridge,
  getRootRotationProgress,
  finalizeRootRotation: finalizeRootRotationRaw,
  softRevokeDevice: softRevokeDeviceRaw,
  retireCurrentDeviceIdentity,
} = require("./client-e2e-keyring-service");

const ACTOR_PROOF = Buffer.alloc(32, 0x5a).toString("base64");
function actorProofHash() { return crypto.createHash("sha256").update(Buffer.from(ACTOR_PROOF, "base64")).digest("base64"); }
function approveDevice(args) { return approveDeviceRaw({ ...args, actorProof: args.actorProof ?? ACTOR_PROOF }); }
function beginRootRotation(args) { return beginRootRotationRaw({ ...args, actorProof: args.actorProof ?? ACTOR_PROOF }); }
function finalizeRootRotation(args) { return finalizeRootRotationRaw({ ...args, actorProof: args.actorProof ?? ACTOR_PROOF }); }
function commitCreatorKeyRotation(args) { return commitCreatorKeyRotationRaw({ ...args, actorProof: args.actorProof ?? ACTOR_PROOF }); }
function softRevokeDevice(args) { return softRevokeDeviceRaw({ ...args, actorProof: args.actorProof ?? ACTOR_PROOF }); }

function x25519PublicKey() {
  const pair = crypto.generateKeyPairSync("x25519");
  return Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64");
}

function wrapEnvelope() {
  return {
    ephemeralPublicKey: x25519PublicKey(),
    ciphertext: crypto.randomBytes(32).toString("base64"),
    iv: crypto.randomBytes(12).toString("base64"),
    tag: crypto.randomBytes(16).toString("base64"),
    algorithm: "x25519-hkdf-sha256-aes-256-gcm-v1",
  };
}

function secretEnvelope(keyVersion) {
  return {
    encryptionMode: "CLIENT_E2E_V1",
    keyVersion,
    ciphertext: crypto.randomBytes(96).toString("base64"),
    iv: crypto.randomBytes(12).toString("base64"),
    tag: crypto.randomBytes(16).toString("base64"),
    algorithm: "aes-256-gcm-client-e2e-v1",
  };
}


function recoveryProof() {
  return ACTOR_PROOF;
}

function recoveryEnvelope() {
  return {
    ciphertext: crypto.randomBytes(32).toString("base64"),
    iv: crypto.randomBytes(12).toString("base64"),
    tag: crypto.randomBytes(16).toString("base64"),
    algorithm: "aes-256-gcm-recovery-v1",
  };
}

function rootBridgeEnvelope() {
  return {
    ciphertext: crypto.randomBytes(32).toString("base64"),
    iv: crypto.randomBytes(12).toString("base64"),
    tag: crypto.randomBytes(16).toString("base64"),
    algorithm: "aes-256-gcm-root-bridge-v1",
  };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function makeDb({ targetOwner = false } = {}) {
  const now = new Date("2026-08-23T18:00:00.000Z");
  const state = {
    root: { agencyId: "agency-1", version: 1, status: "ACTIVE", enforceOpaqueSecrets: true, recoveryProofHash: actorProofHash() },
    creatorDeleted: false,
    identities: new Map([
      ["owner-device", { deviceId: "owner-device", agencyId: "agency-1", userId: "owner-user", publicKey: x25519PublicKey(), fingerprint: "fp-owner", status: "ACTIVE", revokedAt: null, device: { id: "owner-device", userId: "owner-user" } }],
      ["worker-device", { deviceId: "worker-device", agencyId: "agency-1", userId: "worker-user", publicKey: x25519PublicKey(), fingerprint: "fp-worker", status: "ACTIVE", revokedAt: null, device: { id: "worker-device", userId: "worker-user" } }],
      ["target-device", { deviceId: "target-device", agencyId: "agency-1", userId: targetOwner ? "other-owner" : "target-user", publicKey: x25519PublicKey(), fingerprint: "fp-target", status: "ACTIVE", revokedAt: null, device: { id: "target-device", userId: targetOwner ? "other-owner" : "target-user" } }],
    ]),
    devices: new Map([
      ["owner-device", { id: "owner-device", agencyId: "agency-1", userId: "owner-user" }],
      ["worker-device", { id: "worker-device", agencyId: "agency-1", userId: "worker-user" }],
      ["target-device", { id: "target-device", agencyId: "agency-1", userId: targetOwner ? "other-owner" : "target-user" }],
    ]),
    members: [
      { agencyId: "agency-1", userId: "owner-user", role: "OWNER", roleKey: "owner", assignedCreators: null, deletedAt: null, deactivatedAt: null },
      { agencyId: "agency-1", userId: "worker-user", role: "WORKER", roleKey: "chatter", assignedCreators: ["creator-1"], deletedAt: null, deactivatedAt: null },
      { agencyId: "agency-1", userId: targetOwner ? "other-owner" : "target-user", role: targetOwner ? "OWNER" : "WORKER", roleKey: targetOwner ? "owner" : "chatter", assignedCreators: targetOwner ? null : ["creator-1"], deletedAt: null, deactivatedAt: null },
    ],
    rootBridges: [],
    ownerWraps: [
      { id: "ow-owner", agencyId: "agency-1", rootVersion: 1, deviceId: "owner-device", revokedAt: null },
      ...(targetOwner ? [{ id: "ow-target", agencyId: "agency-1", rootVersion: 1, deviceId: "target-device", revokedAt: null }] : []),
    ],
    keyState: { id: "ks-1", agencyId: "agency-1", creatorId: "creator-1", activeVersion: 1, rootVersion: 1 },
    creatorWraps: [
      { id: "cw-worker-v1", agencyId: "agency-1", creatorId: "creator-1", keyVersion: 1, deviceId: "worker-device", revokedAt: null },
      ...(!targetOwner ? [{ id: "cw-target-v1", agencyId: "agency-1", creatorId: "creator-1", keyVersion: 1, deviceId: "target-device", revokedAt: null }] : []),
    ],
    session: {
      id: "session-1", agencyId: "agency-1", creatorId: "creator-1", status: "ACTIVE", revision: 7, payloadVersion: 1,
      encryptionMode: "CLIENT_E2E_V1", keyVersion: 1, encryptedPayload: crypto.randomBytes(64).toString("base64"),
      iv: crypto.randomBytes(12).toString("base64"), tag: crypto.randomBytes(16).toString("base64"), algorithm: "aes-256-gcm-client-e2e-v1",
    },
    proxy: {
      id: "proxy-1", agencyId: "agency-1", ownerCreatorId: "creator-1", version: 4, hasCredentials: true,
      encryptionMode: "CLIENT_E2E_V1", keyVersion: 1, encryptedPayload: crypto.randomBytes(64).toString("base64"),
      iv: crypto.randomBytes(12).toString("base64"), tag: crypto.randomBytes(16).toString("base64"), algorithm: "aes-256-gcm-client-e2e-v1", usernameHint: "a***z",
    },
    profile: { id: "profile-1", agencyId: "agency-1", creatorId: "creator-1", mode: "PROXY", proxyEndpointId: "proxy-1", version: 3, updatedByUserId: null },
    refreshSessions: [
      { id: "rs-target", userId: targetOwner ? "other-owner" : "target-user", agencyId: "agency-1", deviceId: "target-device", revokedAt: null },
      { id: "rs-other", userId: "worker-user", agencyId: "agency-1", deviceId: "worker-device", revokedAt: null },
    ],
  };

  function match(where, row) {
    if (!where) return true;
    for (const [key, expected] of Object.entries(where)) {
      if (key === "NOT") continue;
      const actual = row?.[key];
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        if ("in" in expected && !expected.in.includes(actual)) return false;
        else if ("notIn" in expected && expected.notIn.includes(actual)) return false;
        else if ("lt" in expected && !(actual < expected.lt)) return false;
        else if ("lte" in expected && !(actual <= expected.lte)) return false;
        else if ("not" in expected && actual === expected.not) return false;
        else if (!("in" in expected) && !("notIn" in expected) && !("lt" in expected) && !("lte" in expected) && !("not" in expected) && !match(expected, actual)) return false;
      } else if (actual !== expected) return false;
    }
    return true;
  }

  function applyData(row, data) {
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && "increment" in value) row[key] = Number(row[key] || 0) + Number(value.increment);
      else row[key] = clone(value);
    }
    return row;
  }

  const db = {
    $transaction: async (fn) => fn(db),
    workerDevice: {
      findFirst: async ({ where }) => clone([...state.devices.values()].find((row) => match(where, row)) || null),
      findMany: async ({ where }) => [...state.devices.values()].filter((row) => match(where, row)).map(clone),
    },
    deviceCryptoIdentity: {
      findUnique: async ({ where }) => {
        const key = where.agencyId_deviceId || { agencyId: where.agencyId, deviceId: where.deviceId };
        const row = state.identities.get(key.deviceId) || null;
        return row && (!key.agencyId || row.agencyId === key.agencyId) ? clone(row) : null;
      },
      findMany: async ({ where }) => [...state.identities.values()].filter((row) => match(where, row)).map(clone),
      update: async ({ where, data }) => {
        const key = where.agencyId_deviceId || { agencyId: where.agencyId, deviceId: where.deviceId };
        const row = state.identities.get(key.deviceId);
        if (!row || (key.agencyId && row.agencyId !== key.agencyId)) throw new Error('identity not found');
        applyData(row, data); return clone(row);
      },
    },
    agencyCryptoRoot: {
      findUnique: async ({ where }) => where.agencyId === state.root.agencyId ? clone(state.root) : null,
      updateMany: async ({ where, data }) => { if (!match(where,state.root)) return { count:0 }; applyData(state.root,data); return { count:1 }; },
    },
    agencyCryptoRootBridge: {
      findFirst: async ({ where }) => clone(state.rootBridges.find((row) => match(where, row)) || null),
      findUnique: async ({ where }) => {
        const key = where.agencyId_fromVersion_toVersion;
        return clone(state.rootBridges.find((row) => row.agencyId === key.agencyId && row.fromVersion === key.fromVersion && row.toVersion === key.toVersion) || null);
      },
      upsert: async ({ where, create, update }) => {
        const key = where.agencyId_fromVersion_toVersion;
        let row = state.rootBridges.find((x) => x.agencyId === key.agencyId && x.fromVersion === key.fromVersion && x.toVersion === key.toVersion);
        if (!row) { row = { id: `rb-${key.fromVersion}-${key.toVersion}`, ...clone(create), retiredAt: null }; state.rootBridges.push(row); }
        else applyData(row, update);
        return clone(row);
      },
      updateMany: async ({ where, data }) => { let count = 0; for (const row of state.rootBridges) if (match(where, row)) { applyData(row, data); count += 1; } return { count }; },
    },
    agencyCryptoOwnerKeyWrap: {
      findFirst: async ({ where }) => clone(state.ownerWraps.find((row) => match(where, row)) || null),
      findMany: async ({ where }) => state.ownerWraps.filter((row) => match(where, row)).map(clone),
      upsert: async ({ where, create, update }) => {
        const key = where.agencyId_rootVersion_deviceId;
        let row = state.ownerWraps.find((x) => x.agencyId===key.agencyId && x.rootVersion===key.rootVersion && x.deviceId===key.deviceId);
        if (!row) { row={ id:`ow-${key.deviceId}-v${key.rootVersion}`, ...clone(create), revokedAt:null }; state.ownerWraps.push(row); } else applyData(row, update);
        return clone(row);
      },
      updateMany: async ({ where, data }) => { let count=0; for (const row of state.ownerWraps) if (match(where,row)) { applyData(row,data); count++; } return { count }; },
    },
    agencyMember: {
      findMany: async ({ where }) => state.members.filter((row) => match(where,row)).map(clone),
      findUnique: async ({ where }) => {
        const key = where.agencyId_userId;
        return clone(state.members.find((row) => row.agencyId === key.agencyId && row.userId === key.userId) || null);
      },
    },
    creatorAccount: {
      findFirst: async ({ where }) => where.id === "creator-1" && where.agencyId === "agency-1" && !(where.deletedAt === null && state.creatorDeleted)
        ? { id: "creator-1", displayName: "Creator", username: "creator", deletedAt: state.creatorDeleted ? now : null }
        : null,
      findMany: async ({ where }) => {
        if (where.agencyId !== "agency-1") return [];
        if (where.deletedAt === null && state.creatorDeleted) return [];
        if (where.id?.in && !where.id.in.includes("creator-1")) return [];
        return [{ id: "creator-1", displayName: "Creator", username: "creator", deletedAt: state.creatorDeleted ? now : null, cryptoKeyState: clone(state.keyState) }];
      },
    },
    creatorCryptoKeyState: {
      findUnique: async ({ where }) => state.keyState && where.agencyId_creatorId?.creatorId === "creator-1" ? clone(state.keyState) : null,
      findMany: async ({ where }) => state.keyState && match(where, state.keyState) ? [clone(state.keyState)] : [],
      findFirst: async ({ where }) => state.keyState && match(where, state.keyState) ? clone(state.keyState) : null,
      count: async ({ where }) => state.keyState && match(where, state.keyState) ? 1 : 0,
      updateMany: async ({ where, data }) => { if (!state.keyState || !match(where,state.keyState)) return { count:0 }; applyData(state.keyState,data); return { count:1 }; },
      upsert: async ({ where, create, update }) => {
        const key = where.agencyId_creatorId;
        if (state.keyState && key.agencyId === state.keyState.agencyId && key.creatorId === state.keyState.creatorId) { applyData(state.keyState, update); return clone(state.keyState); }
        state.keyState = { id: "ks-created", ...clone(create) };
        return clone(state.keyState);
      },
      create: async ({ data }) => {
        if (state.keyState) { const error = new Error("unique"); error.code = "P2002"; throw error; }
        state.keyState = { id: "ks-created", ...clone(data) };
        return clone(state.keyState);
      },
    },
    creatorSessionState: {
      findUnique: async ({ where }) => where.creatorId === "creator-1" ? clone(state.session) : null,
      updateMany: async ({ where, data }) => { if (!match(where,state.session)) return { count:0 }; applyData(state.session,data); return { count:1 }; },
    },
    agencyProxyEndpoint: {
      findFirst: async ({ where }) => match(where,state.proxy) ? clone(state.proxy) : null,
      updateMany: async ({ where, data }) => { if (!match(where,state.proxy)) return { count:0 }; applyData(state.proxy,data); return { count:1 }; },
    },
    creatorNetworkProfile: {
      findUnique: async ({ where }) => where.agencyId_creatorId?.creatorId === "creator-1" ? clone(state.profile) : null,
      updateMany: async ({ where, data }) => { if (!match(where,state.profile)) return { count:0 }; applyData(state.profile,data); return { count:1 }; },
    },
    refreshSession: {
      updateMany: async ({ where, data }) => { let count = 0; for (const row of state.refreshSessions) if (match(where, row)) { applyData(row, data); count += 1; } return { count }; },
    },
    creatorDeviceKeyWrap: {
      findFirst: async ({ where }) => clone(state.creatorWraps.find((row) => match(where,row)) || null),
      findMany: async ({ where }) => state.creatorWraps.filter((row) => match(where,row)).map(clone),
      upsert: async ({ where, create, update }) => {
        const key = where.agencyId_creatorId_keyVersion_deviceId;
        let row = state.creatorWraps.find((x) => x.agencyId===key.agencyId && x.creatorId===key.creatorId && x.keyVersion===key.keyVersion && x.deviceId===key.deviceId);
        if (!row) { row={ id:`cw-${key.deviceId}-v${key.keyVersion}`, ...clone(create), revokedAt:null }; state.creatorWraps.push(row); }
        else applyData(row, update);
        return clone(row);
      },
      updateMany: async ({ where, data }) => { let count=0; for (const row of state.creatorWraps) if (match(where,row)) { applyData(row,data); count++; } return { count }; },
    },
  };
  return { db, state, now };
}

const ownerMember = { userId: "owner-user", role: "OWNER", roleKey: "owner", assignedCreators: null };

test("current authenticated device can retire only its own crypto identity without a private-key proof and old refresh sessions are revoked", async () => {
  const { db, state } = makeDb();
  const result = await retireCurrentDeviceIdentity({
    db,
    agencyId: "agency-1",
    userId: "target-user",
    deviceId: "target-device",
  });

  assert.equal(result.retired, true);
  assert.equal(result.targetHadOwnerRoot, false);
  assert.deepEqual(result.affectedCreatorIds, ["creator-1"]);
  assert.equal(state.identities.get("target-device").status, "REVOKED");
  assert.ok(state.identities.get("target-device").revokedAt);
  assert.ok(state.creatorWraps.find((row) => row.deviceId === "target-device" && row.keyVersion === 1).revokedAt);
  assert.ok(state.refreshSessions.find((row) => row.id === "rs-target").revokedAt);
  assert.equal(state.refreshSessions.find((row) => row.id === "rs-other").revokedAt, null);
});

test("self-retire cannot retire another member's device id", async () => {
  const { db, state } = makeDb();
  await assert.rejects(
    retireCurrentDeviceIdentity({ db, agencyId: "agency-1", userId: "worker-user", deviceId: "target-device" }),
    (error) => error?.code === "CRYPTO_DEVICE_USER_MISMATCH",
  );
  assert.equal(state.identities.get("target-device").status, "ACTIVE");
});

test("crypto status uses immutable agency identity even when WorkerDevice telemetry moved to another agency", async () => {
  const { db, state } = makeDb();
  state.devices.set("owner-device", { id: "owner-device", agencyId: "agency-2", userId: "other-agency-user" });
  const status = await getCryptoStatus({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, deviceId: "owner-device" });
  assert.equal(status.identity.deviceId, "owner-device");
  assert.equal(status.identity.status, "ACTIVE");
  assert.equal(status.root.version, 1);
  assert.ok(status.ownerWrap);
});

test("self-retire uses immutable agency crypto identity even when WorkerDevice telemetry moved to another agency", async () => {
  const { db, state } = makeDb();
  state.devices.set("target-device", { id: "target-device", agencyId: "agency-2", userId: "target-user" });
  const result = await retireCurrentDeviceIdentity({ db, agencyId: "agency-1", userId: "target-user", deviceId: "target-device" });
  assert.equal(result.retired, true);
  assert.equal(state.identities.get("target-device").status, "REVOKED");
  assert.ok(state.refreshSessions.find((row) => row.id === "rs-target").revokedAt);
});

test("self-retire refuses orphan device ids because immutable user ownership can no longer be proven", async () => {
  const { db, state } = makeDb();
  state.identities.delete("target-device");
  await assert.rejects(
    retireCurrentDeviceIdentity({ db, agencyId: "agency-1", userId: "target-user", deviceId: "target-device" }),
    (error) => error?.code === "CRYPTO_DEVICE_IDENTITY_REQUIRED",
  );
  assert.equal(state.creatorWraps.find((row) => row.deviceId === "target-device").revokedAt, null);
  assert.equal(state.refreshSessions.find((row) => row.id === "rs-target").revokedAt, null);
});

test("deleted identity cannot reuse a logical device id that has historical AMK/CDK wraps", async () => {
  const { db, state } = makeDb();
  state.identities.delete("target-device");
  await assert.rejects(
    registerDeviceIdentity({
      db, agencyId: "agency-1", userId: "target-user", deviceId: "target-device", publicKey: x25519PublicKey(),
    }),
    (error) => error?.code === "CRYPTO_DEVICE_ID_REUSE_FORBIDDEN",
  );
  assert.equal(state.identities.has("target-device"), false);
});

test("another login on the same physical device cannot use an agency identity registered to a different member", async () => {
  const { db, state } = makeDb();
  const otherMember = state.members.find((row) => row.userId === "worker-user");
  await assert.rejects(
    assertDeviceCanUseCreatorKey({
      db,
      agencyId: "agency-1",
      creatorId: "creator-1",
      keyVersion: 1,
      deviceId: "target-device",
      member: otherMember,
    }),
    (error) => error?.code === "CRYPTO_DEVICE_USER_MISMATCH",
  );
});

test("removing creator access immediately denies CDK use and surfaces rotation debt until the creator key is rotated", async () => {
  const { db, state } = makeDb();
  const targetMember = state.members.find((row) => row.userId === "target-user");
  targetMember.assignedCreators = [];

  const before = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  const targetBefore = before.find((row) => row.deviceId === "target-device");
  assert.deepEqual(targetBefore.accessRevocationCreatorIds, ["creator-1"]);
  assert.equal(targetBefore.accessRotationRequired, true);

  const globalDebtBefore = await findUntrustedCreatorExposureDebt({ db, agencyId: "agency-1" });
  assert.deepEqual(globalDebtBefore.deviceIds, ["target-device"]);
  assert.deepEqual(globalDebtBefore.creatorIds, ["creator-1"]);
  assert.deepEqual(globalDebtBefore.exposures, [{ deviceId: "target-device", creatorId: "creator-1", keyVersion: 1 }]);

  await assert.rejects(
    assertDeviceCanUseCreatorKey({
      db,
      agencyId: "agency-1",
      creatorId: "creator-1",
      keyVersion: 1,
      deviceId: "target-device",
      member: targetMember,
    }),
    (error) => error?.code === "CRYPTO_CREATOR_ACCESS_REVOKED",
  );

  const result = await commitCreatorKeyRotation({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", creatorId: "creator-1", expectedKeyVersion: 1, expectedCurrentRootVersion: 1, expectedTargetRootVersion: 1,
    session: { expectedRevision: 7, opaquePayload: secretEnvelope(2) },
    proxy: { proxyId: "proxy-1", expectedProxyVersion: 4, expectedProfileVersion: 3, opaqueCredentials: secretEnvelope(2) },
    deviceWraps: [{ deviceId: "worker-device", envelope: wrapEnvelope() }],
  });
  assert.equal(result.activeKeyVersion, 2);
  assert.ok(state.creatorWraps.find((row) => row.deviceId === "target-device" && row.keyVersion === 1)?.revokedAt);
  assert.equal(state.creatorWraps.some((row) => row.deviceId === "target-device" && row.keyVersion === 2 && row.revokedAt === null), false);

  const after = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  const targetAfter = after.find((row) => row.deviceId === "target-device");
  assert.deepEqual(targetAfter.accessRevocationCreatorIds, []);
  assert.equal(targetAfter.accessRotationRequired, false);
});


test("soft-deleted creators do not leave false per-device creator-rotation debt", async () => {
  const { db, state } = makeDb();
  state.creatorDeleted = true;
  const targetMember = state.members.find((row) => row.userId === "target-user");
  targetMember.assignedCreators = [];

  const devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  const target = devices.find((row) => row.deviceId === "target-device");
  assert.deepEqual(target.accessRevocationCreatorIds, []);
  assert.equal(target.accessRotationRequired, false);

  const plan = await getDeviceRevocationPlan({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", targetDeviceId: "target-device",
  });
  assert.deepEqual(plan.affectedCreatorIds, []);
});

test("newly granted creator access on an already active device is surfaced and can be synced without device revoke or creator rotation", async () => {
  const { db, state } = makeDb();
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");

  let devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  let target = devices.find((row) => row.deviceId === "target-device");
  assert.equal(target.status, "ACTIVE");
  assert.deepEqual(target.accessGrantCreatorIds, ["creator-1"]);
  assert.equal(target.accessGrantSyncRequired, true);
  assert.deepEqual(target.accessRevocationCreatorIds, []);

  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  assert.equal(plan.targetIsOwner, false);
  assert.deepEqual(plan.creators.map((row) => row.creatorId), ["creator-1"]);

  const approved = await approveDevice({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: 1, ownerWrap: null,
    creatorWraps: [{ creatorId: "creator-1", keyVersion: 1, rootVersion: 1, envelope: wrapEnvelope() }],
  });
  assert.equal(approved.creatorWrapCount, 1);
  assert.equal(state.keyState.activeVersion, 1, "syncing newly granted access must not rotate the creator key");

  devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  target = devices.find((row) => row.deviceId === "target-device");
  assert.deepEqual(target.accessGrantCreatorIds, []);
  assert.equal(target.accessGrantSyncRequired, false);

  const secondPlan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  assert.deepEqual(secondPlan.creators, [], "already enrolled current generations must not be rewrapped on every sync");
});

test("owner can approve a durable crypto identity even when mutable WorkerDevice telemetry is temporarily absent", async () => {
  const { db, state } = makeDb();
  state.devices.delete("target-device");
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");

  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  assert.equal(plan.targetUserId, "target-user");
  assert.deepEqual(plan.creators.map((row) => row.creatorId), ["creator-1"]);

  const result = await approveDevice({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: 1, ownerWrap: null,
    creatorWraps: [{ creatorId: "creator-1", keyVersion: 1, rootVersion: 1, envelope: wrapEnvelope() }],
  });
  assert.equal(result.creatorWrapCount, 1);
});

test("owner can sync an agency crypto identity even while the physical WorkerDevice is currently active in another agency", async () => {
  const { db, state } = makeDb();
  state.devices.get("target-device").agencyId = "agency-2";
  state.devices.get("target-device").userId = "other-agency-user";
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");

  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  assert.equal(plan.targetUserId, "target-user", "approval must use immutable crypto identity ownership, not mutable WorkerDevice telemetry");
  assert.deepEqual(plan.creators.map((row) => row.creatorId), ["creator-1"]);

  const result = await approveDevice({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: 1, ownerWrap: null,
    creatorWraps: [{ creatorId: "creator-1", keyVersion: 1, rootVersion: 1, envelope: wrapEnvelope() }],
  });
  assert.equal(result.creatorWrapCount, 1);
});

test("strong creator rotation atomically advances key/session/proxy/network generations and retires old wraps", async () => {
  const { db, state } = makeDb();
  // Simulate the target device having already been soft-revoked before strong rotation.
  state.identities.get("target-device").status = "REVOKED";
  state.identities.get("target-device").revokedAt = new Date();
  state.creatorWraps.find((row) => row.deviceId === "target-device").revokedAt = new Date();

  const result = await commitCreatorKeyRotation({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", creatorId: "creator-1", expectedKeyVersion: 1, expectedCurrentRootVersion: 1, expectedTargetRootVersion: 1,
    session: { expectedRevision: 7, opaquePayload: secretEnvelope(2) },
    proxy: { proxyId: "proxy-1", expectedProxyVersion: 4, expectedProfileVersion: 3, opaqueCredentials: secretEnvelope(2) },
    deviceWraps: [{ deviceId: "worker-device", envelope: wrapEnvelope() }],
  });

  assert.equal(result.activeKeyVersion, 2);
  assert.equal(result.sessionRevision, 8);
  assert.equal(result.proxyVersion, 5);
  assert.equal(result.networkProfileVersion, 4);
  assert.equal(state.keyState.activeVersion, 2);
  assert.equal(state.session.keyVersion, 2);
  assert.equal(state.session.revision, 8);
  assert.equal(state.proxy.keyVersion, 2);
  assert.equal(state.proxy.version, 5);
  assert.equal(state.profile.version, 4);
  assert.ok(state.creatorWraps.some((row) => row.deviceId === "worker-device" && row.keyVersion === 2 && row.revokedAt === null));
  assert.ok(state.creatorWraps.filter((row) => row.keyVersion === 1).every((row) => row.revokedAt));
});

test("strong creator rotation re-encrypts an idle dedicated proxy while creator remains DIRECT", async () => {
  const { db, state } = makeDb();
  state.profile.mode = "DIRECT";
  state.profile.proxyEndpointId = null;
  state.profile.version = 9;
  state.identities.get("target-device").status = "REVOKED";
  state.identities.get("target-device").revokedAt = new Date();
  state.creatorWraps.find((row) => row.deviceId === "target-device").revokedAt = new Date();

  const result = await commitCreatorKeyRotation({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", creatorId: "creator-1", expectedKeyVersion: 1, expectedCurrentRootVersion: 1, expectedTargetRootVersion: 1,
    session: { expectedRevision: 7, opaquePayload: secretEnvelope(2) },
    proxy: { proxyId: "proxy-1", expectedProxyVersion: 4, expectedProfileVersion: 9, opaqueCredentials: secretEnvelope(2) },
    deviceWraps: [{ deviceId: "worker-device", envelope: wrapEnvelope() }],
  });

  assert.equal(result.activeKeyVersion, 2);
  assert.equal(result.proxyVersion, 5);
  assert.equal(result.networkProfileVersion, 9, "DIRECT network profile version must not change when only its idle dedicated proxy secret is re-encrypted");
  assert.equal(state.proxy.keyVersion, 2);
  assert.equal(state.proxy.version, 5);
  assert.equal(state.profile.mode, "DIRECT");
  assert.equal(state.profile.proxyEndpointId, null);
  assert.equal(state.profile.version, 9);
});

test("strong creator rotation rejects stale key generation instead of partially advancing secrets", async () => {
  const { db, state } = makeDb();
  await assert.rejects(
    commitCreatorKeyRotation({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", creatorId: "creator-1", expectedKeyVersion: 9, expectedCurrentRootVersion: 1, expectedTargetRootVersion: 1,
      session: null, proxy: null, deviceWraps: [],
    }),
    (error) => error?.code === "CRYPTO_CREATOR_KEY_VERSION_CONFLICT",
  );
  assert.equal(state.keyState.activeVersion, 1);
  assert.equal(state.session.revision, 7);
  assert.equal(state.proxy.version, 4);
  assert.equal(state.profile.version, 3);
});

test("strong creator rotation requires a wrap for every active non-owner device and excludes revoked target", async () => {
  const { db, state } = makeDb();
  state.identities.get("target-device").status = "REVOKED";
  state.identities.get("target-device").revokedAt = new Date();
  await assert.rejects(
    commitCreatorKeyRotation({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", creatorId: "creator-1", expectedKeyVersion: 1, expectedCurrentRootVersion: 1, expectedTargetRootVersion: 1,
      session: { expectedRevision: 7, opaquePayload: secretEnvelope(2) },
      proxy: { proxyId: "proxy-1", expectedProxyVersion: 4, expectedProfileVersion: 3, opaqueCredentials: secretEnvelope(2) },
      deviceWraps: [],
    }),
    (error) => error?.code === "CRYPTO_ROTATION_DEVICE_WRAP_SET_INCOMPLETE",
  );
});

test("soft revoke returns resumable affected creator plan for a chatter device", async () => {
  const { db, state } = makeDb();
  const result = await softRevokeDevice({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", targetDeviceId: "target-device" });
  assert.equal(result.targetHadOwnerRoot, false);
  assert.deepEqual(result.affectedCreatorIds, ["creator-1"]);
  assert.equal(result.rootRotationRequired, false);
  assert.equal(state.identities.get("target-device").status, "REVOKED");
  assert.ok(state.creatorWraps.find((row) => row.deviceId === "target-device").revokedAt);
});

test("revoked worker security debt remains visible until its active creator key generation is rotated", async () => {
  const { db, state } = makeDb();
  await softRevokeDevice({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", targetDeviceId: "target-device" });
  let devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  let target = devices.find((row) => row.deviceId === "target-device");
  assert.equal(target.status, "REVOKED");
  assert.deepEqual(target.pendingStrongRotationCreatorIds, ["creator-1"]);
  assert.equal(target.rootRotationRequired, false);

  await commitCreatorKeyRotation({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", creatorId: "creator-1", expectedKeyVersion: 1, expectedCurrentRootVersion: 1, expectedTargetRootVersion: 1,
    session: { expectedRevision: 7, opaquePayload: secretEnvelope(2) },
    proxy: { proxyId: "proxy-1", expectedProxyVersion: 4, expectedProfileVersion: 3, opaqueCredentials: secretEnvelope(2) },
    deviceWraps: [{ deviceId: "worker-device", envelope: wrapEnvelope() }],
  });
  devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  target = devices.find((row) => row.deviceId === "target-device");
  assert.deepEqual(target.pendingStrongRotationCreatorIds, []);
});

test("revoked owner device reports root rotation debt from durable root/key facts", async () => {
  const { db } = makeDb({ targetOwner: true });
  await softRevokeDevice({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", targetDeviceId: "target-device" });
  const devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  const target = devices.find((row) => row.deviceId === "target-device");
  assert.equal(target.status, "REVOKED");
  assert.equal(target.rootRotationRequired, true);
});

test("worker approval during partial root rotation is bound to the creator root generation, not merely the active AMK", async () => {
  const { db, state } = makeDb();
  state.root.version = 2;
  state.ownerWraps.push({ id: "ow-owner-v2", agencyId: "agency-1", rootVersion: 2, deviceId: "owner-device", revokedAt: null });
  state.keyState.rootVersion = 1;
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  const approved = await approveDevice({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: 2, ownerWrap: null,
    creatorWraps: [{ creatorId: "creator-1", keyVersion: 1, rootVersion: 1, envelope: wrapEnvelope() }],
  });
  assert.equal(approved.creatorWrapCount, 1);
  assert.ok(state.creatorWraps.some((row) => row.deviceId === "target-device" && row.keyVersion === 1 && row.revokedAt === null));
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: 2, ownerWrap: null,
      creatorWraps: [{ creatorId: "creator-1", keyVersion: 1, rootVersion: 2, envelope: wrapEnvelope() }],
    }),
    (error) => error?.code === "CRYPTO_CREATOR_KEY_VERSION_CONFLICT",
  );
});



test("worker approval cannot invent creator key/root generations before key state exists", async () => {
  const { db, state } = makeDb();
  state.keyState = null;
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: 1, ownerWrap: null,
      creatorWraps: [{ creatorId: "creator-1", keyVersion: 99, rootVersion: 99, envelope: wrapEnvelope() }],
    }),
    (error) => error?.code === "CRYPTO_CREATOR_KEY_VERSION_CONFLICT",
  );
  assert.equal(state.keyState, null);

  const approved = await approveDevice({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: 1, ownerWrap: null,
    creatorWraps: [{ creatorId: "creator-1", keyVersion: 1, rootVersion: 1, envelope: wrapEnvelope() }],
  });
  assert.equal(approved.creatorWrapCount, 1);
  assert.equal(state.keyState.activeVersion, 1);
  assert.equal(state.keyState.rootVersion, 1);
});

test("owner approval forbids redundant per-creator wraps", async () => {
  const { db } = makeDb({ targetOwner: true });
  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: 1, ownerWrap: wrapEnvelope(),
      creatorWraps: [{ creatorId: "creator-1", keyVersion: 1, rootVersion: 1, envelope: wrapEnvelope() }],
    }),
    (error) => error?.code === "CRYPTO_OWNER_CREATOR_WRAPS_FORBIDDEN",
  );
});


test("stale worker approval is rejected if target is promoted to OWNER before commit", async () => {
  const { db, state } = makeDb();
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  assert.equal(plan.targetIsOwner, false);
  assert.deepEqual(plan.creators.map((row) => row.creatorId), ["creator-1"]);

  const targetMember = state.members.find((row) => row.userId === "target-user");
  targetMember.role = "OWNER";
  targetMember.roleKey = "owner";
  targetMember.assignedCreators = null;
  const beforeWrapCount = state.creatorWraps.length;

  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: plan.rootVersion, ownerWrap: null,
      creatorWraps: plan.creators.map((creator) => ({ creatorId: creator.creatorId, keyVersion: creator.keyVersion, rootVersion: creator.rootVersion, envelope: wrapEnvelope() })),
    }),
    (error) => error?.code === "CRYPTO_OWNER_WRAP_REQUIRED",
  );
  assert.equal(state.creatorWraps.length, beforeWrapCount);
  assert.equal(state.ownerWraps.some((row) => row.deviceId === "target-device" && row.revokedAt === null), false);
});

test("stale approval is rejected if target creator access is removed before commit", async () => {
  const { db, state } = makeDb();
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  const targetMember = state.members.find((row) => row.userId === "target-user");
  targetMember.assignedCreators = [];
  const beforeWrapCount = state.creatorWraps.length;

  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: plan.rootVersion, ownerWrap: null,
      creatorWraps: plan.creators.map((creator) => ({ creatorId: creator.creatorId, keyVersion: creator.keyVersion, rootVersion: creator.rootVersion, envelope: wrapEnvelope() })),
    }),
    (error) => error?.code === "CRYPTO_APPROVAL_PLAN_STALE",
  );
  assert.equal(state.creatorWraps.length, beforeWrapCount);
});

test("stale approval is rejected if approving member loses OWNER authority before commit", async () => {
  const { db, state } = makeDb();
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  const liveApprover = state.members.find((row) => row.userId === "owner-user");
  liveApprover.role = "WORKER";
  liveApprover.roleKey = "chatter";
  liveApprover.assignedCreators = ["creator-1"];

  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: plan.rootVersion, ownerWrap: null,
      creatorWraps: plan.creators.map((creator) => ({ creatorId: creator.creatorId, keyVersion: creator.keyVersion, rootVersion: creator.rootVersion, envelope: wrapEnvelope() })),
    }),
    (error) => error?.code === "CRYPTO_OWNER_REQUIRED",
  );
  assert.equal(state.creatorWraps.some((row) => row.deviceId === "target-device"), false);
});

test("stale approval is rejected if agency root generation changes after plan", async () => {
  const { db, state } = makeDb();
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  state.root.version = 2;
  state.ownerWraps.push({ id: "ow-owner-v2", agencyId: "agency-1", rootVersion: 2, deviceId: "owner-device", revokedAt: null });

  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: plan.rootVersion, ownerWrap: null,
      creatorWraps: plan.creators.map((creator) => ({ creatorId: creator.creatorId, keyVersion: creator.keyVersion, rootVersion: creator.rootVersion, envelope: wrapEnvelope() })),
    }),
    (error) => error?.code === "CRYPTO_APPROVAL_ROOT_VERSION_CONFLICT" && error?.currentRootVersion === 2,
  );
  assert.equal(state.creatorWraps.some((row) => row.deviceId === "target-device"), false);
});

test("pending device cannot become ACTIVE from an incomplete creator-wrap set", async () => {
  const { db, state } = makeDb();
  const identity = state.identities.get("target-device");
  identity.status = "PENDING";
  identity.activatedAt = null;
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  assert.deepEqual(plan.creators.map((row) => row.creatorId), ["creator-1"]);

  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: plan.rootVersion, ownerWrap: null, creatorWraps: [],
    }),
    (error) => error?.code === "CRYPTO_APPROVAL_PLAN_STALE",
  );
  assert.equal(state.identities.get("target-device").status, "PENDING");
  assert.equal(state.creatorWraps.some((row) => row.deviceId === "target-device"), false);
});

test("parallel creator-key sync invalidates a stale approval plan instead of rewriting it", async () => {
  const { db, state } = makeDb();
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");
  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  state.creatorWraps.push({ id: "cw-parallel", agencyId: "agency-1", creatorId: "creator-1", keyVersion: 1, deviceId: "target-device", revokedAt: null });

  await assert.rejects(
    approveDevice({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, approverDeviceId: "owner-device", targetDeviceId: "target-device", expectedRootVersion: plan.rootVersion, ownerWrap: null,
      creatorWraps: plan.creators.map((creator) => ({ creatorId: creator.creatorId, keyVersion: creator.keyVersion, rootVersion: creator.rootVersion, envelope: wrapEnvelope() })),
    }),
    (error) => error?.code === "CRYPTO_APPROVAL_PLAN_STALE",
  );
  assert.equal(state.creatorWraps.filter((row) => row.deviceId === "target-device" && row.revokedAt === null).length, 1);
});

test("owner-device revoke is explicitly classified as root rotation required", async () => {
  const { db } = makeDb({ targetOwner: true });
  const plan = await getDeviceRevocationPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", targetDeviceId: "target-device" });
  assert.equal(plan.targetHadOwnerRoot, true);
  assert.equal(plan.rootRotationRequired, true);
});


test("wrong recovery proof cannot activate or rewrite an owner device", async () => {
  const { db, state } = makeDb();
  const correctProof = recoveryProof();
  state.root.recoveryProofHash = crypto.createHash("sha256").update(Buffer.from(correctProof, "base64")).digest("base64");
  const identity = state.identities.get("owner-device");
  identity.status = "PENDING";
  identity.activatedAt = null;
  const beforeWrap = structuredClone(state.ownerWraps.find((row) => row.deviceId === "owner-device" && row.rootVersion === 1));
  await assert.rejects(
    recoverOwnerDevice({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, deviceId: "owner-device", rootVersion: 1, ownerWrap: wrapEnvelope(), recoveryProof: crypto.randomBytes(32).toString("base64") }),
    (error) => error?.code === "CRYPTO_RECOVERY_PROOF_MISMATCH",
  );
  assert.equal(identity.status, "PENDING");
  assert.equal(identity.activatedAt, null);
  assert.deepEqual(state.ownerWraps.find((row) => row.deviceId === "owner-device" && row.rootVersion === 1), beforeWrap);

  const recovered = await recoverOwnerDevice({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, deviceId: "owner-device", rootVersion: 1, ownerWrap: wrapEnvelope(), recoveryProof: correctProof });
  assert.equal(recovered.recovered, true);
  assert.equal(identity.status, "ACTIVE");
});

test("legacy intermediate root without pinned proof is fail-closed for recovery and destructive owner commits", async () => {
  const { db, state } = makeDb();
  state.root.recoveryProofHash = null;
  await assert.rejects(
    recoverOwnerDevice({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, deviceId: "owner-device", rootVersion: 1, ownerWrap: wrapEnvelope(), recoveryProof: ACTOR_PROOF }),
    (error) => error?.code === "CRYPTO_RECOVERY_PROOF_UNAVAILABLE",
  );
  await assert.rejects(
    softRevokeDeviceRaw({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", targetDeviceId: "worker-device", actorProof: ACTOR_PROOF }),
    (error) => error?.code === "CRYPTO_ACTOR_PROOF_UNAVAILABLE",
  );
  assert.equal(state.identities.get("worker-device").status, "ACTIVE");
});

test("owner root rotation activates new AMK generation, migrates creator state, then retires old owner wraps", async () => {
  const { db, state } = makeDb();
  const begun = await beginRootRotation({
    db,
    agencyId: "agency-1",
    userId: "owner-user",
    member: ownerMember,
    actorDeviceId: "owner-device",
    expectedRootVersion: 1,
    recoveryEnvelope: recoveryEnvelope(),
    recoveryProof: recoveryProof(),
    rootBridge: rootBridgeEnvelope(),
    ownerWraps: [{ deviceId: "owner-device", envelope: wrapEnvelope() }],
  });
  assert.equal(begun.activeRootVersion, 2);
  assert.deepEqual(begun.pendingCreatorIds, ["creator-1"]);
  assert.equal(state.root.version, 2);
  assert.ok(state.ownerWraps.some((row) => row.deviceId === "owner-device" && row.rootVersion === 2 && row.revokedAt === null));
  assert.equal(state.keyState.rootVersion, 1);
  assert.equal(state.rootBridges.length, 1);
  assert.equal(state.rootBridges[0].fromVersion, 1);
  assert.equal(state.rootBridges[0].toVersion, 2);
  assert.equal(state.rootBridges[0].retiredAt, null);
  const bridgeBefore = await getRootRotationBridge({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", fromVersion: 1 });
  assert.equal(bridgeBefore.fromVersion, 1);
  assert.equal(bridgeBefore.toVersion, 2);
  assert.equal(bridgeBefore.algorithm, "aes-256-gcm-root-bridge-v1");

  const progressBefore = await getRootRotationProgress({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device" });
  assert.equal(progressBefore.inProgress, true);
  assert.equal(progressBefore.previousRootVersion, 1);
  assert.equal(progressBefore.complete, false);
  assert.deepEqual(progressBefore.pendingCreatorIds, ["creator-1"]);
  assert.equal(state.ownerWraps.find((row) => row.rootVersion === 1).revokedAt, null);

  const rotated = await commitCreatorKeyRotation({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", creatorId: "creator-1",
    expectedKeyVersion: 1, expectedCurrentRootVersion: 1, expectedTargetRootVersion: 2,
    session: { expectedRevision: 7, opaquePayload: secretEnvelope(2) },
    proxy: { proxyId: "proxy-1", expectedProxyVersion: 4, expectedProfileVersion: 3, opaqueCredentials: secretEnvelope(2) },
    deviceWraps: [
      { deviceId: "target-device", envelope: wrapEnvelope() },
      { deviceId: "worker-device", envelope: wrapEnvelope() },
    ],
  });
  assert.equal(rotated.previousRootVersion, 1);
  assert.equal(rotated.activeRootVersion, 2);
  assert.equal(state.keyState.rootVersion, 2);

  const progressAfter = await getRootRotationProgress({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device" });
  assert.equal(progressAfter.inProgress, true);
  assert.equal(progressAfter.complete, true);
  assert.deepEqual(progressAfter.pendingCreatorIds, []);

  const finalized = await finalizeRootRotation({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device" });
  assert.equal(finalized.finalized, true);
  assert.ok(finalized.retiredOwnerWrapCount >= 1);
  assert.ok(state.ownerWraps.find((row) => row.rootVersion === 1).revokedAt);
  assert.equal(state.ownerWraps.find((row) => row.rootVersion === 2).revokedAt, null);
  assert.equal(finalized.retiredRootBridgeCount, 1);
  assert.ok(state.rootBridges[0].retiredAt);
  await assert.rejects(
    getRootRotationBridge({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", fromVersion: 1 }),
    (error) => error?.code === "CRYPTO_ROOT_BRIDGE_NOT_AVAILABLE",
  );
});

test("root bridge is one-way and never exposes a newer root from an older generation", async () => {
  const { db } = makeDb();
  await beginRootRotation({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", expectedRootVersion: 1,
    recoveryEnvelope: recoveryEnvelope(), recoveryProof: recoveryProof(), rootBridge: rootBridgeEnvelope(), ownerWraps: [{ deviceId: "owner-device", envelope: wrapEnvelope() }],
  });
  await assert.rejects(
    getRootRotationBridge({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", fromVersion: 2 }),
    (error) => error?.code === "CRYPTO_ROOT_BRIDGE_DIRECTION_INVALID",
  );
});

test("a second root rotation is blocked until every creator has migrated to the active root", async () => {
  const { db } = makeDb();
  await beginRootRotation({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", expectedRootVersion: 1,
    recoveryEnvelope: recoveryEnvelope(), recoveryProof: recoveryProof(), rootBridge: rootBridgeEnvelope(), ownerWraps: [{ deviceId: "owner-device", envelope: wrapEnvelope() }],
  });
  await assert.rejects(
    beginRootRotation({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", expectedRootVersion: 2,
      recoveryEnvelope: recoveryEnvelope(), recoveryProof: recoveryProof(), rootBridge: rootBridgeEnvelope(), ownerWraps: [{ deviceId: "owner-device", envelope: wrapEnvelope() }],
    }),
    (error) => error?.code === "CRYPTO_ROOT_ROTATION_ALREADY_IN_PROGRESS",
  );
});


test("a completed root migration must be finalized before another root generation can start", async () => {
  const { db, state } = makeDb();
  await beginRootRotation({
    db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", expectedRootVersion: 1,
    recoveryEnvelope: recoveryEnvelope(), recoveryProof: recoveryProof(), rootBridge: rootBridgeEnvelope(), ownerWraps: [{ deviceId: "owner-device", envelope: wrapEnvelope() }],
  });
  state.keyState.rootVersion = 2;
  const progress = await getRootRotationProgress({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device" });
  assert.equal(progress.inProgress, true);
  assert.equal(progress.complete, true);
  await assert.rejects(
    beginRootRotation({
      db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device", expectedRootVersion: 2,
      recoveryEnvelope: recoveryEnvelope(), recoveryProof: recoveryProof(), rootBridge: rootBridgeEnvelope(), ownerWraps: [{ deviceId: "owner-device", envelope: wrapEnvelope() }],
    }),
    (error) => error?.code === "CRYPTO_ROOT_ROTATION_ALREADY_IN_PROGRESS",
  );
});

test("promoting an active worker device to OWNER surfaces root sync and retires redundant creator wraps after approval", async () => {
  const { db, state } = makeDb();
  const targetMember = state.members.find((row) => row.userId === "target-user");
  targetMember.role = "OWNER";
  targetMember.roleKey = "owner";
  targetMember.assignedCreators = null;

  let devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  let target = devices.find((row) => row.deviceId === "target-device");
  assert.equal(target.status, "ACTIVE");
  assert.equal(target.hasActiveOwnerRoot, false);
  assert.equal(target.ownerRootSyncRequired, true);
  assert.deepEqual(target.accessGrantCreatorIds, []);

  const plan = await getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, targetDeviceId: "target-device" });
  assert.equal(plan.targetIsOwner, true);
  assert.equal(plan.rootVersion, 1);
  assert.deepEqual(plan.creators, []);

  const approved = await approveDevice({
    db,
    agencyId: "agency-1",
    userId: "owner-user",
    member: ownerMember,
    approverDeviceId: "owner-device",
    targetDeviceId: "target-device",
    expectedRootVersion: 1,
    ownerWrap: wrapEnvelope(),
    creatorWraps: [],
  });
  assert.equal(approved.targetIsOwner, true);
  assert.ok(state.ownerWraps.some((row) => row.deviceId === "target-device" && row.rootVersion === 1 && row.revokedAt === null));
  assert.ok(state.creatorWraps.filter((row) => row.deviceId === "target-device").every((row) => row.revokedAt));

  devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  target = devices.find((row) => row.deviceId === "target-device");
  assert.equal(target.hasActiveOwnerRoot, true);
  assert.equal(target.ownerRootSyncRequired, false);
  assert.equal(target.creatorWrapCount, 0);
});

test("owner demotion revokes AMK distribution but keeps the device active and surfaces root-rotation debt", async () => {
  const { db, state } = makeDb({ targetOwner: true });
  const targetMember = state.members.find((row) => row.userId === "other-owner");
  assert.ok(state.ownerWraps.some((row) => row.deviceId === "target-device" && row.revokedAt === null));

  targetMember.role = "WORKER";
  targetMember.roleKey = "chatter";
  targetMember.assignedCreators = ["creator-1"];
  const revoked = await revokeOwnerRootAccessForMember({
    db,
    agencyId: "agency-1",
    userId: "other-owner",
    revokedAt: new Date("2026-08-23T20:00:00.000Z"),
  });
  assert.equal(revoked.revokedOwnerWrapCount, 1);
  assert.equal(state.identities.get("target-device").status, "ACTIVE");
  assert.ok(state.ownerWraps.find((row) => row.deviceId === "target-device" && row.rootVersion === 1).revokedAt);

  const devices = await listCryptoDevices({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember });
  const target = devices.find((row) => row.deviceId === "target-device");
  assert.equal(target.status, "ACTIVE");
  assert.equal(target.memberRole.toLowerCase(), "chatter");
  assert.equal(target.hasActiveOwnerRoot, false);
  assert.equal(target.rootRotationRequired, true);
});


test("deleted crypto identity cannot erase current creator-key exposure debt", async () => {
  const { db, state } = makeDb();
  state.identities.delete("worker-device");
  const debt = await findUntrustedCreatorExposureDebt({ db, agencyId: "agency-1" });
  assert.deepEqual(debt.deviceIds, ["worker-device"]);
  assert.deepEqual(debt.creatorIds, ["creator-1"]);
  assert.deepEqual(debt.exposures, [{ deviceId: "worker-device", creatorId: "creator-1", keyVersion: 1 }]);

  // Strong rotation advances the active generation. Historical v1 knowledge is
  // no longer relevant to future CLIENT_E2E_V1 envelopes once creator-1 is v2.
  state.keyState.activeVersion = 2;
  const cleared = await findUntrustedCreatorExposureDebt({ db, agencyId: "agency-1" });
  assert.deepEqual(cleared.deviceIds, []);
  assert.deepEqual(cleared.creatorIds, []);
  assert.deepEqual(cleared.exposures, []);
});

test("stolen owner bearer context without the AMK proof cannot revoke another crypto device", async () => {
  const { db, state } = makeDb();
  const beforeWraps = state.creatorWraps.map((row) => ({ ...row }));
  await assert.rejects(
    softRevokeDeviceRaw({
      db,
      agencyId: "agency-1",
      userId: "owner-user",
      member: ownerMember,
      actorDeviceId: "owner-device",
      targetDeviceId: "worker-device",
      actorProof: crypto.randomBytes(32).toString("base64"),
    }),
    (error) => error?.code === "CRYPTO_ACTOR_PROOF_MISMATCH",
  );
  assert.equal(state.identities.get("worker-device").status, "ACTIVE");
  assert.deepEqual(state.creatorWraps, beforeWraps);
});

test("stolen owner bearer context without the AMK proof cannot approve or resync a device", async () => {
  const { db, state } = makeDb();
  const beforeOwnerWraps = state.ownerWraps.map((row) => ({ ...row }));
  const beforeCreatorWraps = state.creatorWraps.map((row) => ({ ...row }));
  await assert.rejects(
    approveDeviceRaw({
      db,
      agencyId: "agency-1",
      userId: "owner-user",
      member: ownerMember,
      approverDeviceId: "owner-device",
      targetDeviceId: "target-device",
      expectedRootVersion: 1,
      actorProof: crypto.randomBytes(32).toString("base64"),
      ownerWrap: null,
      creatorWraps: [],
    }),
    (error) => error?.code === "CRYPTO_ACTOR_PROOF_MISMATCH",
  );
  assert.deepEqual(state.ownerWraps, beforeOwnerWraps);
  assert.deepEqual(state.creatorWraps, beforeCreatorWraps);
});


test("soft-deleting the last old-root creator cannot deadlock root-rotation progress or finalization", async () => {
  const { db, state } = makeDb();
  state.root.version = 2;
  state.ownerWraps.push({ id: "ow-owner-v2", agencyId: "agency-1", rootVersion: 2, deviceId: "owner-device", revokedAt: null });
  state.rootBridges.push({ id: "bridge-1-2", agencyId: "agency-1", fromVersion: 1, toVersion: 2, retiredAt: null });
  state.creatorDeleted = true;

  const progress = await getRootRotationProgress({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device" });
  assert.deepEqual(progress.pendingCreatorIds, []);
  assert.equal(progress.complete, true);

  const finalized = await finalizeRootRotation({ db, agencyId: "agency-1", userId: "owner-user", member: ownerMember, actorDeviceId: "owner-device" });
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.activeRootVersion, 2);
  assert.ok(state.rootBridges[0].retiredAt);
});

test("new owner during partial root rotation can use an old creator root through the active one-way bridge", async () => {
  const { db, state } = makeDb();
  state.root.version = 2;
  state.keyState.rootVersion = 1;
  state.ownerWraps = [
    { id: "ow-owner-v2", agencyId: "agency-1", rootVersion: 2, deviceId: "owner-device", revokedAt: null },
  ];
  state.rootBridges = [
    { id: "bridge-1-2", agencyId: "agency-1", fromVersion: 1, toVersion: 2, retiredAt: null },
  ];

  const keyState = await getCreatorKeyState({
    db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "owner-device",
    member: state.members[0], userId: "owner-user",
  });
  assert.equal(keyState.enrolled, true);
  assert.equal(keyState.rootVersion, 1);

  const access = await assertDeviceCanUseCreatorKey({
    db, agencyId: "agency-1", creatorId: "creator-1", keyVersion: 1,
    deviceId: "owner-device", member: state.members[0],
  });
  assert.equal(access.owner, true);
  assert.equal(access.ownerRootAccessMode, "CURRENT_WITH_BRIDGE");
});

test("current owner wrap without the required old-root bridge does not authorize an old creator root", async () => {
  const { db, state } = makeDb();
  state.root.version = 2;
  state.keyState.rootVersion = 1;
  state.ownerWraps = [
    { id: "ow-owner-v2", agencyId: "agency-1", rootVersion: 2, deviceId: "owner-device", revokedAt: null },
  ];
  state.rootBridges = [];

  const keyState = await getCreatorKeyState({
    db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "owner-device",
    member: state.members[0], userId: "owner-user",
  });
  assert.equal(keyState.enrolled, false);
  await assert.rejects(
    () => assertDeviceCanUseCreatorKey({
      db, agencyId: "agency-1", creatorId: "creator-1", keyVersion: 1,
      deviceId: "owner-device", member: state.members[0],
    }),
    (error) => error?.code === "CRYPTO_OWNER_KEY_NOT_ENROLLED" && error?.status === 403,
  );
});

test("explicit creator-key bootstrap is OWNER+AMK protected, idempotent, and binds a new creator to the active root generation", async () => {
  const { db, state } = makeDb();
  state.root.version = 2;
  state.keyState = null;
  state.ownerWraps = [
    { id: "ow-owner-v2", agencyId: "agency-1", rootVersion: 2, deviceId: "owner-device", revokedAt: null },
  ];
  state.rootBridges = [
    { id: "bridge-1-2", agencyId: "agency-1", fromVersion: 1, toVersion: 2, retiredAt: null },
  ];

  await assert.rejects(
    () => initializeCreatorKeyState({
      db, agencyId: "agency-1", creatorId: "creator-1", userId: "owner-user",
      member: state.members[0], deviceId: "owner-device", actorProof: Buffer.alloc(32, 0x11).toString("base64"),
    }),
    (error) => error?.code === "CRYPTO_ACTOR_PROOF_MISMATCH" && error?.status === 403,
  );
  assert.equal(state.keyState, null);

  const first = await initializeCreatorKeyState({
    db, agencyId: "agency-1", creatorId: "creator-1", userId: "owner-user",
    member: state.members[0], deviceId: "owner-device", actorProof: ACTOR_PROOF,
  });
  assert.equal(first.created, true);
  assert.equal(first.state.initialized, true);
  assert.equal(first.state.enrolled, true);
  assert.equal(first.state.activeVersion, 1);
  assert.equal(first.state.rootVersion, 2);
  assert.equal(state.keyState.rootVersion, 2);

  const second = await initializeCreatorKeyState({
    db, agencyId: "agency-1", creatorId: "creator-1", userId: "owner-user",
    member: state.members[0], deviceId: "owner-device", actorProof: ACTOR_PROOF,
  });
  assert.equal(second.created, false);
  assert.equal(second.state.rootVersion, 2);
});


test("deleted creator historical CDK state is never authorizable, including for an OWNER with the AMK", async () => {
  const { db, state } = makeDb();
  state.creatorDeleted = true;

  await assert.rejects(
    getCreatorKeyState({
      db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "owner-device",
      member: state.members[0], userId: "owner-user",
    }),
    (error) => error?.code === "CRYPTO_CREATOR_REMOVED" && error?.status === 409,
  );
  await assert.rejects(
    assertDeviceCanUseCreatorKey({
      db, agencyId: "agency-1", creatorId: "creator-1", keyVersion: 1,
      deviceId: "owner-device", member: state.members[0],
    }),
    (error) => error?.code === "CRYPTO_CREATOR_REMOVED" && error?.status === 409,
  );
});

test("self-retire computes rotation debt inside the same Serializable commit as wrap revocation", async () => {
  const { db, state } = makeDb({ targetOwner: true });
  state.ownerWraps = state.ownerWraps.filter((row) => row.deviceId !== "target-device");
  state.creatorWraps = state.creatorWraps.filter((row) => row.deviceId !== "target-device");

  const originalTransaction = db.$transaction;
  let injected = false;
  db.$transaction = async (fn, options) => {
    if (!injected) {
      injected = true;
      state.ownerWraps.push({ id: "ow-raced", agencyId: "agency-1", rootVersion: 1, deviceId: "target-device", revokedAt: null });
      state.creatorWraps.push({ id: "cw-raced", agencyId: "agency-1", creatorId: "creator-1", keyVersion: 1, deviceId: "target-device", revokedAt: null });
    }
    return originalTransaction(fn, options);
  };

  const result = await retireCurrentDeviceIdentity({ db, agencyId: "agency-1", userId: "other-owner", deviceId: "target-device" });
  assert.equal(result.targetHadOwnerRoot, true, "a current AMK wrap granted immediately before commit must still surface root rotation debt");
  assert.deepEqual(result.affectedCreatorIds, ["creator-1"], "a current CDK wrap granted immediately before commit must surface creator rotation debt");
  assert.equal(result.rootRotationRequired, true);
  assert.equal(result.creatorRotationRequired, true);
  assert.ok(state.ownerWraps.find((row) => row.id === "ow-raced").revokedAt);
  assert.ok(state.creatorWraps.find((row) => row.id === "cw-raced").revokedAt);
});
