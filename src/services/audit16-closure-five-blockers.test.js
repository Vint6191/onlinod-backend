"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// The source ZIP intentionally has no installed node_modules. Inject the Prisma
// singleton before loading services that only need it as a runtime dependency;
// every adversarial test below supplies its own explicit DB authority.
const prismaPath = path.join(ROOT, "prisma.js");
const fakePrisma = { creatorEarningsSnapshot: { async findMany() { return []; } } };
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fakePrisma };

const { filterProductCreatorScope } = require("../middleware/product-access");
const { __test: homeTest } = require("./home-summary-service");
const {
  updateProxyEndpoint,
  deleteProxyEndpoint,
} = require("./creator-network-profile-service");
const { __test: deliveryTest } = require("./automation-action-delivery-service");

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function creatorDb() {
  const creators = [
    { id: "creator-a", agencyId: "agency-1", deletedAt: null },
    { id: "creator-b", agencyId: "agency-1", deletedAt: null },
    { id: "creator-x", agencyId: "agency-2", deletedAt: null },
  ];
  return {
    creatorAccount: {
      async findMany({ where }) {
        return creators
          .filter((row) => row.agencyId === where.agencyId && row.deletedAt === null)
          .filter((row) => !where.id?.in || where.id.in.includes(row.id))
          .map((row) => ({ id: row.id }));
      },
      async findFirst({ where }) {
        const row = creators.find((item) => item.id === where.id && item.agencyId === where.agencyId && item.deletedAt === null);
        return row ? { ...row, displayName: row.id, username: row.id, status: "READY" } : null;
      },
    },
  };
}

function reqFor(member) {
  return {
    auth: {
      agencyId: member.agencyId,
      userId: member.userId,
      membership: member,
      deviceId: "device-1",
    },
  };
}

