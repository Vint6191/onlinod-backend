"use strict";

const release = require("../../src/services/phase2-release-compatibility-authority-service");

async function authorizeFixtureTransaction(tx, { team = false, creator = false, domainExecutor = false } = {}) {
  if (team) await release.assertTeamControlPlaneWriteAdmission(tx);
  if (creator) await release.authorizeCreatorAccountWrite(tx);
  if (domainExecutor) await release.authorizeDomainWorkExecutor(tx);
  return tx;
}

async function withFixtureAuthorities(db, authorities, work, options = undefined) {
  if (!db || typeof db.$transaction !== "function") {
    throw Object.assign(new Error("PostgreSQL integration fixture requires Prisma transaction support"), { code: "PHASE2_PG_FIXTURE_TRANSACTION_REQUIRED" });
  }
  if (typeof work !== "function") throw new TypeError("PostgreSQL integration fixture work callback is required");
  return db.$transaction(async (tx) => {
    await authorizeFixtureTransaction(tx, authorities);
    return work(tx);
  }, options);
}

async function cleanupAgencyFixture(db, { agencyId, userIds = [] } = {}) {
  if (!agencyId) return;
  return withFixtureAuthorities(db, { team: true }, async (tx) => {
    await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, agencyId);
    await tx.agency.delete({ where: { id: agencyId } });
    if (userIds.length) await tx.user.deleteMany({ where: { id: { in: userIds } } });
  });
}

module.exports = { authorizeFixtureTransaction, withFixtureAuthorities, cleanupAgencyFixture };
