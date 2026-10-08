"use strict";
// Deterministic application interleavings. This advisory-lock model is not
// evidence of native PostgreSQL scheduling or independent SQL connections.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const crypto = require("node:crypto");
const authority = require("./sfs-mutation-authority-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const scope = { agencyId: "agency-136", creatorId: "creator-136" };

test("500-creator retention fence is bounded to two ordered SQL calls with canonical keys", async () => {
  const { lockAutomationWriteCommitFences } = require("./automation-write-commit-fence-service");
  const calls = [], db = { $executeRawUnsafe: async (...args) => { calls.push(args); return 1; } };
  const scopes = Array.from({ length: 500 }, (_, i) => ({ agencyId: "agency-" + (i % 3), creatorId: "creator-" + String(499-i).padStart(3,"0") }));
  await lockAutomationWriteCommitFences({ db, scopes });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0][2]).map(row => row.key), ["agency-0", "agency-1", "agency-2"]);
  const keys = JSON.parse(calls[1][2]); assert.equal(keys.length, 500);
  assert.deepEqual(keys.map(row => JSON.parse(row.key)[1]), scopes.map(row => row.creatorId).sort());
  for (let i=0;i<keys.length;i++) assert.equal(keys[i].ordinal,i);
  assert.match(calls[0][0], /pg_advisory_xact_lock_shared/); assert.match(calls[1][0], /ORDER BY s.ordinal/);
  await assert.rejects(lockAutomationWriteCommitFences({ db, scopes: [...scopes,scopes[0]] }), { code: "AUTOMATION_COMMIT_FENCE_BATCH_INVALID" });
  assert.equal(calls.length, 2);
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function lockModel() {
  const holders = new Map(), queue = [], blocked = deferred(); let sequence = 0;
  const conflicts = (id, key, shared) => [...(holders.get(key) || new Map())].some(([owner, mode]) => owner !== id && (!shared || !mode));
  function take(id, key, shared) {
    const map = holders.get(key) || new Map();
    map.set(id, map.has(id) ? map.get(id) && shared : shared); holders.set(key, map);
  }
  function release(id) {
    for (const map of holders.values()) map.delete(id);
    for (let i = 0; i < queue.length;) {
      const q = queue[i];
      if (conflicts(q.id, q.key, q.shared)) { i++; continue; }
      queue.splice(i, 1); take(q.id, q.key, q.shared); q.resolve(1);
    }
  }
  function transaction(id = "tx-" + (++sequence), overrides = {}) {
    return { id,
      async $executeRawUnsafe(sql, ...args) {
        if (!sql.includes("pg_advisory_xact_lock")) return 1;
        const key = JSON.stringify(args), shared = sql.includes("_shared(");
        if (!conflicts(id, key, shared)) { take(id, key, shared); return 1; }
        return new Promise(resolve => { queue.push({ id, key, shared, resolve }); blocked.resolve(id); });
      },
      async $queryRawUnsafe(sql, id, agencyId) {
        if (sql.includes('FROM "Agency"')) return [{ id, deletedAt: null, status: "ACTIVE" }];
        if (sql.includes('FROM "CreatorAccount"')) return [{ id, agencyId, deletedAt: null }];
        if (sql.includes('FROM "SfsTargetCandidate"')) return [];
        throw Error("Unexpected fixture SQL: " + sql);
      }, ...overrides,
    };
  }
  return { transaction, release, blocked: blocked.promise,
    root(overrides = {}) { return { async $transaction(work) {
      const tx = transaction(undefined, overrides);
      try { return await work(tx); } finally { release(tx.id); }
    } }; },
  };
}
function load(file, overrides = {}, expose = "") {
  const filename = path.join(__dirname, file), nativeRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + expose, {
    module, exports: module.exports, require: id => Object.hasOwn(overrides, id) ? overrides[id] : nativeRequire(id),
    __dirname, __filename: filename, process, console, Buffer, Date, setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename });
  return module.exports;
}

test("SFS authority rejects root clients and missing scope; unrelated modules do no locking", async () => {
  await assert.rejects(authority.lockSfsScope({ $queryRawUnsafe() {}, $transaction() {} }, scope), { code: "SFS_MUTATION_TRANSACTION_REQUIRED" });
  await assert.rejects(authority.lockSfsScope(lockModel().transaction(), { agencyId: scope.agencyId }), { code: "SFS_MUTATION_SCOPE_REQUIRED" });
  await authority.lockSfsDeliveryMutation(null, { moduleKey: "likes" });
  await authority.lockSfsJobMutation(null, { jobKey: "fan_data_point_refresh" });
});

test("SFS same-creator mutations wait while distinct creators remain concurrent", { timeout: 3000 }, async () => {
  const m = lockModel(), first = m.transaction("first"), same = m.transaction("same"), other = m.transaction("other");
  await authority.lockSfsScope(first, scope);
  let entered = false;
  const waiting = authority.lockSfsScope(same, scope).then(() => { entered = true; });
  await m.blocked;
  await authority.lockSfsScope(other, { ...scope, creatorId: "another-creator" });
  assert.equal(entered, false);
  m.release(first.id); await waiting; assert.equal(entered, true);
  m.release(same.id); m.release(other.id);
});

