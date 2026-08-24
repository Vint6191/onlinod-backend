"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// The supplied snapshot intentionally has no installed @prisma/client. These
// tests inject db explicitly, so stub only the module-level default client.
const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };

const {
  updateMemberSettings,
  setMemberStatus,
  removeMember,
} = require("./team-administration-service");

const ACTOR_PROOF = Buffer.alloc(32, 0x4a).toString("base64");
const WRONG_PROOF = Buffer.alloc(32, 0x4b).toString("base64");
const proofHash = crypto.createHash("sha256").update(Buffer.from(ACTOR_PROOF, "base64")).digest("base64");

function clone(value) { return value == null ? value : structuredClone(value); }

function makeMember(id, userId, roleKey = "owner") {
  return {
    id,
    agencyId: "agency-1",
    userId,
    roleKey,
    role: roleKey === "owner" ? "OWNER" : "OPERATOR",
    assignedCreators: roleKey === "owner" ? "all" : [],
    displayName: id,
    initials: id.slice(0, 2).toUpperCase(),
    tone: "amber",
    permissions: null,
    commission: null,
    deletedAt: null,
    deactivatedAt: null,
    createdAt: new Date("2026-08-24T08:00:00.000Z"),
    updatedAt: new Date("2026-08-24T08:00:00.000Z"),
    user: { id: userId, email: `${userId}@example.test`, name: id, avatarUrl: null, lastLoginAt: null },
    teamFunctions: [],
  };
}

function makeDb({ withRoot = true } = {}) {
  const members = new Map([
    ["owner-a", makeMember("owner-a", "user-a")],
    ["owner-b", makeMember("owner-b", "user-b")],
    ["owner-c", makeMember("owner-c", "user-c")],
  ]);
  const identities = [
    { agencyId: "agency-1", deviceId: "device-a", userId: "user-a", status: "ACTIVE", revokedAt: null },
    { agencyId: "agency-1", deviceId: "device-b", userId: "user-b", status: "ACTIVE", revokedAt: null },
  ];
  const ownerWraps = [
    { id: "wrap-a", agencyId: "agency-1", rootVersion: 1, deviceId: "device-a", revokedAt: null },
    { id: "wrap-b", agencyId: "agency-1", rootVersion: 1, deviceId: "device-b", revokedAt: null },
  ];
  const root = withRoot ? { agencyId: "agency-1", version: 1, status: "ACTIVE", recoveryProofHash: proofHash } : null;
  const writes = [];

  function activeOwnerCount(excludeId) {
    return [...members.values()].filter((member) =>
      member.id !== excludeId && !member.deletedAt && !member.deactivatedAt
      && (member.roleKey === "owner" || member.role === "OWNER")
    ).length;
  }

  const db = {
    $transaction: async (fn) => fn(db),
    agencyMember: {
      findFirst: async ({ where }) => {
        const row = members.get(where.id) || null;
        if (!row || row.agencyId !== where.agencyId) return null;
        if (where.deletedAt === null && row.deletedAt) return null;
        return clone(row);
      },
      findUnique: async ({ where }) => {
        if (where.agencyId_userId) {
          const key = where.agencyId_userId;
          return clone([...members.values()].find((row) => row.agencyId === key.agencyId && row.userId === key.userId) || null);
        }
        if (where.id) return clone(members.get(where.id) || null);
        return null;
      },
      count: async ({ where }) => activeOwnerCount(where.id?.not),
      update: async ({ where, data }) => {
        const row = members.get(where.id);
        if (!row) throw new Error("member not found");
        writes.push({ type: "member.update", memberId: row.id, data: clone(data) });
        Object.assign(row, clone(data), { updatedAt: new Date("2026-08-24T09:00:00.000Z") });
        return clone(row);
      },
    },
    agencyCryptoRoot: {
      findUnique: async ({ where }) => where.agencyId === "agency-1" ? clone(root) : null,
    },
    deviceCryptoIdentity: {
      findUnique: async ({ where }) => {
        const key = where.agencyId_deviceId;
        return clone(identities.find((row) => row.agencyId === key.agencyId && row.deviceId === key.deviceId) || null);
      },
      findMany: async ({ where }) => identities.filter((row) => row.agencyId === where.agencyId && row.userId === where.userId).map(clone),
    },
    agencyCryptoOwnerKeyWrap: {
      findFirst: async ({ where }) => clone(ownerWraps.find((row) =>
        row.agencyId === where.agencyId && row.rootVersion === where.rootVersion
        && row.deviceId === where.deviceId && row.revokedAt === null
      ) || null),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of ownerWraps) {
          if (row.agencyId !== where.agencyId || !where.deviceId.in.includes(row.deviceId) || row.revokedAt !== null) continue;
          writes.push({ type: "ownerWrap.revoke", deviceId: row.deviceId });
          row.revokedAt = data.revokedAt;
          count += 1;
        }
        return { count };
      },
    },
    refreshSession: {
      updateMany: async ({ where, data }) => {
        writes.push({ type: "refreshSession.revoke", userId: where.userId, data: clone(data) });
        return { count: 1 };
      },
    },
    teamMemberFunction: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    auditLog: { create: async ({ data }) => ({ id: "audit", ...clone(data) }) },
  };

  return {
    db,
    members,
    ownerWraps,
    writes,
    actor: clone(members.get("owner-a")),
    snapshotTarget() {
      const target = members.get("owner-b");
      const wrap = ownerWraps.find((row) => row.deviceId === "device-b");
      return {
        roleKey: target.roleKey,
        role: target.role,
        deactivatedAt: target.deactivatedAt,
        deletedAt: target.deletedAt,
        wrapRevokedAt: wrap.revokedAt,
      };
    },
  };
}

