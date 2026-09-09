"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test("Phase2 PostgreSQL lock topology: same-Agency shared work is parallel and exclusive lifecycle waits", { skip: !enabled }, async (t) => {
  const prisma = require("../prisma");
  const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
  let releaseFirst = null;
  let first = null;
  let secondShared = null;
  let rowWriter = null;
  let exclusive = null;
  try {
    const agency = await prisma.agency.findFirst({ where: { deletedAt: null }, select: { id: true } });
    if (!agency) {
      t.skip("No active Agency row exists in the PostgreSQL integration database");
      return;
    }

    const firstLocked = deferred();
    releaseFirst = deferred();
    first = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
      await lockAgencyLifecycleBarrier({ db: tx, agencyId: agency.id, mode: "shared" });
      firstLocked.resolve();
      await releaseFirst.promise;
    }, { timeout: 10_000 });

    await Promise.race([
      firstLocked.promise,
      first.then(
        () => { throw new Error("first shared transaction finished before publishing its lock"); },
        (err) => { throw err; },
      ),
      sleep(4_000).then(() => { throw new Error("timed out waiting for first shared Agency lifecycle lock"); }),
    ]);

    let secondSharedAcquired = false;
    secondShared = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
      await lockAgencyLifecycleBarrier({ db: tx, agencyId: agency.id, mode: "shared" });
      secondSharedAcquired = true;
    }, { timeout: 10_000 });

    await Promise.race([
      secondShared,
      sleep(2_000).then(() => { throw new Error("second shared Agency lifecycle holder was unexpectedly blocked"); }),
    ]);
    assert.equal(secondSharedAcquired, true, "shared Agency work should not wait for another shared holder");

    let rowWriterAcquired = false;
    rowWriter = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
      await tx.$queryRawUnsafe('SELECT "id" FROM "Agency" WHERE "id" = $1 FOR UPDATE', agency.id);
      rowWriterAcquired = true;
    }, { timeout: 10_000 });
    await Promise.race([
      rowWriter,
      sleep(2_000).then(() => { throw new Error("ordinary Agency-row writer was unexpectedly blocked by shared lifecycle work"); }),
    ]);
    rowWriter = null;
    assert.equal(rowWriterAcquired, true, "shared lifecycle must not hold an Agency row lock that blocks unrelated billing/business writers");

    let exclusiveAcquired = false;
    const exclusiveAttempting = deferred();
    exclusive = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
      exclusiveAttempting.resolve();
      await lockAgencyLifecycleBarrier({ db: tx, agencyId: agency.id, mode: "exclusive" });
      exclusiveAcquired = true;
    }, { timeout: 10_000 });

    await Promise.race([
      exclusiveAttempting.promise,
      exclusive.then(
        () => { throw new Error("exclusive transaction finished before attempting the lifecycle lock"); },
        (err) => { throw err; },
      ),
      sleep(2_000).then(() => { throw new Error("timed out waiting for exclusive Agency lifecycle attempt"); }),
    ]);
    await sleep(200);
    assert.equal(exclusiveAcquired, false, "exclusive Agency lifecycle must wait while shared work is in flight");

    releaseFirst.resolve();
    await first;
    first = null;
    await exclusive;
    exclusive = null;
    assert.equal(exclusiveAcquired, true, "exclusive Agency lifecycle must acquire after the shared holder releases");
  } finally {
    // Never leave a failed assertion holding the first transaction open until its
    // Prisma timeout. Release it first, then settle every started transaction
    // before disconnecting so the integration harness cannot hide a real failure.
    releaseFirst?.resolve();
    await Promise.allSettled([first, secondShared, rowWriter, exclusive].filter(Boolean));
    if (typeof prisma.$disconnect === "function") await prisma.$disconnect();
  }
});