test("workspace control waits for admitted SFS; new SFS waits for workspace control", { timeout: 3000 }, async () => {
  const m = lockModel(), active = m.transaction("active"), control = m.transaction("control"), later = m.transaction("later");
  await authority.lockSfsScope(active, scope);
  let controlEntered = false;
  const stopping = lockAutomationWriteCommitFence({ db: control, agencyId: scope.agencyId }).then(() => { controlEntered = true; });
  await m.blocked; assert.equal(controlEntered, false);
  m.release(active.id); await stopping;
  let laterEntered = false;
  const newWork = authority.lockSfsScope(later, scope).then(() => { laterEntered = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(laterEntered, false);
  m.release(control.id); await newWork; m.release(later.id);
});

for (const method of ["planSfsTargets", "scheduleSfsDiscovery"]) {
  test(`SFS ${method} reads control after admission and creates nothing after disable`, { timeout: 3000 }, async () => {
    const m = lockModel(), control = m.transaction("control"); let enabled = true, reads = 0, writes = 0;
    await lockAutomationWriteCommitFence({ db: control, agencyId: scope.agencyId, creatorId: scope.creatorId });
    const db = m.root({ automationDelivery: { count: async () => { writes++; return 0; } } });
    const service = load("sfs-service.js", { "../prisma": db,
      "./automation-control-service": {
        requireCreator: async () => ({ id: scope.creatorId }),
        assertAutomationEnabled: async () => { reads++; if (!enabled) throw Object.assign(Error("disabled"), { code: "module_disabled" }); },
      },
      "./job-planning-repository": { ensurePlannedJob: async () => { writes++; throw Error("must not schedule"); } },
    });
    const pending = service[method]({ ...scope, db });
    await m.blocked; assert.equal(reads, 0); enabled = false; m.release(control.id);
    await assert.rejects(pending, { code: "module_disabled" });
    assert.equal(reads, 1); assert.equal(writes, 0);
  });
}

test("SFS validation does not apply a stale denial after waiting for admission", { timeout: 3000 }, async () => {
  const m = lockModel(), holder = m.transaction("holder"); await authority.lockSfsScope(holder, scope);
  let currentValid = false, updates = 0, validations = 0;
  const delivery = { ...scope, id: "delivery-136", moduleKey: "sfs", originKind: "AUTOMATION", actionType: "SFS_COMMENT_POST", payload: { candidateId: "candidate-136" }, status: "QUEUED", leaseRevision: 1, generation: 1 };
  const db = m.root({ automationDelivery: {
    findUnique: async () => ({ ...delivery }), updateMany: async () => { updates++; return { count: 1 }; },
  } });
  const service = load("automation-action-delivery-service.js", { "../prisma": db,
    "./automation-control-service": { getAutomationControlSnapshot: async () => ({ effective: { sfsEnabled: true } }) },
    "./sfs-service": { validateSfsDelivery: async () => { validations++; return { ok: currentValid, terminal: true, code: "blocked" }; } },
  }, "\nmodule.exports.transition = applySfsValidationTransition;");
  const pending = service.transition(delivery, { ok: false, terminal: true, code: "blocked" });
  await m.blocked; currentValid = true; m.release(holder.id);
  assert.equal(await pending, false); assert.equal(validations, 1); assert.equal(updates, 0);
});

test("SFS lease admission rereads a lease revoked while it waited", { timeout: 3000 }, async () => {
  const m = lockModel(), holder = m.transaction("holder"), caller = m.transaction("caller");
  await authority.lockSfsScope(holder, scope);
  const token = "lease-136"; let accessChecks = 0;
  const row = { ...scope, id: "delivery", originKind: "AUTOMATION", moduleKey: "sfs", actionType: "SFS_COMMENT_POST", payload: { candidateId: "candidate" },
    status: "CLAIMED", claimedByDeviceId: "device", leaseTokenHash: crypto.createHash("sha256").update(token).digest("hex"), leaseRevision: 1, claimUntil: new Date(Date.now()+60000) };
  Object.assign(caller, { workerDevice: { findUnique: async () => ({ id: "device", userId: "user", agencyId: scope.agencyId }) },
    agencyMember: { findFirst: async () => ({ id: "member" }) }, automationDelivery: { findUnique: async () => ({ ...row }) } });
  const service = load("automation-action-delivery-service.js", {
    "./team-access-control": { canUsePermission: async () => true },
    "./execution-access-fence-service": { assertExecutionAccessFence: async () => { accessChecks++; }, ExecutionAccessFenceError: class extends Error {} },
  }, "\nmodule.exports.lease = requireLease;");
  const pending = service.lease({ db: caller, deliveryId: row.id, userId: "user", deviceId: "device", leaseToken: token, leaseRevision: 1, lockAccess: true });
  await m.blocked; row.status = "PAUSED"; row.leaseRevision = 2; m.release(holder.id);
  await assert.rejects(pending, { code: "DELIVERY_NOT_CLAIMED" }); assert.equal(accessChecks, 0); m.release(caller.id);
});

for (const jobKey of ["sfs_target_discovery", "sfs_target_scan"]) {
  test(`SFS ${jobKey} shares delivery mutation authority`, { timeout: 3000 }, async () => {
    const m = lockModel(), delivery = m.transaction("delivery"), job = m.transaction("job");
    await authority.lockSfsDeliveryMutation(delivery, { ...scope, moduleKey: "sfs", payload: {} });
    let entered = false;
    const pending = authority.lockSfsJobMutation(job, { ...scope, jobKey }).then(() => { entered = true; });
    await m.blocked; assert.equal(entered, false); m.release(delivery.id); await pending; m.release(job.id);
  });
}
