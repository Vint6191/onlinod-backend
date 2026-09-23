"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanupAgencyFixture: cleanupAgencyFixtureAuthority } = require("../../scripts/test-support/phase2-postgres-integration-authority");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const release = require("./phase2-release-compatibility-authority-service");
const authAuthority = require("./authorization-session-authority-service");

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function withTeamGeneration(db, workFn) {
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT set_config($1,$2,true) AS value`,
      release.TEAM_CONTROL_PLANE_DB_SETTING,
      release.TEAM_CONTROL_PLANE_GENERATION,
    );
    return workFn(tx);
  });
}

async function cleanupAgency(db, agencyId) {
  try {
    await cleanupAgencyFixtureAuthority(db, { agencyId });
  } catch (_) {}
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("Actual59 PostgreSQL: telemetry SHARE fence serializes accessEpoch bump and trigger records server generation end", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const reader = new PrismaClient();
  const writer = new PrismaClient();
  const agencyId = token("a59_agency");
  const userId = token("a59_user");
  const memberId = token("a59_member");
  const locked = deferred();
  const releaseRead = deferred();
  let releaseDbTime = null;

  try {
    await withTeamGeneration(reader, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    await reader.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "integration" } });
    await withTeamGeneration(reader, (tx) => tx.agencyMember.create({
      data: { id: memberId, agencyId, userId, role: "CHATTER", roleKey: "chatter", assignedCreators: [] },
    }));
    const initial = await reader.agencyMember.findUnique({ where: { id: memberId }, select: { accessEpoch: true } });
    const oldEpoch = Number(initial.accessEpoch);

    const telemetryTx = reader.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT m."id",m."accessEpoch"
           FROM "AgencyMember" m
          WHERE m."id"=$1 AND m."agencyId"=$2 AND m."userId"=$3
          FOR SHARE OF m`,
        memberId, agencyId, userId,
      );
      assert.equal(Number(rows[0]?.accessEpoch), oldEpoch);
      locked.resolve();
      await releaseRead.promise;
      const clock = await tx.$queryRawUnsafe(`SELECT clock_timestamp() AS "now"`);
      releaseDbTime = new Date(clock[0].now);
      // This represents the canonical Team event commit while the same member
      // generation is still SHARE-locked by telemetry-ingest-service.
      await tx.$queryRawUnsafe(`SELECT 1`);
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });

    await locked.promise;
    let bumpCommitted = false;
    const bump = withTeamGeneration(writer, async (tx) => {
      const row = await tx.agencyMember.update({
        where: { id: memberId },
        data: { accessEpoch: { increment: 1 } },
        select: { accessEpoch: true },
      });
      bumpCommitted = true;
      return row;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(bumpCommitted, false, "accessEpoch UPDATE must wait while telemetry owns FOR SHARE generation fence");

    releaseRead.resolve();
    await telemetryTx;
    const bumped = await bump;
    assert.equal(Number(bumped.accessEpoch), oldEpoch + 1);

    const boundaries = await reader.$queryRawUnsafe(
      `SELECT "accessEpoch","nextAccessEpoch","endedAt"
         FROM "AgencyMemberAccessEpochBoundary"
        WHERE "memberId"=$1 AND "accessEpoch"=$2`,
      memberId, oldEpoch,
    );
    assert.equal(boundaries.length, 1);
    assert.equal(Number(boundaries[0].accessEpoch), oldEpoch);
    assert.equal(Number(boundaries[0].nextAccessEpoch), oldEpoch + 1);
    assert.ok(boundaries[0].endedAt instanceof Date || Number.isFinite(new Date(boundaries[0].endedAt).getTime()));
    assert.ok(releaseDbTime && new Date(boundaries[0].endedAt).getTime() >= releaseDbTime.getTime(),
      "member generation boundary must be timestamped after the blocking telemetry transaction reaches its DB-clock release point");
  } finally {
    releaseRead.resolve();
    await cleanupAgency(reader, agencyId);
    await reader.$disconnect();
    await writer.$disconnect();
  }
});

