"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  creatorManifestEntry,
  buildDesktopBootstrap,
} = require("./desktop-bootstrap-service");
const { bumpMemberAccessEpoch, bumpAgencyAccessEpoch } = require("./access-epoch-service");

function creator(id, overrides = {}) {
  return {
    id,
    agencyId: "agency-1",
    displayName: `Creator ${id}`,
    remoteId: `of-${id}`,
    createdAt: new Date("2026-08-27T10:00:00Z"),
    sessionState: { status: "ACTIVE", revision: 7, platformUserId: `of-${id}`, payloadVersion: 1, portableReady: true, capturedByDeviceId: "device-a", updatedAt: new Date() },
    networkProfile: { mode: "DIRECT", proxyEndpointId: null, version: 3, updatedAt: new Date() },
    cryptoKeyState: { activeVersion: 4, rootVersion: 2, updatedAt: new Date() },
    ...overrides,
  };
}

function fixture(rows) {
  const calls = [];
  return {
    calls,
    db: {
      creatorAccount: {
        findMany: async (input) => {
          calls.push(input);
          const ids = input.where?.id?.in;
          return Array.isArray(ids) ? rows.filter((row) => ids.includes(row.id)) : rows;
        },
      },
    },
  };
}

test("desktop bootstrap is user-scoped, batch, metadata-only and carries accessEpoch", async () => {
  const fx = fixture([creator("a"), creator("b")]);
  const result = await buildDesktopBootstrap({
    db: fx.db,
    agencyId: "agency-1",
    userId: "user-1",
    deviceId: "device-a",
    member: { id: "member-1", role: "OWNER", roleKey: "owner", assignedCreators: null, accessEpoch: 12 },
  });

  assert.equal(fx.calls.length, 1, "bootstrap creator retrieval must be one batch query, never a per-creator loop");
  assert.equal(result.accessEpoch, 12);
  assert.deepEqual(result.scope, { agencyId: "agency-1", userId: "user-1", memberId: "member-1", deviceId: "device-a" });
  assert.equal(result.creators.length, 2);
  assert.equal(result.manifest.creators.length, 2);
  assert.deepEqual(result.manifest.creators[0], {
    creatorId: "a",
    expectedOnlyFansUserId: "of-a",
    sessionRevision: 7,
    sessionStatus: "ACTIVE",
    keyVersion: 4,
    networkMode: "DIRECT",
    networkVersion: 3,
    accessAllowed: true,
  });
  const serialized = JSON.stringify(result.manifest);
  assert.doesNotMatch(serialized, /ciphertext|password|encryptedPayload|opaquePayload|proxyUrl|cookie|sess\b|auth_id|bcTokenSha/i);
});

test("desktop bootstrap filters narrow member scope on the server, not on Desktop", async () => {
  const fx = fixture([creator("a"), creator("b")]);
  const result = await buildDesktopBootstrap({
    db: fx.db,
    agencyId: "agency-1",
    userId: "user-2",
    deviceId: "device-b",
    member: { id: "member-2", role: "OPERATOR", roleKey: "chatter", assignedCreators: { creatorIds: ["b", "missing"] }, accessEpoch: 9 },
  });
  assert.deepEqual(fx.calls[0].where.id.in, ["b", "missing"]);
  assert.deepEqual(result.creators.map((row) => row.id), ["b"]);
  assert.deepEqual(result.manifest.creators.map((row) => row.creatorId), ["b"]);
});

test("manifest normalizes absent session/key/network without inventing secrets", () => {
  assert.deepEqual(creatorManifestEntry(creator("x", { sessionState: null, cryptoKeyState: null, networkProfile: null, remoteId: null })), {
    creatorId: "x",
    expectedOnlyFansUserId: null,
    sessionRevision: 0,
    sessionStatus: "ABSENT",
    keyVersion: 0,
    networkMode: "DIRECT",
    networkVersion: 0,
    accessAllowed: true,
  });
});

test("accessEpoch bumps atomically at member and agency scope", async () => {
  const calls = [];
  const db = {
    agencyMember: {
      update: async (input) => { calls.push(["one", input]); return { id: input.where.id, accessEpoch: 8 }; },
      updateMany: async (input) => { calls.push(["many", input]); return { count: 3 }; },
    },
  };
  assert.equal(await bumpMemberAccessEpoch({ db, memberId: "member-1" }), 8);
  await bumpAgencyAccessEpoch({ db, agencyId: "agency-1" });
  assert.deepEqual(calls[0][1].data, { accessEpoch: { increment: 1 } });
  assert.deepEqual(calls[1][1].where, { agencyId: "agency-1", deletedAt: null, deactivatedAt: null });
  assert.deepEqual(calls[1][1].data, { accessEpoch: { increment: 1 } });
});
