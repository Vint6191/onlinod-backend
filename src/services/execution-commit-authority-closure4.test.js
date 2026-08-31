"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");

function driverContractFake() {
  const calls = { query: [], execute: [] };
  return {
    calls,
    db: {
      async $queryRawUnsafe(sql, ...args) {
        calls.query.push({ sql: String(sql), args });
        throw new Error("Failed to deserialize column of type 'void'");
      },
      async $executeRawUnsafe(sql, ...args) {
        calls.execute.push({ sql: String(sql), args });
        return 1;
      },
    },
  };
}

test("Closure4 transaction advisory lock treats pg_advisory_xact_lock as a command, never a query result", async () => {
  const fx = driverContractFake();
  const result = await lockDbAdvisoryXact({ db: fx.db, key: "sfs_discovery:a1:c1:target" });
  assert.deepEqual(result, { key: "sfs_discovery:a1:c1:target" });
  assert.equal(fx.calls.query.length, 0);
  assert.equal(fx.calls.execute.length, 1);
  assert.equal(fx.calls.execute[0].sql, "SELECT pg_advisory_xact_lock(hashtext($1))");
  assert.deepEqual(fx.calls.execute[0].args, ["sfs_discovery:a1:c1:target"]);
});

test("Closure4 automation write commit fence preserves the existing two-key advisory lock identity via executeRaw", async () => {
  const fx = driverContractFake();
  await lockAutomationWriteCommitFence({ db: fx.db, agencyId: "agency-1" });
  assert.equal(fx.calls.query.length, 0);
  assert.equal(fx.calls.execute.length, 1);
  assert.equal(fx.calls.execute[0].sql, "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))");
  assert.deepEqual(fx.calls.execute[0].args, ["onlinod:automation-write-commit:v1", "agency-1"]);
});

function productionJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

