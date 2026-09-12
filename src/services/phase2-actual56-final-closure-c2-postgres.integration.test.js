"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const release = require("./phase2-release-compatibility-authority-service");
const work = require("./domain-work-authority-service");
const {
  lockTeamControlPlaneTopology,
  lockLiveTeamControlPlaneCreators,
} = require("./team-control-plane-authority-service");
const { lockLiveActor } = require("./management-commit-authority-service");

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bounded(promise, label, ms = 7_500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanupAgency(db, agencyId) {
  try {
    await work.publishDomainWork({
      db,
      agencyId,
      workClass: work.WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
      objectType: "Phase2AgencyDestructiveCleanup",
      objectId: agencyId,
      partitionKey: agencyId,
      availableAt: new Date(Date.now() - 1_000),
    });
    await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, agencyId);
      await tx.agency.delete({ where: { id: agencyId } });
    });
  } catch (_) {
    // Integration databases are disposable. Cleanup must not hide the lock-order
    // assertion if an unrelated destructive fixture rule changes later.
  }
}

async function createTeamFixture(db, { withRole = false, withCreators = 0 } = {}) {
  const agencyId = token("c2_agency");
  const userAId = token("c2_user_a");
  const userBId = token("c2_user_b");
  const memberAId = token("c2_member_a");
  const memberBId = token("c2_member_b");
  const roleKey = withRole ? token("role").slice(0, 80).toLowerCase() : null;

  await db.agency.create({ data: { id: agencyId, name: agencyId } });
  await db.user.createMany({
    data: [
      { id: userAId, email: `${userAId}@example.test`, passwordHash: "integration" },
      { id: userBId, email: `${userBId}@example.test`, passwordHash: "integration" },
    ],
  });
  await db.agencyMember.createMany({
    data: [
      { id: memberAId, agencyId, userId: userAId, role: "OWNER", roleKey: "owner", assignedCreators: "all" },
      { id: memberBId, agencyId, userId: userBId, role: "MANAGER", roleKey: roleKey || "manager", assignedCreators: "all" },
    ],
  });
  if (roleKey) {
    await db.agencyCustomRole.create({
      data: { id: token("c2_role"), agencyId, key: roleKey, label: "C2 integration role", access: {} },
    });
  }

  const creatorIds = [];
  for (let index = 0; index < withCreators; index += 1) {
    const creatorId = token(`c2_creator_${index}`);
    await release.runCreatorAccountWriteTransaction(db, (tx) => tx.creatorAccount.create({
      data: { id: creatorId, agencyId, displayName: creatorId, username: token(`c2_username_${index}`) },
    }));
    creatorIds.push(creatorId);
  }

  const [memberA, memberB] = await Promise.all([
    db.agencyMember.findUnique({ where: { id: memberAId } }),
    db.agencyMember.findUnique({ where: { id: memberBId } }),
  ]);
  return { agencyId, userAId, userBId, memberAId, memberBId, memberA, memberB, roleKey, creatorIds };
}

function lockTeamRoleLifecycle(args) {
  return require("./team-administration-service").lockTeamRoleLifecycle(args);
}

async function withTwoClients(run) {
  const { PrismaClient } = require("@prisma/client");
  const left = new PrismaClient();
  const right = new PrismaClient();
  try {
    return await run(left, right);
  } finally {
    await Promise.allSettled([left.$disconnect(), right.$disconnect()]);
  }
}

test("C2 PostgreSQL: manager A->B and manager B->A serialize before any Member cross-lock", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left);
    const leftHasTopology = deferred();
    const releaseLeft = deferred();
    let rightHasTopology = false;

    try {
      const t1 = left.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        await lockLiveActor({ tx, agencyId: fx.agencyId, actorMember: fx.memberA });
        await tx.agencyMember.update({ where: { id: fx.memberBId }, data: { accessEpoch: { increment: 1 } } });
        leftHasTopology.resolve();
        await releaseLeft.promise;
      });

      await leftHasTopology.promise;
      const t2 = right.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        rightHasTopology = true;
        const freshB = await tx.agencyMember.findUnique({ where: { id: fx.memberBId } });
        await lockLiveActor({ tx, agencyId: fx.agencyId, actorMember: freshB });
        await tx.agencyMember.update({ where: { id: fx.memberAId }, data: { accessEpoch: { increment: 1 } } });
      });

      await delay(125);
      assert.equal(rightHasTopology, false, "second manager must wait at topology, not while holding its actor Member");
      releaseLeft.resolve();
      await bounded(Promise.all([t1, t2]), "manager cross-mutation interleaving");

      const [afterA, afterB] = await Promise.all([
        left.agencyMember.findUnique({ where: { id: fx.memberAId }, select: { accessEpoch: true } }),
        left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { accessEpoch: true } }),
      ]);
      assert.equal(afterA.accessEpoch, fx.memberA.accessEpoch + 1);
      assert.equal(afterB.accessEpoch, fx.memberB.accessEpoch + 1);
    } finally {
      releaseLeft.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});