test("Actual59 INT59.3 PostgreSQL: telemetry SHARE fence serializes login-lineage revoke and records server session end", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const reader = new PrismaClient();
  const writer = new PrismaClient();
  const agencyId = token("a59_lineage_agency");
  const userId = token("a59_lineage_user");
  const sessionId = token("a59_session");
  const lineage = token("a59_lineage");
  const deviceId = token("a59_device");
  const locked = deferred();
  const releaseRead = deferred();
  let releaseDbTime = null;

  try {
    await withTeamGeneration(reader, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    await reader.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "integration" } });
    await reader.refreshSession.create({
      data: {
        id: sessionId, userId, agencyId, tokenHash: token("hash"), deviceId,
        authorizationSessionId: lineage, rememberDevice: true,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const telemetryTx = reader.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT "id","authorizationSessionId"
           FROM "RefreshSession"
          WHERE "userId"=$1 AND "agencyId"=$2 AND "deviceId"=$3
            AND "authorizationSessionId"=$4 AND "revokedAt" IS NULL
            AND "expiresAt" > clock_timestamp()
          FOR SHARE`,
        userId, agencyId, deviceId, lineage,
      );
      assert.equal(rows[0]?.authorizationSessionId, lineage);
      locked.resolve();
      await releaseRead.promise;
      const clock = await tx.$queryRawUnsafe(`SELECT clock_timestamp() AS "now"`);
      releaseDbTime = new Date(clock[0].now);
      await tx.$queryRawUnsafe(`SELECT 1`);
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });

    await locked.promise;
    let revokeCommitted = false;
    const revoke = writer.refreshSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    }).then((row) => { revokeCommitted = true; return row; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(revokeCommitted, false, "lineage revoke must wait while telemetry owns FOR SHARE session fence");

    releaseRead.resolve();
    await telemetryTx;
    await revoke;

    const boundaries = await reader.$queryRawUnsafe(
      `SELECT "endedAt" FROM "AuthorizationSessionBoundary" WHERE "authorizationSessionId"=$1`, lineage,
    );
    assert.equal(boundaries.length, 1);
    assert.ok(Number.isFinite(new Date(boundaries[0].endedAt).getTime()));
    assert.ok(releaseDbTime && new Date(boundaries[0].endedAt).getTime() >= releaseDbTime.getTime(),
      "login-lineage boundary must be DB-timestamped after the SHARE-lock holder reaches release");
  } finally {
    releaseRead.resolve();
    await cleanupAgency(reader, agencyId);
    try { await reader.user.delete({ where: { id: userId } }); } catch (_) {}
    await reader.$disconnect();
    await writer.$disconnect();
  }
});

test("Actual59 INT59.3 PostgreSQL: telemetry SHARE fence serializes creator-catalog generation bump and records server boundary", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const reader = new PrismaClient();
  const writer = new PrismaClient();
  const agencyId = token("a59_catalog_agency");
  const locked = deferred();
  const releaseRead = deferred();
  let releaseDbTime = null;

  try {
    await withTeamGeneration(reader, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    const state = await reader.agencyCreatorCatalogState.upsert({
      where: { agencyId },
      create: { agencyId, generation: 1 },
      update: {},
      select: { generation: true },
    });
    const oldGeneration = Number(state.generation);

    const telemetryTx = reader.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT "generation" FROM "AgencyCreatorCatalogState" WHERE "agencyId"=$1 FOR SHARE`, agencyId,
      );
      assert.equal(Number(rows[0]?.generation), oldGeneration);
      locked.resolve();
      await releaseRead.promise;
      const clock = await tx.$queryRawUnsafe(`SELECT clock_timestamp() AS "now"`);
      releaseDbTime = new Date(clock[0].now);
      await tx.$queryRawUnsafe(`SELECT 1`);
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });

    await locked.promise;
    let bumpCommitted = false;
    const bump = writer.agencyCreatorCatalogState.update({
      where: { agencyId }, data: { generation: { increment: 1 } }, select: { generation: true },
    }).then((row) => { bumpCommitted = true; return row; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(bumpCommitted, false, "catalog generation UPDATE must wait while telemetry owns FOR SHARE catalog fence");

    releaseRead.resolve();
    await telemetryTx;
    const bumped = await bump;
    assert.equal(Number(bumped.generation), oldGeneration + 1);

    const boundaries = await reader.$queryRawUnsafe(
      `SELECT "generation","nextGeneration","endedAt"
         FROM "AgencyCreatorCatalogGenerationBoundary"
        WHERE "agencyId"=$1 AND "generation"=$2`, agencyId, oldGeneration,
    );
    assert.equal(boundaries.length, 1);
    assert.equal(Number(boundaries[0].nextGeneration), oldGeneration + 1);
    assert.ok(Number.isFinite(new Date(boundaries[0].endedAt).getTime()));
    assert.ok(releaseDbTime && new Date(boundaries[0].endedAt).getTime() >= releaseDbTime.getTime(),
      "catalog generation boundary must be DB-timestamped after the SHARE-lock holder reaches release");
  } finally {
    releaseRead.resolve();
    await cleanupAgency(reader, agencyId);
    await reader.$disconnect();
    await writer.$disconnect();
  }
});


