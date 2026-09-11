"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
function token(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function mustStillWait(promise, ms = 100) {
  const pending = Symbol("pending");
  const result = await Promise.race([
    promise.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  assert.equal(result, pending, "concurrent ready-head writer crossed a held head authority");
}

async function createWork(tx, { id, agencyId, workClass, partitionKey, creatorId, due }) {
  return tx.domainWorkItem.create({ data: {
    id, agencyId, workClass, objectType: "Actual54ReadyHeadFixture", objectId: id,
    partitionKey, creatorId, requestedRevision: 1n, completedRevision: 0n,
    activeGeneration: "phase2_domain_work_v2_actual53", projectionVersion: "phase2_domain_work_v2_actual53",
    state: "READY", isOutstanding: true, availableAt: due,
  }});
}

test("F54-02 PostgreSQL: concurrent same/different-partition head writers converge to the real minimum", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const agencyId = token("p2_actual54_head_agency");
  const workClass = "CUSTOM_COMMUNICATION";
  const early = new Date(Date.now() - 20_000);
  const later = new Date(Date.now() - 10_000);

  try {
    await db1.agency.create({ data: { id: agencyId, name: agencyId } });

    const samePartition = token("same_partition");
    const t1Ready = deferred(); const releaseT1 = deferred();
    const t1 = db1.$transaction(async (tx) => {
      await createWork(tx, { id: token("same_early"), agencyId, workClass, partitionKey: samePartition, creatorId: "creator-a", due: early });
      t1Ready.resolve();
      await releaseT1.promise;
    }, { maxWait: 10_000, timeout: 30_000 });
    await t1Ready.promise;

    const t2 = db2.$transaction(async (tx) => {
      await createWork(tx, { id: token("same_later"), agencyId, workClass, partitionKey: samePartition, creatorId: "creator-a", due: later });
    }, { maxWait: 10_000, timeout: 30_000 });
    await mustStillWait(t2);
    releaseT1.resolve();
    await Promise.all([t1, t2]);

    const sameHead = await db1.domainWorkReadyPartition.findUnique({
      where: { agencyId_workClass_partitionKey: { agencyId, workClass, partitionKey: samePartition } },
    });
    assert.equal(sameHead?.nextDueAt?.getTime(), early.getTime());

    // Different partitions share one agency/class head. Hold the transaction that
    // publishes the earlier partition; the later partition must wait for the
    // agency-head authority and recompute after the earlier commit is visible.
    const pEarly = token("partition_early");
    const pLater = token("partition_later");
    const t3Ready = deferred(); const releaseT3 = deferred();
    const t3 = db1.$transaction(async (tx) => {
      await createWork(tx, { id: token("agency_early"), agencyId, workClass, partitionKey: pEarly, creatorId: "creator-b", due: early });
      t3Ready.resolve();
      await releaseT3.promise;
    }, { maxWait: 10_000, timeout: 30_000 });
    await t3Ready.promise;
    const t4 = db2.$transaction(async (tx) => {
      await createWork(tx, { id: token("agency_later"), agencyId, workClass, partitionKey: pLater, creatorId: "creator-c", due: later });
    }, { maxWait: 10_000, timeout: 30_000 });
    await mustStillWait(t4);
    releaseT3.resolve();
    await Promise.all([t3, t4]);

    const agencyHead = await db1.domainWorkReadyAgency.findUnique({ where: { agencyId_workClass: { agencyId, workClass } } });
    assert.equal(agencyHead?.nextDueAt?.getTime(), early.getTime());
  } finally {
    await db1.agency.delete({ where: { id: agencyId } }).catch(() => undefined);
    await Promise.allSettled([db1.$disconnect(), db2.$disconnect()]);
  }
});

test("F54-02 PostgreSQL: agency-first authority prevents partition-to-agency deadlock across multi-row work", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const agencyId = token("p2_actual54_lock_order_agency");
  const workClass = "CUSTOM_COMMUNICATION";
  const due = new Date(Date.now() - 30_000);
  const p1 = token("lock_p1");
  const p2 = token("lock_p2");
  const p1Work = token("lock_p1_work");
  const p2WorkA = token("lock_p2_work_a");
  const p2WorkB = token("lock_p2_work_b");
  const firstDone = deferred();
  const runSecond = deferred();
  const secondDone = deferred();
  const releaseT1 = deferred();

  try {
    await db1.agency.create({ data: { id: agencyId, name: agencyId } });
    await createWork(db1, { id: p1Work, agencyId, workClass, partitionKey: p1, creatorId: "creator-lock-1", due });
    await createWork(db1, { id: p2WorkA, agencyId, workClass, partitionKey: p2, creatorId: "creator-lock-2", due });
    await createWork(db1, { id: p2WorkB, agencyId, workClass, partitionKey: p2, creatorId: "creator-lock-3", due });

    const t1 = db1.$transaction(async (tx) => {
      await tx.domainWorkItem.update({ where: { id: p1Work }, data: { errorClass: "T1_FIRST" } });
      firstDone.resolve();
      await runSecond.promise;
      await tx.domainWorkItem.update({ where: { id: p2WorkA }, data: { errorClass: "T1_SECOND" } });
      secondDone.resolve();
      await releaseT1.promise;
    }, { maxWait: 10_000, timeout: 30_000 });
    await firstDone.promise;

    // With the old partition->agency order, T2 can hold P2 while waiting for the
    // agency lock owned by T1. T1 then blocks on P2 and creates a cycle. The
    // corrected trigger waits on agency scope *before* acquiring P2, so T1 can
    // safely touch P2 while T2 is waiting.
    const t2 = db2.$transaction(async (tx) => {
      await tx.domainWorkItem.update({ where: { id: p2WorkB }, data: { errorClass: "T2_FIRST" } });
    }, { maxWait: 10_000, timeout: 30_000 });
    await mustStillWait(t2);
    runSecond.resolve();

    const secondReached = await Promise.race([
      secondDone.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(secondReached, true, "T1 must be able to touch P2 while T2 waits at the earlier agency authority");
    await mustStillWait(t2);

    releaseT1.resolve();
    await Promise.all([t1, t2]);
  } finally {
    releaseT1.resolve();
    runSecond.resolve();
    await db1.agency.delete({ where: { id: agencyId } }).catch(() => undefined);
    await Promise.allSettled([db1.$disconnect(), db2.$disconnect()]);
  }
});


test("F54-02 PostgreSQL: mutation-scope BEFORE fence prevents family-state cross-class deadlock", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const agencyId = token("p2_actual54_family_order_agency");
  const classA = "CUSTOM_COMMUNICATION";
  const classB = "CUSTOM_REMINDER";
  const due = new Date(Date.now() - 30_000);
  const aWork = token("family_a_work");
  const bWork1 = token("family_b_work_1");
  const bWork2 = token("family_b_work_2");
  const firstDone = deferred();
  const runSecond = deferred();
  const secondDone = deferred();
  const releaseT1 = deferred();

  try {
    await db1.agency.create({ data: { id: agencyId, name: agencyId } });
    await createWork(db1, { id: aWork, agencyId, workClass: classA, partitionKey: "creator-a", creatorId: "creator-a", due });
    await createWork(db1, { id: bWork1, agencyId, workClass: classB, partitionKey: "creator-b1", creatorId: "creator-b1", due });
    await createWork(db1, { id: bWork2, agencyId, workClass: classB, partitionKey: "creator-b2", creatorId: "creator-b2", due });

    const t1 = db1.$transaction(async (tx) => {
      await tx.domainWorkItem.update({ where: { id: aWork }, data: { errorClass: "T1_CLASS_A" } });
      firstDone.resolve();
      await runSecond.promise;
      await tx.domainWorkItem.update({ where: { id: bWork1 }, data: { errorClass: "T1_CLASS_B" } });
      secondDone.resolve();
      await releaseT1.promise;
    }, { maxWait: 10_000, timeout: 30_000 });
    await firstDone.promise;

    const t2 = db2.$transaction(async (tx) => {
      await tx.domainWorkItem.update({ where: { id: bWork2 }, data: { errorClass: "T2_CLASS_B" } });
    }, { maxWait: 10_000, timeout: 30_000 });

    // The BEFORE mutation fence must stop T2 at agency scope before the
    // family-state AFTER trigger can lock classB. T1 can therefore cross from
    // classA to classB without forming familyB -> agency / agency -> familyB.
    await mustStillWait(t2);
    runSecond.resolve();
    const reached = await Promise.race([
      secondDone.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(reached, true, "T1 must reach classB while T2 is fenced before family-state side effects");
    await mustStillWait(t2);

    releaseT1.resolve();
    await Promise.all([t1, t2]);
  } finally {
    releaseT1.resolve();
    runSecond.resolve();
    await db1.agency.delete({ where: { id: agencyId } }).catch(() => undefined);
    await Promise.allSettled([db1.$disconnect(), db2.$disconnect()]);
  }
});