test("C2 PostgreSQL: Role writer and Member role writer serialize as topology -> Role -> Member", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left, { withRole: true });
    const leftHasRole = deferred();
    const releaseLeft = deferred();
    let rightHasTopology = false;

    try {
      const t1 = left.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        await lockTeamRoleLifecycle({ tx, agencyId: fx.agencyId, roleKey: fx.roleKey, mode: "update", agencyAlreadyLocked: true });
        await tx.agencyMember.updateMany({
          where: { agencyId: fx.agencyId, deletedAt: null, deactivatedAt: null },
          data: { accessEpoch: { increment: 1 } },
        });
        leftHasRole.resolve();
        await releaseLeft.promise;
      });
      await leftHasRole.promise;

      const t2 = right.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        rightHasTopology = true;
        await lockTeamRoleLifecycle({ tx, agencyId: fx.agencyId, roleKey: fx.roleKey, mode: "share", agencyAlreadyLocked: true });
        await tx.agencyMember.update({ where: { id: fx.memberAId }, data: { accessEpoch: { increment: 1 } } });
      });

      await delay(125);
      assert.equal(rightHasTopology, false, "member-role writer must not acquire Role/Member while another topology writer is live");
      releaseLeft.resolve();
      await bounded(Promise.all([t1, t2]), "role/member interleaving");
    } finally {
      releaseLeft.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});

test("C2 PostgreSQL: Creator retirement wins before stale scope-add/claim can reintroduce retired Creator", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left, { withCreators: 1 });
    const [creatorId] = fx.creatorIds;
    await left.agencyMember.update({ where: { id: fx.memberBId }, data: { assignedCreators: [creatorId] } });
    const before = await left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { accessEpoch: true } });
    const retiredLocked = deferred();
    const releaseRetirement = deferred();
    let staleWriterReachedTopology = false;

    try {
      const retire = left.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        const lock = await lockLiveTeamControlPlaneCreators({ tx, agencyId: fx.agencyId, creatorIds: [creatorId], mode: "update" });
        assert.deepEqual(lock.missingCreatorIds, []);
        await release.authorizeCreatorAccountWrite(tx);
        await tx.creatorAccount.update({ where: { id: creatorId }, data: { deletedAt: new Date() } });
        await tx.agencyMember.update({
          where: { id: fx.memberBId },
          data: { assignedCreators: [], accessEpoch: { increment: 1 } },
        });
        retiredLocked.resolve();
        await releaseRetirement.promise;
      });
      await retiredLocked.promise;

      const staleScopeAdd = right.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        staleWriterReachedTopology = true;
        const lock = await lockLiveTeamControlPlaneCreators({ tx, agencyId: fx.agencyId, creatorIds: [creatorId], mode: "share" });
        assert.deepEqual(lock.missingCreatorIds, [creatorId]);
        // Canonical caller must fail here; deliberately do not write assignedCreators.
      });

      await delay(125);
      assert.equal(staleWriterReachedTopology, false, "scope/claim writer must wait before it can observe or mutate Member topology");
      releaseRetirement.resolve();
      await bounded(Promise.all([retire, staleScopeAdd]), "retire/scope-add interleaving");

      const [creator, member] = await Promise.all([
        left.creatorAccount.findUnique({ where: { id: creatorId }, select: { deletedAt: true } }),
        left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { assignedCreators: true, accessEpoch: true } }),
      ]);
      assert.ok(creator.deletedAt);
      assert.deepEqual(member.assignedCreators, []);
      assert.equal(member.accessEpoch, before.accessEpoch + 1);
    } finally {
      releaseRetirement.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});

