"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
function fixture(t, { slowEnumeration = false } = {}) {
  let clock = 0, initialized = false;
  t.mock.method(performance, "now", () => clock);
  const claims = [], acknowledgements = [], saved = new Map();
  const db = {
    async $queryRawUnsafe(sql) {
      if (sql.includes('FROM "MaintenanceLaneState"')) {
        if (slowEnumeration) clock += 2000;
        return [{ completedAt: new Date() }];
      }
      return [];
    },
    async $executeRawUnsafe() { return 0; },
    creatorAccount: { findFirst: async () => ({ id: "creator" }) },
    creatorAnalyticsFactPublication: { findFirst: async () => null },
    creatorAnalyticsPublicationState: { upsert: async () => { initialized = true; } },
  };
  const dependencies = {
    "./db-commit-kernel": { runRootCommit: async (client, callback) => callback({ tx: client }) },
    "./agency-lifecycle-barrier-service": { lockAgencyLifecycleBarrier: async () => ({ row: { id: "agency" } }) },
    "./analytics-projection-lifecycle-service": { pauseDeletedAgencyProjection: async () => false },
    "./domain-work-authority-service": {
      claimDomainWorkBatch: async ({ workClass }) => {
        claims.push(workClass); clock += 1000;
        return { ownerToken: "owner", items: [{ id: workClass, workClass, agencyId: "agency", creatorId: "creator", objectId: "creator", progressCursor: { table: 7 } }] };
      },
      lockDomainWorkClaimForCommit: async ({ item }) => ({ current: true, item }),
      ackDomainWorkClaim: async ({ item }) => { acknowledgements.push(item.workClass); return { lost: false }; },
      failDomainWorkClaim: async () => { throw Error("UNEXPECTED_PAGE_FAILURE"); },
    },
  };
  for (const [request, exports] of Object.entries(dependencies)) {
    const id = require.resolve(request); saved.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  const id = require.resolve("./analytics-fact-publication-service"); saved.set(id, require.cache[id]); delete require.cache[id];
  const service = require(id);
  t.after(() => { for (const [key, prior] of saved) { if (prior) require.cache[key] = prior; else delete require.cache[key]; } });
  return { db, service, claims, acknowledgements, initialized: () => initialized };
}
for (const slowEnumeration of [true, false]) test(`fact publication admits each work class before yielding when ${slowEnumeration ? "preparation" : "the first fact page"} exhausts the soft slice`, async t => {
  const f = fixture(t, { slowEnumeration });
  const result = await f.service.runSweep({ db: f.db, limit: 8, maxRuntimeMs: 500 });
  assert.equal(result.ok, true);
  assert.deepEqual(f.claims, [f.service.WORK_CLASS, f.service.ADOPTION_CLASS]);
  assert.deepEqual(f.acknowledgements, f.claims);
  assert.equal(f.initialized(), true, "constant live-fact work must not starve the adoption readiness proof");
  assert.equal(result.completed, 2);
});
