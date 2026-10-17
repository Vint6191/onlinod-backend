"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
function load(t, request, dependencies) {
  const saved = new Map();
  for (const [name, exports] of Object.entries(dependencies)) {
    const id = require.resolve(name); saved.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  const id = require.resolve(request); saved.set(id, require.cache[id]); delete require.cache[id];
  const service = require(id);
  t.after(() => { for (const [key, prior] of saved) { if (prior) require.cache[key] = prior; else delete require.cache[key]; } });
  return service;
}
const kernel = { runRootCommit: async (db, callback) => callback({ tx: db }) };
const lifecycle = { lockAgencyLifecycleBarrier: async () => ({ row: null }) };
const projectionLifecycle = { pauseDeletedAgencyProjection: async () => false };

test("Analytics publication executes one fenced unit after slow claim instead of yielding an untouched PUBLISHING job", async t => {
  let clock = 0, claims = 0, acknowledgements = 0;
  t.mock.method(performance, "now", () => clock);
  const publication = { id: "publication", jobId: "job", state: "PENDING", agencyId: "agency", creatorId: "creator", availableAt: new Date(0), updatedAt: new Date(), inputRevision: 1n };
  const job = { id: "job", status: "PUBLISHING" };
  const db = {
    analyticsPublication: { findUnique: async () => ({ ...publication }), update: async ({ data }) => Object.assign(publication, data) },
    jobInstance: { update: async ({ data }) => Object.assign(job, data) },
    $queryRawUnsafe: async sql => sql.includes('FROM "JobInstance"') ? [job] : [],
  };
  const service = load(t, "./analytics-publication-service", {
    "./db-commit-kernel": kernel,
    "./db-time-authority-service": { dbAuthorityNow: async () => new Date() },
    "./agency-lifecycle-barrier-service": lifecycle,
    "./domain-work-authority-service": {
      claimDomainWorkBatch: async input => { claims++; clock += 2000; return { ownerToken: "owner", items: [{ id: "work", objectId: publication.id }] }; },
      lockDomainWorkClaimForCommit: async () => ({ current: true }),
      ackDomainWorkClaim: async () => { acknowledgements++; }, yieldDomainWorkClaim: async () => {},
    },
  });
  const result = await service.runAnalyticsPublicationSweep({ db, limit: 8, maxRuntimeMs: 500 });
  assert.equal(result.ok, true); assert.equal(result.results[0].units, 1);
  assert.equal(publication.state, "CANCELLED", "the fenced unit must settle the retired scope, not leave permanent PUBLISHING");
  assert.equal(job.status, "CANCELLED"); assert.equal(claims, 1); assert.equal(acknowledgements, 1);
});

test("Campaign seeding latency does not suppress the next durably admitted work class", async t => {
  let clock = 0, claims = 0, admissions = 0;
  t.mock.method(Date, "now", () => clock);
  const db = { $queryRawUnsafe: async () => { clock += 2000; return [{ complete: true }]; } };
  const service = load(t, "./campaign-read-projection-service", {
    "./db-commit-kernel": kernel,
    "./campaign-projection-policy": { enterCampaignProjection: async () => ({}), admitProjectionWorkClass: async () => { admissions++; return "CAMPAIGN_FACT"; } },
    "./domain-work-authority-service": { claimDomainWorkBatch: async () => { claims++; return { items: [] }; } },
  });
  const result = await service.runCampaignProjectionSweep({ db, maxRuntimeMs: 500 });
  assert.equal(result.ok, true); assert.equal(admissions, 1); assert.equal(claims, 1);
});

test("Campaign executor drains its owned sibling when recording another item's failure also fails", async t => {
  let enterOwned, releaseOwned, failedDisposition;
  const owned = new Promise(resolve => { enterOwned = resolve; });
  const held = new Promise(resolve => { releaseOwned = resolve; });
  const failed = new Promise(resolve => { failedDisposition = resolve; });
  let admissions = 0, settled = false;
  const acknowledged = [];
  const service = load(t, "./campaign-read-projection-service", {
    "./db-commit-kernel": kernel,
    "./agency-lifecycle-barrier-service": lifecycle,
    "./campaign-projection-policy": { enterCampaignProjection: async () => ({}), admitProjectionWorkClass: async () => admissions++ ? null : "CAMPAIGN_FACT" },
    "./domain-work-authority-service": {
      claimDomainWorkBatch: async () => ({ ownerToken: "owner", items: ["held", "failed"].map(id => ({ id, agencyId: "agency", creatorId: id })) }),
      lockDomainWorkClaimForCommit: async ({ item }) => {
        if (item.id === "held") { enterOwned(); await held; return { current: true }; }
        throw Object.assign(Error("database request failed"), { code: "P2024" });
      },
      ackDomainWorkClaim: async ({ item }) => { acknowledged.push(item.id); return { lost: false }; },
      failDomainWorkClaim: async () => { failedDisposition(); throw Object.assign(Error("failure disposition unavailable"), { code: "P2024" }); },
    },
  });
  const running = service.runCampaignProjectionSweep({ db: { $queryRawUnsafe: async () => [] }, seed: false, concurrency: 2 });
  running.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.all([owned, failed]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "the lane cannot be reused or declared drained while its sibling still owns work");
  } finally { releaseOwned(); }
  const result = await running;
  assert.equal(result.ok, false); assert.equal(result.processed, 2);
  assert.equal(admissions, 1, "failure disposition stops new class admissions after draining current owners");
  assert.deepEqual(acknowledged, ["held"]);
  assert.equal(result.results.filter(row => row.error === "P2024").length, 1);
});

