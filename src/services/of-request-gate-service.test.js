"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function loadService(fixture) {
  require("../../scripts/test-support/billing-execution-fixture").installTrialBillingRows(fixture.db);
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
      findFirst: async ({ where }) => { accessCalls.creator += 1; return { id: where.id, agencyId: where.agencyId, status: "READY" }; },
    },
    deviceCreatorBinding: {
      findFirst: async () => { accessCalls.binding += 1; return { id: "binding-1" }; },
    },
    $queryRawUnsafe: async () => [{ authorityNow: new Date() }],
  };
}

async function started(service, deviceId, permitId, capability = "read", creatorId = "creator-1") {
  return service.acknowledgeOfRequestStarted({
    userId: "user-1",
    agencyId: "agency-1",
    member: { role: "OWNER", assignedCreators: "all" },
    deviceId,
    creatorId,
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
  assert.equal(service.getOfRequestGateSnapshot().coordinator, "single_backend_process_global_two_phase_creator_round_robin");
});



test("global OF gate spaces actual starts across different creators", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const service = loadService({ db: databaseFixture(accessCalls) });
  service._test.reset();

  const firstPermit = await service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-a", creatorId: "creator-a", priority: "background", operation: "fan.refresh", capability: "read", timeoutMs: 5_000,
  });
  const secondPromise = service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-b", creatorId: "creator-b", priority: "background", operation: "campaign.directory", capability: "read", timeoutMs: 5_000,
  });

  const firstStart = await started(service, "device-a", firstPermit.permitId, "read", "creator-a");
  const secondPermit = await secondPromise;
  const secondStart = await started(service, "device-b", secondPermit.permitId, "read", "creator-b");
  const spacing = new Date(secondStart.startedAt).getTime() - new Date(firstStart.startedAt).getTime();
  assert.ok(spacing >= 700, `expected process-wide >=700ms between creators, got ${spacing}`);
  const snapshot = service.getOfRequestGateSnapshot();
  assert.equal(snapshot.activePermit, null);
  assert.equal(snapshot.lastCreatorId, "creator-b");
});

test("background queue is creator-round-robin so one creator backlog cannot monopolize permits", async () => {
  const accessCalls = { device: 0, creator: 0, binding: 0 };
  const service = loadService({ db: databaseFixture(accessCalls) });
  service._test.reset();

  const first = await service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-a", creatorId: "creator-a", priority: "background", operation: "a1", capability: "read", timeoutMs: 5_000,
  });
  const a2 = service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-a", creatorId: "creator-a", priority: "background", operation: "a2", capability: "read", timeoutMs: 5_000,
  });
  const a3 = service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-a", creatorId: "creator-a", priority: "background", operation: "a3", capability: "read", timeoutMs: 5_000,
  });
  const b1 = service.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" },
    deviceId: "device-b", creatorId: "creator-b", priority: "background", operation: "b1", capability: "read", timeoutMs: 5_000,
  });

  await service.cancelOfRequestPermit({ userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-a", creatorId: "creator-a", permitId: first.permitId, capability: "read" });
  const second = await Promise.race([
    b1.then((permit) => ({ creator: "b", permit })),
    a2.then((permit) => ({ creator: "a", permit })),
  ]);
  assert.equal(second.creator, "b", "creator B must receive the next background turn before creator A drains its backlog");
  await service.cancelOfRequestPermit({ userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-b", creatorId: "creator-b", permitId: second.permit.permitId, capability: "read" });
  const permitA2 = await a2;
  await service.cancelOfRequestPermit({ userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-a", creatorId: "creator-a", permitId: permitA2.permitId, capability: "read" });
  const permitA3 = await a3;
  await service.cancelOfRequestPermit({ userId: "user-1", agencyId: "agency-1", member: { role: "OWNER", assignedCreators: "all" }, deviceId: "device-a", creatorId: "creator-a", permitId: permitA3.permitId, capability: "read" });
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

  assert.deepEqual(accessCalls, { device: 1, creator: 6, binding: 1 });
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