test("C2 PostgreSQL: cross-Agency User disable keeps User -> Member suffix and cannot deadlock Team topology", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left);
    const userLocked = deferred();
    const finishDisable = deferred();
    let teamReachedMember = false;

    try {
      const disable = left.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE`, fx.userAId);
        await tx.user.update({ where: { id: fx.userAId }, data: { disabledAt: new Date(), sessionsRevokedAt: new Date() } });
        userLocked.resolve();
        await finishDisable.promise;
        await tx.agencyMember.updateMany({
          where: { userId: fx.userAId, deletedAt: null },
          data: { accessEpoch: { increment: 1 } },
        });
      });
      await userLocked.promise;

      const team = right.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        try {
          await lockLiveActor({ tx, agencyId: fx.agencyId, actorMember: fx.memberA });
          teamReachedMember = true;
          throw new Error("disabled actor unexpectedly passed commit-time liveness proof");
        } catch (error) {
          if (error?.code !== "MANAGEMENT_USER_DISABLED") throw error;
          return error.code;
        }
      });

      await delay(125);
      assert.equal(teamReachedMember, false, "Team writer must wait on User before owning Member");
      finishDisable.resolve();
      const [, result] = await bounded(Promise.all([disable, team]), "User-disable/Team interleaving");
      assert.equal(result, "MANAGEMENT_USER_DISABLED");
      assert.equal(teamReachedMember, false);
    } finally {
      finishDisable.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});

test("C2 PostgreSQL: overlapping Creator retirements touching one Member serialize and conserve scope/epoch", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left, { withCreators: 2 });
    const [creatorA, creatorB] = fx.creatorIds;
    await left.agencyMember.update({ where: { id: fx.memberBId }, data: { assignedCreators: [creatorA, creatorB] } });
    const before = await left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { accessEpoch: true } });
    const firstLocked = deferred();
    const releaseFirst = deferred();
    let secondHasTopology = false;

    async function retireOne(tx, creatorId) {
      await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
      const lock = await lockLiveTeamControlPlaneCreators({ tx, agencyId: fx.agencyId, creatorIds: [creatorId], mode: "update" });
      assert.deepEqual(lock.missingCreatorIds, []);
      await release.authorizeCreatorAccountWrite(tx);
      await tx.creatorAccount.update({ where: { id: creatorId }, data: { deletedAt: new Date() } });
      const member = await tx.agencyMember.findUnique({ where: { id: fx.memberBId } });
      const next = (Array.isArray(member.assignedCreators) ? member.assignedCreators : []).filter((id) => String(id) !== creatorId);
      await tx.agencyMember.update({ where: { id: fx.memberBId }, data: { assignedCreators: next, accessEpoch: { increment: 1 } } });
    }

    try {
      const t1 = left.$transaction(async (tx) => {
        await retireOne(tx, creatorA);
        firstLocked.resolve();
        await releaseFirst.promise;
      });
      await firstLocked.promise;

      const t2 = right.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        secondHasTopology = true;
        const lock = await lockLiveTeamControlPlaneCreators({ tx, agencyId: fx.agencyId, creatorIds: [creatorB], mode: "update" });
        assert.deepEqual(lock.missingCreatorIds, []);
        await release.authorizeCreatorAccountWrite(tx);
        await tx.creatorAccount.update({ where: { id: creatorB }, data: { deletedAt: new Date() } });
        const member = await tx.agencyMember.findUnique({ where: { id: fx.memberBId } });
        const next = (Array.isArray(member.assignedCreators) ? member.assignedCreators : []).filter((id) => String(id) !== creatorB);
        await tx.agencyMember.update({ where: { id: fx.memberBId }, data: { assignedCreators: next, accessEpoch: { increment: 1 } } });
      });

      await delay(125);
      assert.equal(secondHasTopology, false);
      releaseFirst.resolve();
      await bounded(Promise.all([t1, t2]), "overlapping Creator retirement interleaving");

      const member = await left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { assignedCreators: true, accessEpoch: true } });
      assert.deepEqual(member.assignedCreators, []);
      assert.equal(member.accessEpoch, before.accessEpoch + 2);
    } finally {
      releaseFirst.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});


test("C2 PostgreSQL: scope removal can commit before Creator retirement without lost scope or deadlock", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left, { withCreators: 1 });
    const [creatorId] = fx.creatorIds;
    await left.agencyMember.update({ where: { id: fx.memberBId }, data: { assignedCreators: [creatorId] } });
    const before = await left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { accessEpoch: true } });
    const scopeRemoved = deferred();
    const releaseScope = deferred();
    let retirementHasTopology = false;

    try {
      const removeScope = left.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        await tx.agencyMember.update({
          where: { id: fx.memberBId },
          data: { assignedCreators: [], accessEpoch: { increment: 1 } },
        });
        scopeRemoved.resolve();
        await releaseScope.promise;
      });
      await scopeRemoved.promise;

      const retire = right.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        retirementHasTopology = true;
        const lock = await lockLiveTeamControlPlaneCreators({ tx, agencyId: fx.agencyId, creatorIds: [creatorId], mode: "update" });
        assert.deepEqual(lock.missingCreatorIds, []);
        await release.authorizeCreatorAccountWrite(tx);
        await tx.creatorAccount.update({ where: { id: creatorId }, data: { deletedAt: new Date() } });
      });

      await delay(125);
      assert.equal(retirementHasTopology, false);
      releaseScope.resolve();
      await bounded(Promise.all([removeScope, retire]), "scope-remove/retirement interleaving");

      const [creator, member] = await Promise.all([
        left.creatorAccount.findUnique({ where: { id: creatorId }, select: { deletedAt: true } }),
        left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { assignedCreators: true, accessEpoch: true } }),
      ]);
      assert.ok(creator.deletedAt);
      assert.deepEqual(member.assignedCreators, []);
      assert.equal(member.accessEpoch, before.accessEpoch + 1);
    } finally {
      releaseScope.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});

test("C2 PostgreSQL: invitation claim/restore cannot materialize a Member with a Creator retired while it waited", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left, { withRole: true, withCreators: 1 });
    const [creatorId] = fx.creatorIds;
    const inviteUserId = token("c2_invite_user");
    await left.user.create({ data: { id: inviteUserId, email: `${inviteUserId}@example.test`, passwordHash: "integration" } });
    const retired = deferred();
    const releaseRetirement = deferred();
    let claimHasTopology = false;

    try {
      const retire = left.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        const lock = await lockLiveTeamControlPlaneCreators({ tx, agencyId: fx.agencyId, creatorIds: [creatorId], mode: "update" });
        assert.deepEqual(lock.missingCreatorIds, []);
        await release.authorizeCreatorAccountWrite(tx);
        await tx.creatorAccount.update({ where: { id: creatorId }, data: { deletedAt: new Date() } });
        retired.resolve();
        await releaseRetirement.promise;
      });
      await retired.promise;

      const claim = right.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        claimHasTopology = true;
        await lockTeamRoleLifecycle({ tx, agencyId: fx.agencyId, roleKey: fx.roleKey, mode: "share", agencyAlreadyLocked: true });
        const lock = await lockLiveTeamControlPlaneCreators({ tx, agencyId: fx.agencyId, creatorIds: [creatorId], mode: "share" });
        assert.deepEqual(lock.missingCreatorIds, [creatorId]);
        // The production claim path fails before User/Member materialization here.
      });

      await delay(125);
      assert.equal(claimHasTopology, false);
      releaseRetirement.resolve();
      await bounded(Promise.all([retire, claim]), "invitation-claim/retirement interleaving");

      const member = await left.agencyMember.findUnique({ where: { agencyId_userId: { agencyId: fx.agencyId, userId: inviteUserId } } });
      assert.equal(member, null, "stale invitation claim must not materialize a Member after Creator retirement");
    } finally {
      releaseRetirement.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});

test("C2 PostgreSQL: platform-admin Member mutation and ordinary Team mutation share the same topology prefix", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left);
    const before = await left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { accessEpoch: true } });
    const adminUpdated = deferred();
    const releaseAdmin = deferred();
    let ordinaryHasTopology = false;

    try {
      const platformAdmin = left.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        await tx.$queryRawUnsafe(`SELECT "id" FROM "AgencyMember" WHERE "id"=$1 AND "agencyId"=$2 FOR UPDATE`, fx.memberBId, fx.agencyId);
        await tx.agencyMember.update({ where: { id: fx.memberBId }, data: { accessEpoch: { increment: 1 } } });
        adminUpdated.resolve();
        await releaseAdmin.promise;
      });
      await adminUpdated.promise;

      const ordinary = right.$transaction(async (tx) => {
        await lockTeamControlPlaneTopology({ tx, agencyId: fx.agencyId });
        ordinaryHasTopology = true;
        const actor = await tx.agencyMember.findUnique({ where: { id: fx.memberAId } });
        await lockLiveActor({ tx, agencyId: fx.agencyId, actorMember: actor });
        await tx.agencyMember.update({ where: { id: fx.memberBId }, data: { accessEpoch: { increment: 1 } } });
      });

      await delay(125);
      assert.equal(ordinaryHasTopology, false);
      releaseAdmin.resolve();
      await bounded(Promise.all([platformAdmin, ordinary]), "platform-admin/Team interleaving");

      const member = await left.agencyMember.findUnique({ where: { id: fx.memberBId }, select: { accessEpoch: true } });
      assert.equal(member.accessEpoch, before.accessEpoch + 2);
    } finally {
      releaseAdmin.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});

function assertUserDisableOwnerSafetyPg(args) {
  return require("./team-administration-service").assertUserDisableOwnerSafety(args);
}

function updateMemberAccessByPlatformAdminPg(args) {
  return require("./team-administration-service").updateMemberAccessByPlatformAdmin(args);
}

test("C2 PostgreSQL: direct disable of the sole operational OWNER is rejected in the User transaction", { skip: !enabled }, async () => {
  await withTwoClients(async (left) => {
    const fx = await createTeamFixture(left);
    try {
      await assert.rejects(
        () => left.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE`, fx.userAId);
          await assertUserDisableOwnerSafetyPg({ tx, userId: fx.userAId });
          await tx.user.update({ where: { id: fx.userAId }, data: { disabledAt: new Date() } });
        }, { isolationLevel: "Serializable" }),
        (error) => error?.code === "LAST_OWNER" && error?.status === 409,
      );

      const user = await left.user.findUnique({ where: { id: fx.userAId }, select: { disabledAt: true } });
      assert.equal(user.disabledAt, null, "sole operational OWNER disable must roll back before eligibility changes");
    } finally {
      await cleanupAgency(left, fx.agencyId);
    }
  });
});

