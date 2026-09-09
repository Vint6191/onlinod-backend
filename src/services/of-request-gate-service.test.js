"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function loadService(fixture) {
  const prismaModule = require.resolve("../prisma");
  require.cache[prismaModule] = {
    id: prismaModule,
    filename: prismaModule,
    loaded: true,
    exports: fixture.db,
  };
  delete require.cache[require.resolve("./of-request-gate-service")];
  return require("./of-request-gate-service");
}

function databaseFixture(accessCalls) {
  return {
    workerDevice: {
      findFirst: async ({ where }) => {
        accessCalls.device += 1;
        return { id: where.id, userId: where.userId, agencyId: "agency-1", lastSeenAt: new Date() };
      },
    },
    creatorAccount: {
      findFirst: async () => { accessCalls.creator += 1; return { id: "creator-1", status: "READY" }; },
    },
    deviceCreatorBinding: {
      findFirst: async () => { accessCalls.binding += 1; return { id: "binding-1" }; },
    },
    $queryRawUnsafe: async () => [{ authorityNow: new Date() }],
  };
}

async function started(service, deviceId, permitId, capability = "read") {
  return service.acknowledgeOfRequestStarted({
    userId: "user-1",
    agencyId: "agency-1",
    member: { role: "OWNER", assignedCreators: "all" },
    deviceId,
    creatorId: "creator-1",
    permitId,
    capability,
  });
}

test("global OF gate prioritizes writes and spaces actual starts by 700ms without per-request DB writes", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const service = loadService({ db: databaseFixture(accessCalls) });
  service._test.reset();

  const backgroundPromise = service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-background", creatorId: "creator-1",
    priority: "background", operation: "dialog.scan", capability: "read", timeoutMs: 5_000,
  });
  const writePromise = service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-write", creatorId: "creator-1",
    priority: "critical_write", operation: "bump.send", capability: "write", timeoutMs: 5_000,
  });

  const writePermit = await writePromise;
  let backgroundResolved = false;
  void backgroundPromise.then(() => { backgroundResolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(backgroundResolved, false, "next permit must wait until previous transport-start acknowledgement");

  const firstStart = await started(service, "device-write", writePermit.permitId, "write");
  const backgroundPermit = await backgroundPromise;
  const secondStart = await started(service, "device-background", backgroundPermit.permitId);

  const spacing = new Date(secondStart.startedAt).getTime() - new Date(firstStart.startedAt).getTime();
  assert.ok(spacing >= 700, `expected >=700ms between acknowledged starts, got ${spacing}`);
  assert.equal(writePermit.intervalMs, 700);
  assert.equal(backgroundPermit.intervalMs, 700);
  assert.equal(service.getOfRequestGateSnapshot().coordinator, "single_backend_process_memory_two_phase");
});

test("gate rechecks member creator access while caching only device capability validation", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const service = loadService({ db: databaseFixture(accessCalls) });
  service._test.reset();

  const permitOne = await service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-1", creatorId: "creator-1",
    priority: "normal", operation: "one", capability: "read", timeoutMs: 5_000,
  });
  await started(service, "device-1", permitOne.permitId);

  const permitTwo = await service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-1", creatorId: "creator-1",
    priority: "normal", operation: "two", capability: "read", timeoutMs: 5_000,
  });
  await service.cancelOfRequestPermit({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-1", creatorId: "creator-1", permitId: permitTwo.permitId, capability: "read",
  });

  assert.deepEqual(accessCalls, { device: 1, creator: 4, binding: 1 });
});

test("gate rejects an in-agency creator that the current member is not assigned", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const service = loadService({ db: databaseFixture(accessCalls) });
  service._test.reset();

  await assert.rejects(
    () => service.acquireOfRequestSlot({
      userId: "user-1",
      agencyId: "agency-1",
      member: { role: "WORKER", assignedCreators: { ids: ["creator-other"] } },
      deviceId: "device-1",
      creatorId: "creator-1",
      priority: "normal",
      operation: "forbidden",
      capability: "read",
      timeoutMs: 5_000,
    }),
    (error) => error?.code === "CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );
  assert.deepEqual(accessCalls, { device: 0, creator: 1, binding: 0 });
});


test("read capability cache cannot authorize a later write capability", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const db = databaseFixture(accessCalls);
  db.deviceCreatorBinding.findFirst = async ({ where }) => {
    accessCalls.binding += 1;
    if (where.sessionWriteReady === true) return null;
    return { id: "binding-read" };
  };
  const service = loadService({ db });
  service._test.reset();
  const readPermit = await service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-1", creatorId: "creator-1", priority: "normal", operation: "read", capability: "read", timeoutMs: 5_000,
  });
  await started(service, "device-1", readPermit.permitId, "read");
  await assert.rejects(() => service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-1", creatorId: "creator-1", priority: "critical_write", operation: "write", capability: "write", timeoutMs: 5_000,
  }), (error) => error?.code === "OF_GATE_CREATOR_CONTEXT_MISSING");
  assert.equal(accessCalls.binding, 2);
});

test("security probe is globally paced without requiring pre-existing read readiness", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const service = loadService({ db: databaseFixture(accessCalls) });
  service._test.reset();
  const permit = await service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-1", creatorId: "creator-1", priority: "interactive", operation: "identity.bootstrap.me", capability: "security_probe", timeoutMs: 5_000,
  });
  await started(service, "device-1", permit.permitId, "security_probe");
  assert.equal(accessCalls.binding, 0);
});


test("capability freshness cutoff uses PostgreSQL authority instead of replica wall clock", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const authorityNow = new Date("2038-02-03T04:05:06.700Z");
  let bindingWhere = null;
  const db = databaseFixture(accessCalls);
  db.workerDevice.findFirst = async ({ where }) => {
    accessCalls.device += 1;
    return { id: where.id, userId: where.userId, agencyId: "agency-1", lastSeenAt: authorityNow };
  };
  db.$queryRawUnsafe = async (sql) => {
    assert.match(String(sql), /clock_timestamp\(\)/);
    return [{ authorityNow }];
  };
  db.deviceCreatorBinding.findFirst = async ({ where }) => {
    accessCalls.binding += 1;
    bindingWhere = where;
    return { id: "binding-db-clock" };
  };
  const service = loadService({ db });
  service._test.reset();
  const permit = await service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-db-clock", creatorId: "creator-1", priority: "normal", operation: "db-clock", capability: "read", timeoutMs: 5_000,
  });
  await started(service, "device-db-clock", permit.permitId, "read");
  assert.equal(bindingWhere.lastSeenAt.gte.toISOString(), new Date(authorityNow.getTime() - 5 * 60_000).toISOString());
  assert.equal(bindingWhere.lastSeenAt.lte.toISOString(), new Date(authorityNow.getTime() + 5 * 60_000).toISOString());
});

test("future-poisoned device heartbeat cannot authorize OF capability", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const authorityNow = new Date("2038-02-03T04:05:06.700Z");
  const db = databaseFixture(accessCalls);
  db.workerDevice.findFirst = async ({ where }) => ({
    id: where.id, userId: where.userId, agencyId: "agency-1",
    lastSeenAt: new Date(authorityNow.getTime() + 20 * 60_000),
  });
  db.$queryRawUnsafe = async () => [{ authorityNow }];
  const service = loadService({ db });
  service._test.reset();
  await assert.rejects(() => service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-future", creatorId: "creator-1", priority: "normal", operation: "future-poison", capability: "read", timeoutMs: 5_000,
  }), (error) => error?.code === "OF_GATE_DEVICE_STALE");
  assert.equal(accessCalls.binding, 0);
});