test("Actual59 INT59.4B PostgreSQL: one advisory device identity serializes concurrent same-device lineage replacement", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const first = new PrismaClient();
  const second = new PrismaClient();
  const agencyId = token("a59_device_lock_agency");
  const userId = token("a59_device_lock_user");
  const deviceId = token("a59_device_lock_device");
  const key = `authorization-device:${userId}:${agencyId}:${deviceId}`;
  const firstLocked = deferred();
  const releaseFirst = deferred();

  try {
    await withTeamGeneration(first, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    await first.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "integration" } });

    const tx1 = first.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, key);
      await tx.refreshSession.create({
        data: { userId, agencyId, tokenHash: token("hash_a"), deviceId, authorizationSessionId: "lineage-A", expiresAt: new Date(Date.now()+60_000) },
      });
      firstLocked.resolve();
      await releaseFirst.promise;
      await tx.refreshSession.updateMany({
        where: { userId, agencyId, deviceId, revokedAt: null, authorizationSessionId: { not: "lineage-A" } },
        data: { revokedAt: new Date() },
      });
    });

    await firstLocked.promise;
    let secondAcquired = false;
    const tx2 = second.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, key);
      secondAcquired = true;
      const created = await tx.refreshSession.create({
        data: { userId, agencyId, tokenHash: token("hash_b"), deviceId, authorizationSessionId: "lineage-B", expiresAt: new Date(Date.now()+60_000) },
        select: { id: true },
      });
      await tx.refreshSession.updateMany({
        where: { userId, agencyId, deviceId, revokedAt: null, id: { not: created.id } },
        data: { revokedAt: new Date() },
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(secondAcquired, false, "second same-device generation must wait on the canonical advisory identity");
    releaseFirst.resolve();
    await tx1;
    await tx2;

    const active = await first.refreshSession.findMany({
      where: { userId, agencyId, deviceId, revokedAt: null },
      select: { authorizationSessionId: true },
    });
    assert.deepEqual(active.map((row) => row.authorizationSessionId), ["lineage-B"]);
  } finally {
    releaseFirst.resolve();
    await cleanupAgency(first, agencyId);
    try { await first.user.delete({ where: { id: userId } }); } catch (_) {}
    await first.$disconnect();
    await second.$disconnect();
  }
});