test("C2 PostgreSQL: concurrent User-disable vs other OWNER demotion cannot commit zero operational OWNERs", { skip: !enabled }, async () => {
  await withTwoClients(async (left, right) => {
    const fx = await createTeamFixture(left);
    await left.agencyMember.update({
      where: { id: fx.memberBId },
      data: { role: "OWNER", roleKey: "owner" },
    });

    const disableReadComplete = deferred();
    const finishDisable = deferred();

    try {
      const disable = left.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE`, fx.userBId);
        await assertUserDisableOwnerSafetyPg({ tx, userId: fx.userBId });
        disableReadComplete.resolve();
        await finishDisable.promise;
        await tx.user.update({ where: { id: fx.userBId }, data: { disabledAt: new Date() } });
        await tx.agencyMember.updateMany({
          where: { userId: fx.userBId, deletedAt: null },
          data: { accessEpoch: { increment: 1 } },
        });
      }, { isolationLevel: "Serializable" });

      await disableReadComplete.promise;

      const demote = updateMemberAccessByPlatformAdminPg({
        agencyId: fx.agencyId,
        memberId: fx.memberAId,
        legacyRole: "MANAGER",
        roleKey: "manager",
        db: right,
      });

      // Let the demotion read B as operational and attempt to commit while the
      // disable transaction still owns the old snapshot. The second write then
      // creates the SSI cycle; PostgreSQL must abort one ordering, not commit zero owners.
      const demoteSettled = await bounded(Promise.allSettled([demote]), "owner demotion before disable release");
      finishDisable.resolve();
      const disableSettled = await bounded(Promise.allSettled([disable]), "owner disable after demotion");
      const results = [...demoteSettled, ...disableSettled];

      for (const result of results) {
        if (result.status !== "rejected") continue;
        const text = `${result.reason?.code || ""} ${result.reason?.message || ""} ${JSON.stringify(result.reason?.meta || {})}`;
        assert.doesNotMatch(text, /40P01|deadlock detected/i, "owner invariant conflict must not depend on a deadlock victim");
      }

      const operationalOwners = await left.agencyMember.count({
        where: {
          agencyId: fx.agencyId,
          deletedAt: null,
          deactivatedAt: null,
          user: { is: { disabledAt: null } },
          OR: [{ roleKey: "owner" }, { role: "OWNER" }],
        },
      });
      assert.ok(operationalOwners >= 1, "serializable final state must preserve at least one operational OWNER");
    } finally {
      finishDisable.resolve();
      await cleanupAgency(left, fx.agencyId);
    }
  });
});