test("Audit16 product scope validates broad requested ids against live current-agency creators", async () => {
  const db = creatorDb();
  const owner = { id: "m-owner", userId: "owner-1", agencyId: "agency-1", role: "OWNER", roleKey: "owner", assignedCreators: null };

  const own = await filterProductCreatorScope(reqFor(owner), ["creator-a"], { db, rejectForeign: true });
  assert.deepEqual(own.creatorIds, ["creator-a"]);

  await assert.rejects(
    filterProductCreatorScope(reqFor(owner), ["creator-x"], { db, rejectForeign: true }),
    (error) => error?.code === "CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );
  await assert.rejects(
    filterProductCreatorScope(reqFor(owner), ["does-not-exist"], { db, rejectForeign: true }),
    (error) => error?.code === "CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );
});

test("Audit16 product scope never widens a scoped member request", async () => {
  const db = creatorDb();
  const manager = { id: "m1", userId: "user-1", agencyId: "agency-1", role: "MANAGER", roleKey: "manager", assignedCreators: ["creator-a"] };
  await assert.rejects(
    filterProductCreatorScope(reqFor(manager), ["creator-a", "creator-b"], { db, rejectForeign: true }),
    (error) => error?.code === "CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );
  const filtered = await filterProductCreatorScope(reqFor(manager), ["creator-a", "creator-b"], { db, rejectForeign: false });
  assert.deepEqual(filtered.creatorIds, ["creator-a"]);
  assert.deepEqual(filtered.foreignCreatorIds, ["creator-b"]);
});

test("Audit16 Home read without refresh permission cannot schedule or advertise pending work", async () => {
  fakePrisma.creatorEarningsSnapshot.findMany = async () => [];

  const creators = [{ id: "creator-a", status: "READY", displayName: "A", username: "a" }];
  let scheduleCalls = 0;
  const denied = await homeTest.resolveAndScheduleSnapshots("agency-1", "7d", creators, {
    allowSchedule: false,
    scheduleJob: async () => { scheduleCalls += 1; return { created: true, jobId: "job-1" }; },
  });
  assert.equal(scheduleCalls, 0);
  assert.deepEqual(denied.pendingCreatorIds, []);
  assert.deepEqual(denied.scheduledJobs, []);

  const allowed = await homeTest.resolveAndScheduleSnapshots("agency-1", "7d", creators, {
    allowSchedule: true,
    scheduleJob: async () => { scheduleCalls += 1; return { created: true, jobId: "job-1" }; },
  });
  assert.equal(scheduleCalls, 1);
  assert.deepEqual(allowed.pendingCreatorIds, ["creator-a"]);
  assert.equal(allowed.scheduledJobs[0].jobId, "job-1");
});

function scopedProxyDb() {
  const manager = {
    id: "manager-1",
    userId: "user-1",
    agencyId: "agency-1",
    role: "MANAGER",
    roleKey: "manager",
    assignedCreators: ["creator-a"],
    permissions: { "creators.manage": true },
    deletedAt: null,
    deactivatedAt: null,
  };
  const db = {
    agencyMember: { async findUnique() { return { ...manager }; } },
    creatorAccount: {
      async findFirst({ where }) {
        if (where.id === "creator-b" && where.agencyId === "agency-1") {
          return { id: "creator-b", agencyId: "agency-1", displayName: "B", username: "b", status: "READY" };
        }
        return null;
      },
    },
    agencyProxyEndpoint: {
      async findFirst() {
        return { id: "proxy-b", agencyId: "agency-1", ownerCreatorId: "creator-b", version: 1, label: "B", type: "SOCKS5", host: "b.test", port: 1080, enabled: true, hasCredentials: false, encryptionMode: "CLIENT_E2E_V1" };
      },
      async updateMany() { throw new Error("cross-creator update must not reach mutation"); },
      async deleteMany() { throw new Error("cross-creator delete must not reach mutation"); },
    },
    creatorNetworkProfile: {
      async findFirst() { return null; },
    },
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

test("Audit16 scoped manager cannot patch or delete another creator-owned proxy", async () => {
  const db = scopedProxyDb();
  await assert.rejects(
    updateProxyEndpoint({ db, agencyId: "agency-1", actorUserId: "user-1", proxyId: "proxy-b", expectedVersion: 1, patch: { label: "changed" } }),
    (error) => error?.code === "PROXY_CREATOR_ACCESS_REVOKED" && error?.status === 403,
  );
  await assert.rejects(
    deleteProxyEndpoint({ db, agencyId: "agency-1", actorUserId: "user-1", proxyId: "proxy-b", expectedVersion: 1 }),
    (error) => error?.code === "PROXY_CREATOR_ACCESS_REVOKED" && error?.status === 403,
  );
});

test("Audit16 live automation management actor requires both permission and current creator scope", async () => {
  const manager = {
    id: "manager-1", userId: "user-1", agencyId: "agency-1", role: "MANAGER", roleKey: "manager",
    assignedCreators: ["creator-a"], permissions: { "automation.manage": true }, deletedAt: null, deactivatedAt: null,
  };
  const db = {
    agencyMember: { async findFirst() { return { ...manager }; } },
    creatorAccount: {
      async findFirst({ where }) {
        if (["creator-a", "creator-b"].includes(where.id)) return { id: where.id, agencyId: "agency-1", displayName: where.id, username: where.id, status: "READY" };
        return null;
      },
    },
  };
  await deliveryTest.requireLiveAutomationManagementActor({ db, agencyId: "agency-1", actorUserId: "user-1", creatorId: "creator-a" });
  await assert.rejects(
    deliveryTest.requireLiveAutomationManagementActor({ db, agencyId: "agency-1", actorUserId: "user-1", creatorId: "creator-b" }),
    (error) => error?.code === "CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );

  manager.permissions["automation.manage"] = false;
  await assert.rejects(
    deliveryTest.requireLiveAutomationManagementActor({ db, agencyId: "agency-1", actorUserId: "user-1", creatorId: "creator-a" }),
    (error) => error?.code === "WRITE_AUTOMATION_FORBIDDEN" && error?.status === 403,
  );
});

test("Audit16 delivery admin routes propagate actor and service rechecks scope at mutation boundary", () => {
  const route = read("routes/automation-control.js");
  const service = read("services/automation-action-delivery-service.js");
  for (const call of ["retryActionDelivery", "cancelActionDelivery", "releaseClaimByAdmin", "retrySafeFailures"]) {
    assert.match(route, new RegExp(`${call}\\([\\s\\S]{0,220}actorUserId:\\s*req\\.auth\\.userId`));
  }
  assert.match(service, /retryActionDelivery\(\{ agencyId, actorUserId, deliveryId \}\)[\s\S]*requireLiveAutomationManagementActor\(\{ agencyId, actorUserId, creatorId: delivery\.creatorId \}\)[\s\S]*\$transaction\(async \(tx\) => \{[\s\S]*requireLiveAutomationManagementActor\(\{ db: tx, agencyId, actorUserId, creatorId: delivery\.creatorId \}\)/);
  assert.match(service, /cancelActionDelivery\(\{ agencyId, actorUserId[\s\S]*\$transaction\(async \(tx\) => \{[\s\S]*requireLiveAutomationManagementActor\(\{ db: tx, agencyId, actorUserId, creatorId: delivery\.creatorId \}\)/);
  assert.match(service, /releaseClaimByAdmin\(\{ agencyId, actorUserId[\s\S]*\$transaction\(async \(tx\) => \{[\s\S]*requireLiveAutomationManagementActor\(\{ db: tx, agencyId, actorUserId, creatorId: delivery\.creatorId \}\)/);
  assert.match(service, /retrySafeFailures\(\{ agencyId, actorUserId[\s\S]*allowedCreatorScope\([\s\S]*creatorId:\s*\{ in: scope\.creatorIds/);
});

test("Audit16 legacy server automation events read is retired while activity remains creator-scoped", () => {
  const source = read("routes/automation/events-routes.js");
  assert.match(source, /router\.get\("\/events"[\s\S]*status\(410\)[\s\S]*LEGACY_AUTOMATION_EVENTS_GONE/);
  assert.doesNotMatch(source, /router\.get\("\/events"[\s\S]{0,400}listEvents/);
  assert.match(source, /router\.get\("\/activity"[\s\S]*requireAutomationCreatorAccess/);
});