test("Actual59 INT59.4D PostgreSQL: committed member deactivation wins before stale login publication", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const reader = new PrismaClient();
  const writer = new PrismaClient();
  const agencyId = token("a59_login_member_agency");
  const userId = token("a59_login_member_user");
  const memberId = token("a59_login_member_member");
  const writerLocked = deferred();
  const releaseWriter = deferred();

  try {
    await withTeamGeneration(reader, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    await reader.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "pw-old", emailVerifiedAt: new Date() } });
    await withTeamGeneration(reader, (tx) => tx.agencyMember.create({
      data: { id: memberId, agencyId, userId, role: "CHATTER", roleKey: "chatter", assignedCreators: [] },
    }));
    const member = await reader.agencyMember.findUnique({ where: { id: memberId }, select: { accessEpoch: true } });

    const change = writer.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config($1,$2,true) AS value`, release.TEAM_CONTROL_PLANE_DB_SETTING, release.TEAM_CONTROL_PLANE_GENERATION);
      await tx.agencyMember.update({ where: { id: memberId }, data: { deactivatedAt: new Date(), accessEpoch: { increment: 1 } } });
      writerLocked.resolve();
      await releaseWriter.promise;
    });
    await writerLocked.promise;

    let loginSettled = false;
    const login = reader.$transaction(async (tx) => authAuthority.lockCurrentLoginAuthority(tx, {
      userId, agencyId, memberId, expectedAccessEpoch: Number(member.accessEpoch), expectedPasswordHash: "pw-old",
    })).then(() => { loginSettled = true; return null; }, (error) => { loginSettled = true; return error; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(loginSettled, false, "login authority fence must wait behind the in-flight member mutation");
    releaseWriter.resolve();
    await change;
    const error = await login;
    assert.ok(error && ["AUTHORIZATION_CHANGED", "AUTHORIZATION_GENERATION_CHANGED"].includes(error.code), `unexpected login result: ${error?.code || "success"}`);
  } finally {
    releaseWriter.resolve();
    await cleanupAgency(reader, agencyId);
    try { await reader.user.delete({ where: { id: userId } }); } catch (_) {}
    await reader.$disconnect();
    await writer.$disconnect();
  }
});

test("Actual59 INT59.4D PostgreSQL: committed password generation change wins before stale login publication", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const reader = new PrismaClient();
  const writer = new PrismaClient();
  const agencyId = token("a59_login_pw_agency");
  const userId = token("a59_login_pw_user");
  const memberId = token("a59_login_pw_member");
  const writerLocked = deferred();
  const releaseWriter = deferred();

  try {
    await withTeamGeneration(reader, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    await reader.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "pw-old", emailVerifiedAt: new Date() } });
    await withTeamGeneration(reader, (tx) => tx.agencyMember.create({
      data: { id: memberId, agencyId, userId, role: "CHATTER", roleKey: "chatter", assignedCreators: [] },
    }));
    const member = await reader.agencyMember.findUnique({ where: { id: memberId }, select: { accessEpoch: true } });

    const change = writer.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash: "pw-new" } });
      writerLocked.resolve();
      await releaseWriter.promise;
    });
    await writerLocked.promise;

    let loginSettled = false;
    const login = reader.$transaction(async (tx) => authAuthority.lockCurrentLoginAuthority(tx, {
      userId, agencyId, memberId, expectedAccessEpoch: Number(member.accessEpoch), expectedPasswordHash: "pw-old",
    })).then(() => { loginSettled = true; return null; }, (error) => { loginSettled = true; return error; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(loginSettled, false, "login SHARE fence must wait behind the password UPDATE");
    releaseWriter.resolve();
    await change;
    const error = await login;
    assert.equal(error?.code, "CREDENTIAL_GENERATION_CHANGED");
  } finally {
    releaseWriter.resolve();
    await cleanupAgency(reader, agencyId);
    try { await reader.user.delete({ where: { id: userId } }); } catch (_) {}
    await reader.$disconnect();
    await writer.$disconnect();
  }
});

test("Actual59 INT59.4D PostgreSQL: refresh publication and same-device logout share USER/DEVICE serialization", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const first = new PrismaClient();
  const second = new PrismaClient();
  const agencyId = token("a59_refresh_logout_agency");
  const userId = token("a59_refresh_logout_user");
  const deviceId = token("a59_refresh_logout_device");
  const sessionId = token("a59_refresh_logout_session");
  const tokenHash = token("a59_refresh_logout_hash");
  const firstLocked = deferred();
  const releaseFirst = deferred();

  try {
    await withTeamGeneration(first, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    await first.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "pw" } });
    await first.refreshSession.create({ data: {
      id: sessionId, userId, agencyId, tokenHash, deviceId, authorizationSessionId: "lineage-A", expiresAt: new Date(Date.now()+60_000),
    } });

    const refresh = first.$transaction(async (tx) => {
      await authAuthority.acquireAuthorizationUserLock(tx, { userId });
      await authAuthority.acquireAuthorizationDeviceLock(tx, { userId, agencyId, deviceId });
      await authAuthority.lockCurrentRefreshSession(tx, { sessionId, tokenHash, userId, agencyId });
      firstLocked.resolve();
      await releaseFirst.promise;
    });
    await firstLocked.promise;

    let logoutAcquired = false;
    const logout = second.$transaction(async (tx) => {
      await authAuthority.acquireAuthorizationUserLock(tx, { userId });
      await authAuthority.acquireAuthorizationDeviceLock(tx, { userId, agencyId, deviceId });
      logoutAcquired = true;
      await tx.refreshSession.updateMany({ where: { userId, agencyId, deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(logoutAcquired, false, "same-device logout must wait behind refresh publication serialization");
    releaseFirst.resolve();
    await refresh;
    await logout;
    const row = await first.refreshSession.findUnique({ where: { id: sessionId }, select: { revokedAt: true } });
    assert.ok(row.revokedAt);
  } finally {
    releaseFirst.resolve();
    await cleanupAgency(first, agencyId);
    try { await first.user.delete({ where: { id: userId } }); } catch (_) {}
    await first.$disconnect();
    await second.$disconnect();
  }
});

test("Actual59 INT59.4D PostgreSQL: USER advisory serialization spans different devices for one user", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const first = new PrismaClient();
  const second = new PrismaClient();
  const userId = token("a59_user_lock");
  const firstLocked = deferred();
  const releaseFirst = deferred();

  try {
    const tx1 = first.$transaction(async (tx) => {
      await authAuthority.acquireAuthorizationUserLock(tx, { userId });
      firstLocked.resolve();
      await releaseFirst.promise;
    });
    await firstLocked.promise;
    let secondAcquired = false;
    const tx2 = second.$transaction(async (tx) => {
      await authAuthority.acquireAuthorizationUserLock(tx, { userId });
      secondAcquired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(secondAcquired, false, "same-user login/refresh on another device must wait behind the canonical USER lock");
    releaseFirst.resolve();
    await tx1;
    await tx2;
    assert.equal(secondAcquired, true);
  } finally {
    releaseFirst.resolve();
    await first.$disconnect();
    await second.$disconnect();
  }
});

test("Actual59 INT59.4D PostgreSQL: one Desktop incarnation serializes cross-device legacy adoption", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const first = new PrismaClient();
  const second = new PrismaClient();
  const lineage = token("a59_cross_device_lineage");
  const firstLocked = deferred();
  const releaseFirst = deferred();

  try {
    const tx1 = first.$transaction(async (tx) => {
      await authAuthority.acquireAuthorizationLineageLock(tx, lineage);
      firstLocked.resolve();
      await releaseFirst.promise;
    });
    await firstLocked.promise;
    let secondAcquired = false;
    const tx2 = second.$transaction(async (tx) => {
      await authAuthority.acquireAuthorizationLineageLock(tx, lineage);
      secondAcquired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(secondAcquired, false, "second device must wait before checking/adopting the same Desktop incarnation");
    releaseFirst.resolve();
    await tx1;
    await tx2;
    assert.equal(secondAcquired, true);
  } finally {
    releaseFirst.resolve();
    await first.$disconnect();
    await second.$disconnect();
  }
});

test("Actual59 INT59.4D PostgreSQL: refresh source expiry while waiting on USER lock is rejected at commit fence", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const blocker = new PrismaClient();
  const consumer = new PrismaClient();
  const agencyId = token("a59_refresh_expiry_agency");
  const userId = token("a59_refresh_expiry_user");
  const deviceId = token("a59_refresh_expiry_device");
  const sessionId = token("a59_refresh_expiry_session");
  const tokenHash = token("a59_refresh_expiry_hash");
  const blockerLocked = deferred();
  const releaseBlocker = deferred();

  try {
    await withTeamGeneration(blocker, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    await blocker.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "pw" } });
    await blocker.refreshSession.create({ data: {
      id: sessionId, userId, agencyId, tokenHash, deviceId, authorizationSessionId: "lineage-A", expiresAt: new Date(Date.now()+300),
    } });

    const hold = blocker.$transaction(async (tx) => {
      await authAuthority.acquireAuthorizationUserLock(tx, { userId });
      blockerLocked.resolve();
      await releaseBlocker.promise;
    });
    await blockerLocked.promise;

    let result = null;
    const attempt = consumer.$transaction(async (tx) => {
      await authAuthority.acquireAuthorizationUserLock(tx, { userId });
      await authAuthority.acquireAuthorizationDeviceLock(tx, { userId, agencyId, deviceId });
      try {
        await authAuthority.lockCurrentRefreshSession(tx, { sessionId, tokenHash, userId, agencyId });
        result = "accepted";
      } catch (error) {
        result = error?.code || "error";
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    releaseBlocker.resolve();
    await hold;
    await attempt;
    assert.equal(result, "REFRESH_INVALID", "DB-clock source-session fence must reject a token that expired while waiting on serialization");
  } finally {
    releaseBlocker.resolve();
    await cleanupAgency(blocker, agencyId);
    try { await blocker.user.delete({ where: { id: userId } }); } catch (_) {}
    await blocker.$disconnect();
    await consumer.$disconnect();
  }
});
