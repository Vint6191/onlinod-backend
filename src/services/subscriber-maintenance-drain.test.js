"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function load(dependencies) {
  const saved = new Map();
  for (const [request, exports] of Object.entries(dependencies)) {
    const id = require.resolve(request); saved.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  const id = require.resolve("./subscriber-directory-maintenance-service");
  saved.set(id, require.cache[id]); delete require.cache[id];
  const value = require(id);
  return { ...value, close() { for (const [key, prior] of saved) { if (prior) require.cache[key] = prior; else delete require.cache[key]; } } };
}
test("failed sibling claim drains already-owned subscriber publication before the lane returns", async () => {
  const entered = defer(), proceed = defer();
  let claims = 0, releases = 0;
  const source = load({
    "./subscriber-directory-service": {
      recoverSubscriberPublicationDebt: async () => { entered.resolve(); await proceed.promise; return { advancedSteps: 1 }; },
      hasSubscriberPublicationDebt: async () => true,
    },
    "./subscriber-directory-maintenance-signal-service": {
      SUBSCRIBER_MAINTENANCE_KIND: { RECOVERY: "RECOVERY", RETENTION: "RETENTION" },
      claimSubscriberDirectoryMaintenanceSignal: async () => {
        claims++;
        if (claims === 1) return { id: "owned", agencyId: "agency", creatorId: "creator", kind: "RECOVERY" };
        throw Object.assign(new Error("pool unavailable"), { code: "P2024" });
      },
      releaseSubscriberDirectoryMaintenanceSignal: async () => { releases++; },
      countPoisonedSubscriberMaintenanceSignals: async () => 0,
    },
  });
  let settled = false;
  const run = source.runSubscriberDirectoryMaintenance({ db: { $transaction() {}, $queryRawUnsafe() {} },
    maxSignals: 4, concurrency: 2 }).then(value => { settled = true; return value; }, error => { settled = true; return { thrown: error }; });
  try {
    await entered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "the pump must not admit another lane or finish shutdown while an owned publisher is still running");
    proceed.resolve();
    const result = await run;
    assert.equal(result.thrown, undefined);
    assert.equal(result.ok, false);
    assert.equal(result.errors, 1);
    assert.equal(result.errorDetails[0].code, "P2024");
    assert.equal(result.processedSignals, 1); assert.equal(result.advancedSteps, 1);
    assert.equal(releases, 1, "the healthy owner must release its continuation");
    assert.equal(claims, 2, "failed admission stops more claims in this tick");
  } finally { proceed.resolve(); await run; source.close(); }
});
