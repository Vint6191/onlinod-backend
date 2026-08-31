"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./team-ppv-ledger-service");

function loadService() {
  const seen = { conflictWhere: null };
  const prisma = {
    teamPpvResolveJob: {
      async updateMany() { return { count: 0 }; },
      async findMany(args) { seen.conflictWhere = args.where; return []; },
    },
    teamPpvPurchaseLedger: { async findMany() { return []; } },
    teamPpvClaimAudit: { async findMany() { return []; } },
    agencyMember: { async findMany() { return []; } },
  };
  delete require.cache[servicePath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  return { service: require(servicePath), seen };
}

test("PPV Claims conflict list keeps fail-closed creator scope after client resolver retirement", async () => {
  const { service, seen } = loadService();
  assert.equal(typeof service.listResolveJobs, "undefined");
  assert.equal(typeof service.submitResolveResults, "undefined");
  await service.listPpvConflicts({ agencyId: "agency-1", allowedCreatorIds: [] });
  assert.deepEqual(seen.conflictWhere.creatorId, { in: ["__none__"] });
});
