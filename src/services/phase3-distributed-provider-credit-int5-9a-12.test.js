"use strict";
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  PROVIDER_GATE_PERMIT_TTL_MS,
  registerDurableProviderWaiter,
  tryAcquireDurableProviderPermit,
  acknowledgeDurableProviderStarted,
  cancelDurableProviderPermit,
} = require("./provider-request-credit-authority-service");

function fakeDurableDb(start = new Date("2038-02-03T04:05:06.000Z")) {
  const db = {
    now: new Date(start),
    ticket: 0n,
    waiters: new Map(),
    state: {
      id: "of-global",
      activePermitId: null, activeOwnerInstanceId: null, activeAgencyId: null, activeCreatorId: null,
      activeDeviceId: null, activeCapability: null, activeIntervalMs: null, activeGrantedAt: null, activeExpiresAt: null,
      nextAllowedAt: null, revision: 0n, lastStartedAt: null, lastStartedCreatorId: null, lastStartedDeviceId: null,
      priorityCursor: 0, backgroundCategoryCursor: 0,
      fairnessGeneration: "phase3_provider_gate_fairness_v2_a14",
      fairnessActivationState: "DRAINING",
      fairnessDrainStartedAt: new Date(start),
      fairnessActivatedAt: null,
      fairnessActivationConfirmedAt: null,
      legacyPermitLastSeenAt: null,
      legacyPermitCount: 0n,
    },
    $transaction: async (work) => work({ ...(db), $transaction: undefined }),
    $queryRawUnsafe: async (sql, ...args) => {
      const text = String(sql);
      if (/INSERT INTO "OfProviderRequestGateState"/.test(text)) return [];
      if (/FROM "OfProviderRequestGateState" s[\s\S]*FOR UPDATE/.test(text)) return [{ ...db.state, authorityNow: new Date(db.now) }];
      if (/s\."fairnessGeneration"[\s\S]*FROM "OfProviderRequestGateState" s/.test(text)) return [{ ...db.state, authorityNow: new Date(db.now) }];
      if (/INSERT INTO "OfProviderRequestGateWaiter"/.test(text)) {
        const [waiterId, ownerInstanceId, agencyId, creatorId, deviceId, capability, priority, category, operation, source, ttlMs] = args;
        let row = db.waiters.get(waiterId);
        if (row && (row.ownerInstanceId !== ownerInstanceId || row.agencyId !== agencyId || row.creatorId !== creatorId || row.deviceId !== deviceId || row.capability !== capability)) return [];
        if (!row) {
          db.ticket += 1n;
          row = { waiterId, ownerInstanceId, agencyId, creatorId, deviceId, capability, priority, category, operation, source, ticket: db.ticket, enqueuedAt: new Date(db.now) };
        }
        row.leaseUntil = new Date(db.now.getTime() + Number(ttlMs));
        db.waiters.set(waiterId, row);
        return [{ ...row }];
      }
      if (/DELETE FROM "OfProviderRequestGateWaiter"[\s\S]*"leaseUntil" <= \$1/.test(text)) {
        const cutoff = args[0];
        for (const [id, row] of db.waiters) if (row.leaseUntil <= cutoff) db.waiters.delete(id);
        return [];
      }
      if (/SELECT "waiterId", "ownerInstanceId"[\s\S]*WHERE "waiterId" = \$1/.test(text)) {
        const row = db.waiters.get(args[0]);
        if (!row || row.leaseUntil <= args[1]) return [];
        return [{ ...row }];
      }
      if (/SELECT DISTINCT ON \(w\."priority", w\."category"\)/.test(text)) {
        const cutoff = args[0];
        const heads = new Map();
        for (const row of db.waiters.values()) {
          if (row.leaseUntil <= cutoff) continue;
          const key = `${row.priority}:${row.category}`;
          const prev = heads.get(key);
          if (!prev || row.ticket < prev.ticket) heads.set(key, row);
        }
        return [...heads.values()].map((row) => ({ ...row }));
      }
      if (/DELETE FROM "OfProviderRequestGateWaiter"[\s\S]*"waiterId" = \$1 AND "ownerInstanceId" = \$2/.test(text)) {
        const row = db.waiters.get(args[0]);
        if (row && row.ownerInstanceId === args[1]) { db.waiters.delete(args[0]); return [{ waiterId: args[0] }]; }
        return [];
      }
      if (/UPDATE "OfProviderRequestGateState"/.test(text)) {
        if (/"activePermitId"\s*=\s*\$2/.test(text)) {
          db.state.activePermitId = args[1]; db.state.activeOwnerInstanceId = args[2]; db.state.activeAgencyId = args[3];
          db.state.activeCreatorId = args[4]; db.state.activeDeviceId = args[5]; db.state.activeCapability = args[6];
          db.state.activeIntervalMs = args[7]; db.state.activeGrantedAt = args[8]; db.state.activeExpiresAt = args[9];
          if (db.state.fairnessActivationState !== "ACTIVE") {
            db.state.legacyPermitLastSeenAt = new Date(db.now);
            db.state.legacyPermitCount += 1n;
          }
          db.state.priorityCursor = Number(args[10] ?? db.state.priorityCursor);
          db.state.backgroundCategoryCursor = Number(args[11] ?? db.state.backgroundCategoryCursor);
        } else {
          db.state.activePermitId = null; db.state.activeOwnerInstanceId = null; db.state.activeAgencyId = null;
          db.state.activeCreatorId = null; db.state.activeDeviceId = null; db.state.activeCapability = null;
          db.state.activeIntervalMs = null; db.state.activeGrantedAt = null; db.state.activeExpiresAt = null;
          if (/"lastStartedAt" = \$2/.test(text)) {
            db.state.lastStartedAt = args[1]; db.state.lastStartedCreatorId = args[2]; db.state.lastStartedDeviceId = args[3];
            const candidate = args[4];
            if (!db.state.nextAllowedAt || candidate > db.state.nextAllowedAt) db.state.nextAllowedAt = candidate;
          } else if (/"nextAllowedAt" = GREATEST/.test(text)) {
            const candidate = args[1];
            if (!db.state.nextAllowedAt || candidate > db.state.nextAllowedAt) db.state.nextAllowedAt = candidate;
          }
        }
        db.state.revision += 1n;
        return [{ revision: db.state.revision, nextAllowedAt: db.state.nextAllowedAt }];
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
  return db;
}

async function queueWaiter(db, { waiterId, ownerInstanceId, agencyId, creatorId, deviceId, capability = "read", priority = "normal", category = "default", operation = "test", source = null }) {
  await registerDurableProviderWaiter({ db: commitDatabaseFixture(db), waiterId, ownerInstanceId, agencyId, creatorId, deviceId, capability, priority, category, operation, source, waiterTtlMs: 60_000 });
}

const scopeA = { agencyId: "agency-1", creatorId: "creator-a", deviceId: "device-a", capability: "read", intervalMs: 700 };

test("A12 durable singleton serializes permits across backend instances and accepts /started on another replica", async () => {
  const db = fakeDurableDb();
  await queueWaiter(db, { waiterId: "permit-a", ownerInstanceId: "backend-a", ...scopeA });
  const first = await tryAcquireDurableProviderPermit({ db: commitDatabaseFixture(db), waiterId: "permit-a", permitId: "permit-a", ownerInstanceId: "backend-a", ...scopeA });
  assert.equal(first.granted, true);
  await queueWaiter(db, { waiterId: "permit-b", ownerInstanceId: "backend-b", agencyId: "agency-1", creatorId: "creator-b", deviceId: "device-b" });
  const blocked = await tryAcquireDurableProviderPermit({
    db: commitDatabaseFixture(db), waiterId: "permit-b", permitId: "permit-b", ownerInstanceId: "backend-b", agencyId: "agency-1", creatorId: "creator-b", deviceId: "device-b", capability: "read", intervalMs: 700,
  });
  assert.equal(blocked.granted, false);
  assert.equal(blocked.reason, "active_permit");

  const started = await acknowledgeDurableProviderStarted({ db: commitDatabaseFixture(db), permitId: "permit-a", ...scopeA });
  assert.equal(started.startedAt.toISOString(), db.now.toISOString());
  assert.equal(db.state.activePermitId, null);
  assert.equal(db.state.nextAllowedAt.toISOString(), new Date(db.now.getTime() + 700).toISOString());

  const spacing = await tryAcquireDurableProviderPermit({
    db: commitDatabaseFixture(db), waiterId: "permit-b", permitId: "permit-b", ownerInstanceId: "backend-b", agencyId: "agency-1", creatorId: "creator-b", deviceId: "device-b", capability: "read", intervalMs: 700,
  });
  assert.equal(spacing.granted, false);
  assert.equal(spacing.reason, "spacing");
  db.now = new Date(started.nextAllowedAt);
  const second = await tryAcquireDurableProviderPermit({
    db: commitDatabaseFixture(db), waiterId: "permit-b", permitId: "permit-b", ownerInstanceId: "backend-b", agencyId: "agency-1", creatorId: "creator-b", deviceId: "device-b", capability: "read", intervalMs: 700,
  });
  assert.equal(second.granted, true);
  assert.equal(db.state.activeOwnerInstanceId, "backend-b");
});

test("A12 expired unacknowledged permit is unknown outcome and burns another full 700ms before reuse", async () => {
  const db = fakeDurableDb();
  await queueWaiter(db, { waiterId: "permit-a", ownerInstanceId: "backend-a", ...scopeA });
  const first = await tryAcquireDurableProviderPermit({ db: commitDatabaseFixture(db), waiterId: "permit-a", permitId: "permit-a", ownerInstanceId: "backend-a", ...scopeA });
  assert.equal(first.granted, true);
  db.now = new Date(first.expiresAt.getTime() + 1);
  await queueWaiter(db, { waiterId: "permit-b", ownerInstanceId: "backend-b", agencyId: "agency-1", creatorId: "creator-b", deviceId: "device-b" });
  const expired = await tryAcquireDurableProviderPermit({
    db: commitDatabaseFixture(db), waiterId: "permit-b", permitId: "permit-b", ownerInstanceId: "backend-b", agencyId: "agency-1", creatorId: "creator-b", deviceId: "device-b", capability: "read", intervalMs: 700,
  });
  assert.equal(expired.granted, false);
  assert.equal(expired.reason, "expired_unknown_outcome");
  assert.equal(expired.retryAt.toISOString(), new Date(db.now.getTime() + 700).toISOString());
  assert.equal(db.state.activePermitId, null);
});

test("A12 durable started/cancel are exact-scope CAS and cannot settle another device permit", async () => {
  const db = fakeDurableDb();
  await queueWaiter(db, { waiterId: "permit-a", ownerInstanceId: "backend-a", ...scopeA });
  await tryAcquireDurableProviderPermit({ db: commitDatabaseFixture(db), waiterId: "permit-a", permitId: "permit-a", ownerInstanceId: "backend-a", ...scopeA });
  await assert.rejects(
    () => acknowledgeDurableProviderStarted({ db: commitDatabaseFixture(db), permitId: "permit-a", ...scopeA, deviceId: "device-other" }),
    (error) => error?.code === "OF_GATE_PERMIT_INVALID",
  );
  const wrongCancel = await cancelDurableProviderPermit({ db: commitDatabaseFixture(db), permitId: "permit-a", ...scopeA, creatorId: "creator-other" });
  assert.equal(wrongCancel.cancelled, false);
  assert.equal(db.state.activePermitId, "permit-a");
  const cancelled = await cancelDurableProviderPermit({ db: commitDatabaseFixture(db), permitId: "permit-a", ...scopeA });
  assert.equal(cancelled.cancelled, true);
  assert.equal(db.state.activePermitId, null);
});

test("A12 migration/schema carry one durable gate singleton and additive indexes", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260918234500_phase3_provider_gate_distributed_credit_v1/migration.sql"), "utf8");
  assert.match(schema, /model OfProviderRequestGateState[\s\S]*activePermitId[\s\S]*activeExpiresAt[\s\S]*nextAllowedAt[\s\S]*revision\s+BigInt/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "OfProviderRequestGateState"/);
  assert.match(migration, /VALUES \('of-global', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP\)/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
});

test("A12 gate service uses PostgreSQL authority when transaction support exists and local permit is fallback-only", () => {
  const source = fs.readFileSync(path.join(__dirname, "of-request-gate-service.js"), "utf8");
  assert.match(source, /tryAcquireDurableProviderPermit/);
  assert.match(source, /acknowledgeDurableProviderStarted/);
  assert.match(source, /cancelDurableProviderPermit/);
  assert.match(source, /postgres_durable_waiter_weighted_fair_global_two_phase/);
  assert.match(source, /if \(!admission\.granted\)[\s\S]*enqueue\(entry\)[\s\S]*durableRetryAtMs/);
});

function loadGateWithDb(db) {
  const prismaModule = require.resolve("../prisma");
  require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: db };
  delete require.cache[require.resolve("./of-request-gate-service")];
  return require("./of-request-gate-service");
}

function liveGateDb() {
  const db = fakeDurableDb(new Date());
  Object.defineProperty(db, "now", { configurable: true, get: () => new Date() });
  const raw = db.$queryRawUnsafe;
  db.$queryRawUnsafe = async (sql, ...args) => {
    const text = String(sql);
    if (/SELECT\s+clock_timestamp\(\)\s+AS\s+"authorityNow"/i.test(text) && !/OfProviderRequestGateState/.test(text)) return [{ authorityNow: new Date() }];
    return raw(sql, ...args);
  };
  db.workerDevice = { findFirst: async ({ where }) => ({ id: where.id, userId: where.userId, agencyId: "agency-1", lastSeenAt: new Date() }) };
  db.creatorAccount = { findFirst: async ({ where }) => ({ id: where.id, agencyId: where.agencyId, status: "READY" }) };
  db.deviceCreatorBinding = { findFirst: async () => ({ id: "binding" }) };
  return db;
}

test("A12 durable contention requeues a blocked background waiter so a later critical write wins next grant", async () => {
  const db = liveGateDb();
  const gate = loadGateWithDb(db);
  gate._test.reset();
  const member = { role: "OWNER", assignedCreators: "all" };
  const first = await gate.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member, deviceId: "device-a", creatorId: "creator-a",
    priority: "background", operation: "a1", capability: "read", timeoutMs: 5_000,
  });
  const background = gate.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member, deviceId: "device-a", creatorId: "creator-a",
    priority: "background", operation: "a2", capability: "read", timeoutMs: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const critical = gate.acquireOfRequestSlot({
    userId: "user-1", agencyId: "agency-1", member, deviceId: "device-b", creatorId: "creator-b",
    priority: "critical_write", operation: "write", capability: "write", timeoutMs: 5_000,
  });
  await gate.acknowledgeOfRequestStarted({
    userId: "user-1", agencyId: "agency-1", member, deviceId: "device-a", creatorId: "creator-a", permitId: first.permitId, capability: "read",
  });
  const next = await Promise.race([
    critical.then((permit) => ({ kind: "critical", permit })),
    background.then((permit) => ({ kind: "background", permit })),
  ]);
  assert.equal(next.kind, "critical");
  await gate.cancelOfRequestPermit({
    userId: "user-1", agencyId: "agency-1", member, deviceId: "device-b", creatorId: "creator-b", permitId: next.permit.permitId, capability: "write",
  });
  const bg = await background;
  await gate.cancelOfRequestPermit({
    userId: "user-1", agencyId: "agency-1", member, deviceId: "device-a", creatorId: "creator-a", permitId: bg.permitId, capability: "read",
  });
});