for (const failBatch of [false, true]) test(`Traffic ${failBatch ? "failed batch is isolated" : "slow claim runs a bounded unit"} before yielding the class`, async t => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const acknowledged = [], failed = [], yielded = [], claimed = [];
  const db = {
    $queryRawUnsafe: async sql => sql.includes('FROM "TrafficProjectionSeed"') ? [{ complete: true }] : sql.includes('FROM "CreatorAccount"') ? [{ id: "creator" }] : [],
    $executeRawUnsafe: async sql => { if (failBatch && sql.includes('onlinod_traffic_project_source_v2')) { clock += 2000; throw Object.assign(Error("bad canonical row"), { code: "23514" }); } return 0; },
  };
  const service = load(t, "./traffic-projection-service", {
    "./db-commit-kernel": kernel,
    "./agency-lifecycle-barrier-service": { lockAgencyLifecycleBarrier: async () => ({ row: { id: "agency" } }) },
    "./analytics-projection-lifecycle-service": projectionLifecycle,
    "./traffic-projection-authority": { authorizeTrafficExecutor: async () => {}, enterTrafficProjection: async () => {} },
    "./domain-work-authority-service": {
      claimDomainWorkBatch: async ({ workClass }) => {
        claimed.push(workClass); if (!failBatch) clock += 2000;
        const count = workClass === "TRAFFIC_FACT" ? (failBatch ? 2 : 1) : 0;
        return { ownerToken: "owner", items: Array.from({ length: count }, (_, i) => ({ id: "work-" + i, workClass, agencyId: "agency", creatorId: "creator", objectType: "CreatorCampaign", objectId: "campaign-" + i })) };
      },
      lockDomainWorkClaimForCommit: async () => ({ current: true }),
      ackDomainWorkClaim: async ({ item }) => { acknowledged.push(item.id); return { lost: false }; },
      yieldDomainWorkClaim: async ({ item }) => { yielded.push(item.id); return { lost: false }; },
      failDomainWorkClaim: async ({ item, error }) => { failed.push([item.id, error.code]); return { lost: false }; },
    },
  });
  const result = await service.runTrafficProjectionSweep({ db, maxRuntimeMs: 500 });
  assert.deepEqual(claimed, ["TRAFFIC_FACT", "TRAFFIC_FAN", "TRAFFIC_BACKFILL"]);
  if (failBatch) {
    assert.equal(result.ok, false); assert.deepEqual(failed, [["work-0", "23514"]]);
    assert.deepEqual(yielded, ["work-1"], "the remaining reservation is released; one failed page cannot become an eternal healthy yield");
  } else { assert.equal(result.ok, true); assert.deepEqual(acknowledged, ["work-0"]); }
  assert.equal(result.processed, 1);
});

test("slow receipt work cannot starve either retained notification consequence class", async t => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const classes = [], acknowledgements = [];
  const service = load(t, "./notification-consequence-service", {
    "./db-commit-kernel": kernel,
    "./agency-lifecycle-barrier-service": lifecycle,
    "./analytics-projection-lifecycle-service": projectionLifecycle,
    "./notification-fact-receipt-service": { processPage: async () => { clock += 2000; return { completed: true, processed: 1 }; } },
    "./domain-work-authority-service": {
      WORK_CLASS: { NOTIFICATION_CONSEQUENCES_V2: "V2", NOTIFICATION_CONSEQUENCES: "LEGACY" },
      claimDomainWorkBatch: async ({ workClass }) => { classes.push(workClass); return { ownerToken: "owner", items: [{ id: workClass, workClass, creatorId: "creator", objectType: "JobInstance", objectId: "retired" }] }; },
      lockDomainWorkClaimForCommit: async ({ item }) => ({ current: true, item }),
      ackDomainWorkClaim: async ({ item }) => { acknowledgements.push(item.workClass); return { lost: false }; },
      failDomainWorkClaim: async () => { throw Error("UNEXPECTED_PAGE_FAILURE"); },
    },
  });
  const result = await service.runNotificationConsequenceSweep({ db: { jobInstance: { findUnique: async () => null } }, maxRuntimeMs: 500 });
  assert.equal(result.ok, true); assert.deepEqual(classes, ["NOTIFICATION_FACT_RECEIPTS", "V2", "LEGACY"]);
  assert.deepEqual(acknowledgements, ["V2", "LEGACY"]); assert.equal(result.completed, 3);
});
