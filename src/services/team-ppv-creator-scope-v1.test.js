"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./team-ppv-ledger-service");

function loadService() {
  const seen = { jobWhere: null, conflictWhere: null };
  const prisma = {
    teamPpvResolveJob: {
      async updateMany() { return { count: 0 }; },
      async findMany(args) {
        if (args.where?.status === "pending") seen.jobWhere = args.where;
        else seen.conflictWhere = args.where;
        return [];
      },
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

test("PPV resolve jobs and conflict list use the same fail-closed creator scope", async () => {
  const { service, seen } = loadService();
  await service.listResolveJobs({ agencyId: "agency-1", allowedCreatorIds: ["creator-1"] });
  await service.listPpvConflicts({ agencyId: "agency-1", allowedCreatorIds: [] });
  assert.deepEqual(seen.jobWhere.creatorId, { in: ["creator-1"] });
  assert.deepEqual(seen.conflictWhere.creatorId, { in: ["__none__"] });
});