test("Closure4 production has zero queryRaw transaction advisory locks and one shared single-key lock authority", () => {
  const srcDir = path.resolve(__dirname, "..");
  const offenders = [];
  const lockSources = [];
  for (const file of productionJsFiles(srcDir)) {
    const source = fs.readFileSync(file, "utf8");
    if (/\$queryRawUnsafe\s*\([\s\S]{0,180}?pg_advisory_xact_lock/.test(source)) offenders.push(path.relative(srcDir, file));
    if (/pg_advisory_xact_lock/.test(source)) lockSources.push(path.relative(srcDir, file));
  }
  assert.deepEqual(offenders, []);
  assert.deepEqual(lockSources.sort(), [
    "services/automation-write-commit-fence-service.js",
    "services/creator-analytics-ledger-service.js",
    "services/db-transaction-service.js",
    "services/notification-facts-service.js",
  ]);

  const followBack = fs.readFileSync(path.resolve(__dirname, "follow-back-service.js"), "utf8");
  const follow = fs.readFileSync(path.resolve(__dirname, "follow-automation-service.js"), "utf8");
  const dialogHistory = fs.readFileSync(path.resolve(__dirname, "dialog-history-batch-service.js"), "utf8");
  const mediaLibrary = fs.readFileSync(path.resolve(__dirname, "media-library-service.js"), "utf8");
  for (const source of [followBack, follow]) {
    assert.match(source, /withDbAdvisoryXactLock/);
    assert.doesNotMatch(source, /pg_advisory_xact_lock/);
  }
  for (const source of [dialogHistory, mediaLibrary]) {
    assert.match(source, /lockDbAdvisoryXact/);
    assert.doesNotMatch(source, /pg_advisory_xact_lock/);
  }
});

test("Closure4 recurring automatic modules route lock semantics through shared authorities", () => {
  const scheduler = fs.readFileSync(path.resolve(__dirname, "job-scheduler.js"), "utf8");
  for (const name of ["ensureAutomaticFollowBack", "ensureAutomaticBumps", "ensureAutomaticLikes", "ensureAutomaticFollowAutomation", "ensureAutomaticSfs"]) {
    assert.match(scheduler, new RegExp(`\\b${name}\\b`));
  }

  const expected = new Map([
    ["follow-back-service.js", /withDbAdvisoryXactLock/],
    ["follow-automation-service.js", /withDbAdvisoryXactLock/],
    ["bump-service.js", /runWithAutomationWriteCommitFence/],
    ["likes-service.js", /runWithAutomationWriteCommitFence/],
    ["sfs-service.js", /runWithAutomationWriteCommitFence/],
  ]);
  for (const [file, authority] of expected) {
    const source = fs.readFileSync(path.resolve(__dirname, file), "utf8");
    assert.match(source, authority, file);
    assert.doesNotMatch(source, /\$queryRawUnsafe\s*\([\s\S]{0,180}?pg_advisory_xact_lock/, file);
  }
});

function cacheModule(request, exports) {
  const id = require.resolve(request);
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return () => {
    delete require.cache[id];
    if (previous) require.cache[id] = previous;
  };
}

function fresh(request) {
  const id = require.resolve(request);
  delete require.cache[id];
  return require(request);
}

test("Closure4 real FollowBack and Follow Automation planning paths survive a queryRaw void-deserialization driver", async () => {
  const fx = driverContractFake();
  const db = {
    ...fx.db,
    subscriberDirectoryState: { findFirst: async () => ({ currentRunId: "snapshot-1" }) },
    automationDelivery: { count: async () => 0 },
    deviceCreatorBinding: { count: async () => 0 },
    followBackCandidate: { findMany: async () => [] },
    followAutomationCandidate: { count: async () => 0, findMany: async () => [] },
  };
  const restores = [];
  try {
    restores.push(cacheModule("../prisma", {}));
    restores.push(cacheModule("./automation-control-service", {
      FOLLOW_BACK_MODULE_KEY: "follow_back",
      requireCreator: async () => ({ id: "creator-1" }),
      assertAutomationEnabled: async ({ moduleKey }) => ({
        workspace: { settings: {} },
        modules: {
          follow_back: { settings: { dailyLimit: 10, maxAttempts: 3 } },
          follow: { settings: { refollowEnabled: true, dailyLimit: 10, maxAttempts: 3 } },
          [moduleKey]: { settings: moduleKey === "follow_back" ? { dailyLimit: 10, maxAttempts: 3 } : { refollowEnabled: true, dailyLimit: 10, maxAttempts: 3 } },
        },
      }),
      getAutomationControlSnapshot: async () => ({ effective: {}, modules: { follow_back: { settings: {} }, follow: { settings: {} } }, workspace: { settings: {} } }),
      normalizeFollowBackSettings: (value) => ({ dailyLimit: 10, maxAttempts: 3, activeSubscribers: true, freeSubscribers: true, paidSubscribers: true, expiredSubscribers: true, ...value }),
      normalizeFollowAutomationSettings: (value) => ({ refollowEnabled: true, dailyLimit: 10, maxAttempts: 3, ...value }),
    }));
    restores.push(cacheModule("./automation-pacing-service", { nextAutomationWriteSlot: async () => new Date() }));
    restores.push(cacheModule("./automation-action-delivery-service", { listActionDeliveries: async () => ({ items: [] }), retryActionDelivery: async () => ({}) }));
    restores.push(cacheModule("./fan-data-authority-service", { readFanCurrent: async () => [] }));

    const followBackId = require.resolve("./follow-back-service");
    const followAutomationId = require.resolve("./follow-automation-service");
    const followBack = fresh("./follow-back-service");
    const followAutomation = fresh("./follow-automation-service");

    const back = await followBack.planFollowBack({ db, agencyId: "agency-1", creatorId: "creator-1", userId: null });
    const auto = await followAutomation.planFollowAutomation({ db, agencyId: "agency-1", creatorId: "creator-1", userId: null });
    assert.equal(back.summary.created, 0);
    assert.equal(auto.summary.created, 0);
    assert.equal(fx.calls.query.length, 0);
    assert.equal(fx.calls.execute.length, 2);
    assert.deepEqual(fx.calls.execute.map((call) => call.args[0]), [
      "follow_back_plan:agency-1:creator-1",
      "follow_automation_plan:agency-1:creator-1",
    ]);

    delete require.cache[followBackId];
    delete require.cache[followAutomationId];
  } finally {
    for (const restore of restores.reverse()) restore();
  }
});

test("Closure4 prepareWriteActionDelivery reaches COMMITTING through executeRaw commit fence", async () => {
  const crypto = require("node:crypto");
  const fx = driverContractFake();
  const leaseToken = "closure4-token";
  const delivery = {
    id: "delivery-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    moduleKey: "other",
    actionType: "SEND_MESSAGE",
    targetId: "fan-1",
    fanId: "fan-1",
    status: "RUNNING",
    leaseRevision: 3,
    claimUntil: new Date(Date.now() + 60_000),
    claimedByDeviceId: "device-1",
    leaseTokenHash: crypto.createHash("sha256").update(leaseToken).digest("hex"),
    leaseMemberId: "member-1",
    leaseAccessEpoch: 9,
    writeCommitRevision: 0,
    writeCommitAt: null,
    result: {},
  };
  const db = {
    ...fx.db,
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1", agencyId: "agency-1", userId: "user-1", accessEpoch: 9, role: "OWNER", assignedCreators: "all" }) },
    automationDelivery: {
      findUnique: async ({ where }) => where.id === delivery.id ? delivery : null,
      updateMany: async ({ where, data }) => {
        if (where.id !== delivery.id || where.status !== delivery.status || delivery.status !== "RUNNING") return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && Object.hasOwn(value, "increment")) delivery[key] = Number(delivery[key] || 0) + Number(value.increment || 0);
          else delivery[key] = value;
        }
        return { count: 1 };
      },
    },
    async $transaction(work) { return work(db); },
  };

  const restores = [];
  const actionId = require.resolve("./automation-action-delivery-service");
  try {
    restores.push(cacheModule("../prisma", db));
    restores.push(cacheModule("./team-access-control", {
      canUsePermission: async () => true,
      isOwner: () => true,
      normalizeAssignedCreators: () => ({ mode: "all", creatorIds: [] }),
    }));
    class TestExecutionAccessFenceError extends Error {}
    restores.push(cacheModule("./execution-access-fence-service", {
      ExecutionAccessFenceError: TestExecutionAccessFenceError,
      assertExecutionAccessFence: async () => ({ ok: true }),
    }));
    const control = { effective: { workspaceEnabled: true, creatorEnabled: true }, workspace: { settings: {} }, modules: {} };
    restores.push(cacheModule("./automation-control-service", {
      assertAutomationEnabled: async () => control,
      getAutomationControlSnapshot: async () => control,
    }));
    restores.push(cacheModule("./automation-pacing-service", { claimPacingRetryAt: async () => null }));
    restores.push(cacheModule("./bump-service", {
      validateBumpDelivery: async () => ({ ok: true }), finalizeBumpSend: async () => null, finalizeBumpDelete: async () => null,
      finalizeBumpFailure: async () => null, finalizeBumpTerminal: async () => null, prepareBumpRetry: async () => null,
    }));
    restores.push(cacheModule("./likes-service", {
      validateLikeDelivery: async () => ({ ok: true }), finalizeLikeSuccess: async () => null, finalizeLikeFailure: async () => null,
      finalizeLikeTerminal: async () => null, prepareLikeRetry: async () => null,
    }));
    restores.push(cacheModule("./follow-automation-service", {
      validateFollowAutomationDelivery: async () => ({ ok: true }), finalizeFollowAutomationSuccess: async () => null,
      finalizeFollowAutomationFailure: async () => null, finalizeFollowAutomationTerminal: async () => null, prepareFollowAutomationRetry: async () => null,
    }));
    restores.push(cacheModule("./sfs-service", {
      validateSfsDelivery: async () => ({ ok: true }), finalizeSfsSuccess: async () => null, finalizeSfsFailure: async () => null,
      finalizeSfsTerminal: async () => null, prepareSfsRetry: async () => null,
    }));

    delete require.cache[actionId];
    const action = require("./automation-action-delivery-service");
    const result = await action.prepareWriteActionDelivery({
      deliveryId: delivery.id,
      userId: "user-1",
      deviceId: "device-1",
      leaseToken,
      leaseRevision: 3,
    });
    assert.equal(result.status, "COMMITTING");
    assert.equal(delivery.status, "COMMITTING");
    assert.equal(delivery.writeCommitRevision, 1);
    assert.equal(fx.calls.query.length, 0);
    assert.equal(fx.calls.execute.length, 1);
    assert.deepEqual(fx.calls.execute[0].args, ["onlinod:automation-write-commit:v1", "agency-1"]);
  } finally {
    delete require.cache[actionId];
    for (const restore of restores.reverse()) restore();
  }
});
