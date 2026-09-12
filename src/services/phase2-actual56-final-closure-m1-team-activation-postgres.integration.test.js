"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// This test mutates the global release state and therefore runs only under its
// dedicated opt-in. Run it in isolation against a disposable migrated database.
const enabled = process.env.ONLINOD_POSTGRES_ROLLING_INTEGRATION === "1";
const release = require("./phase2-release-compatibility-authority-service");
const { lockTeamControlPlaneTopology } = require("./team-control-plane-authority-service");
const { lockDbAdvisoryXact } = require("./db-transaction-service");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeState(db, state, snapshot = null) {
  return db.$transaction(async (tx) => {
    await lockDbAdvisoryXact({ db: tx, key: release.TEAM_CONTROL_PLANE_RELEASE_FENCE_KEY, mode: "exclusive" });
    if (snapshot) {
      await tx.$executeRawUnsafe(
        `UPDATE "Phase2ReleaseCompatibilityAuthority"
            SET "requiredGeneration"=$2,
                "activationState"=$3,
                "drainStartedAt"=$4,
                "activatedAt"=$5,
                "activationConfirmedAt"=$6,
                "updatedAt"=CURRENT_TIMESTAMP
          WHERE "scope"=$1`,
        release.TEAM_CONTROL_PLANE_SCOPE,
        snapshot.requiredGeneration,
        snapshot.activationState,
        snapshot.drainStartedAt || null,
        snapshot.activatedAt || null,
        snapshot.activationConfirmedAt || null,
      );
      return;
    }
    if (state === "DRAINING") {
      await tx.$executeRawUnsafe(
        `UPDATE "Phase2ReleaseCompatibilityAuthority"
            SET "requiredGeneration"=$2,
                "activationState"='DRAINING',
                "drainStartedAt"=CURRENT_TIMESTAMP,
                "activatedAt"=NULL,
                "activationConfirmedAt"=NULL,
                "updatedAt"=CURRENT_TIMESTAMP
          WHERE "scope"=$1`,
        release.TEAM_CONTROL_PLANE_SCOPE,
        release.TEAM_CONTROL_PLANE_GENERATION,
      );
    }
  });
}

test("M1 rolling PostgreSQL: DRAINING blocks the new C2 graph and activation serializes on the release fence", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const left = new PrismaClient();
  const right = new PrismaClient();
  const original = await release.readTeamControlPlaneReleaseAuthority(left);
  assert.ok(original, "TEAM_CONTROL_PLANE release authority must exist after migration");

  try {
    await writeState(left, "DRAINING");

    await assert.rejects(
      left.$transaction((tx) => lockTeamControlPlaneTopology({ tx, agencyId: `missing_${Date.now()}` })),
      (error) => error?.code === "TEAM_CONTROL_PLANE_DRAINING",
      "new binary must fail on release admission before it can reach Agency lifecycle locking",
    );

    const activated = await release.activateTeamControlPlaneAfterDrain(left, { confirmOldBinaryDrained: true });
    assert.equal(activated.activated || activated.alreadyActive, true);

    await assert.rejects(
      left.$transaction((tx) => lockTeamControlPlaneTopology({ tx, agencyId: `missing_${Date.now()}_active` })),
      (error) => error?.code === "AGENCY_NOT_FOUND",
      "after activation the request must cross release admission and reach the Agency lifecycle proof",
    );

    const sharedHeld = deferred();
    const releaseShared = deferred();
    let activationSettled = false;
    const holder = left.$transaction(async (tx) => {
      await release.assertTeamControlPlaneWriteAdmission(tx);
      sharedHeld.resolve();
      await releaseShared.promise;
    });
    await sharedHeld.promise;

    const activation = release.activateTeamControlPlaneAfterDrain(right, { confirmOldBinaryDrained: true })
      .finally(() => { activationSettled = true; });
    await delay(120);
    assert.equal(activationSettled, false, "exclusive activation fence must wait for an admitted shared transaction");

    releaseShared.resolve();
    await holder;
    const repeated = await activation;
    assert.equal(repeated.alreadyActive, true);
  } finally {
    try { await writeState(left, null, original); } catch (_) {}
    await Promise.allSettled([left.$disconnect(), right.$disconnect()]);
  }
});