const actorArgs = (actor, actorProof) => ({
  actorMember: actor,
  actorUserId: "user-a",
  actorDeviceId: "device-a",
  actorProof,
});

async function expectProofFailure(run, ctx, expectedCode) {
  const before = ctx.snapshotTarget();
  await assert.rejects(run, (error) => error?.code === expectedCode && error?.status === 403);
  assert.deepEqual(ctx.snapshotTarget(), before, "failed proof must not mutate member or AMK wrap");
  assert.equal(ctx.writes.length, 0, "failed proof must occur before any transactional side effect");
}

test("stolen OWNER bearer cannot deactivate another OWNER without AMK proof and correct proof commits member+wrap atomically", async () => {
  for (const [proof, code] of [[null, "CRYPTO_ACTOR_PROOF_REQUIRED"], [WRONG_PROOF, "CRYPTO_ACTOR_PROOF_MISMATCH"]]) {
    const ctx = makeDb();
    await expectProofFailure(
      () => setMemberStatus({ db: ctx.db, agencyId: "agency-1", memberId: "owner-b", status: "deactivated", ...actorArgs(ctx.actor, proof) }),
      ctx,
      code,
    );
  }

  const ctx = makeDb();
  const result = await setMemberStatus({
    db: ctx.db, agencyId: "agency-1", memberId: "owner-b", status: "deactivated", ...actorArgs(ctx.actor, ACTOR_PROOF),
  });
  assert.equal(result.status, "deactivated");
  const after = ctx.snapshotTarget();
  assert.ok(after.deactivatedAt instanceof Date || after.deactivatedAt, "target must be deactivated");
  assert.ok(after.wrapRevokedAt instanceof Date || after.wrapRevokedAt, "target AMK wrap must be revoked");
  assert.deepEqual(ctx.writes.slice(0, 2).map((row) => row.type), ["member.update", "ownerWrap.revoke"]);
});

test("OWNER demotion is AMK-possession gated before role mutation and wrap revocation", async () => {
  const denied = makeDb();
  await expectProofFailure(
    () => updateMemberSettings({
      db: denied.db, agencyId: "agency-1", memberId: "owner-b", patch: { roleKey: "chatter" }, ...actorArgs(denied.actor, WRONG_PROOF),
    }),
    denied,
    "CRYPTO_ACTOR_PROOF_MISMATCH",
  );

  const ctx = makeDb();
  const member = await updateMemberSettings({
    db: ctx.db, agencyId: "agency-1", memberId: "owner-b", patch: { roleKey: "chatter" }, ...actorArgs(ctx.actor, ACTOR_PROOF),
  });
  assert.equal(member.roleKey, "chatter");
  assert.equal(ctx.snapshotTarget().roleKey, "chatter");
  assert.ok(ctx.snapshotTarget().wrapRevokedAt);
});

test("OWNER removal is AMK-possession gated before delete/deactivate and wrap revocation", async () => {
  const denied = makeDb();
  await expectProofFailure(
    () => removeMember({ db: denied.db, agencyId: "agency-1", memberId: "owner-b", ...actorArgs(denied.actor, null) }),
    denied,
    "CRYPTO_ACTOR_PROOF_REQUIRED",
  );

  const ctx = makeDb();
  const result = await removeMember({ db: ctx.db, agencyId: "agency-1", memberId: "owner-b", ...actorArgs(ctx.actor, ACTOR_PROOF) });
  assert.equal(result.id, "owner-b");
  const after = ctx.snapshotTarget();
  assert.ok(after.deletedAt);
  assert.ok(after.deactivatedAt);
  assert.ok(after.wrapRevokedAt);
});

test("pre-E2E agencies keep legacy Team Administration behavior when no crypto root exists", async () => {
  const ctx = makeDb({ withRoot: false });
  const result = await setMemberStatus({
    db: ctx.db, agencyId: "agency-1", memberId: "owner-b", status: "deactivated", ...actorArgs(ctx.actor, null),
  });
  assert.equal(result.status, "deactivated");
  assert.ok(ctx.snapshotTarget().deactivatedAt);
});

test("all destructive Team compatibility paths accept actorProof and derive device only from signed auth claim", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/team.js"), "utf8");
  assert.match(route, /actorProofSchema/);
  assert.match(route, /actorDeviceId:\s*req\.auth\?\.deviceId \|\| null/);
  assert.match(route, /router\.patch\("\/members\/:memberId\/settings"[\s\S]*actorProof/);
  assert.match(route, /router\.patch\("\/members\/:memberId\/status"[\s\S]*actorProof/);
  assert.match(route, /Compatibility endpoint retained for older desktops[\s\S]*actorProof/);
  assert.match(route, /router\.patch\("\/members\/:memberId\/role"[\s\S]*actorProof/);
  assert.match(route, /router\.delete\("\/members\/:memberId"[\s\S]*actorProof/);
  assert.doesNotMatch(route, /actorDeviceId:\s*(?:req\.body|input\.)/);
});
