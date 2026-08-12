"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./team-tip-ledger-service");

function loadService() {
  const seen = [];
  const prisma = {
    teamTipLedger: {
      async findMany(args) { seen.push(args.where); return []; },
    },
    agencyMember: { async findMany() { return []; } },
  };
  delete require.cache[servicePath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  return { service: require(servicePath), seen };
}

test("tip Claims list/audit use exact assigned creator scope and empty scope means none", async () => {
  const { service, seen } = loadService();
  await service.listTipClaims({ agencyId: "agency-1", senior: true, allowedCreatorIds: ["creator-1"] });
  await service.listTipAudit({ agencyId: "agency-1", senior: true, allowedCreatorIds: [] });
  assert.deepEqual(seen[0].creatorId, { in: ["creator-1"] });
  assert.deepEqual(seen[1].creatorId, { in: ["__none__"] });
});
