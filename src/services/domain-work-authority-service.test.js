"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const authority = require("./domain-work-authority-service");

function cmp(actual, expected) {
  if (expected && typeof expected === "object" && !(expected instanceof Date) && !Array.isArray(expected)) {
    if (Object.prototype.hasOwnProperty.call(expected, "lte") && !(actual <= expected.lte)) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "lt") && !(actual < expected.lt)) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "gte") && !(actual >= expected.gte)) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "gt") && !(actual > expected.gt)) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "in") && !expected.in.includes(actual)) return false;
    return true;
  }
  return actual === expected;
}
function matches(row, where = {}) {
  if (where.OR && !where.OR.some((clause) => matches(row, clause))) return false;
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") continue;
    if (key.includes("_workClass_") || key === "agencyId_workClass_objectType_objectId") {
      const value = expected;
      if (!matches(row, value)) return false;
      continue;
    }
    if (!cmp(row[key], expected)) return false;
  }
  return true;
}
function applyData(row, data) {
  const out = { ...row };
  for (const [key, value] of Object.entries(data || {})) {
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) {
      out[key] = BigInt(out[key] || 0) + BigInt(value.increment);
    } else out[key] = value;
  }
  return out;
}
function makeDb() {
  const rows = new Map();
  const dependencies = new Map();
  const depKey = (where) => {
    const x = where.agencyId_dependencyKind_dependencyKey || where;
    return `${x.agencyId}\u001f${x.dependencyKind}\u001f${x.dependencyKey}`;
  };
  const dependencyModel = {
    async findUnique({ where }) { return dependencies.get(depKey(where)) || null; },
    async upsert({ where, create, update }) {
      const key = depKey(where);
      const current = dependencies.get(key);
      const next = current ? applyData(current, update) : { ...create };
      dependencies.set(key, next);
      return { ...next };
    },
  };
  const model = {
    async findUnique({ where }) {
      if (where.id) return rows.get(where.id) || null;
      const compound = where.agencyId_workClass_objectType_objectId;
      if (compound) return [...rows.values()].find((r) => matches(r, compound)) || null;
      return null;
    },
    async findFirst({ where }) { return [...rows.values()].find((r) => matches(r, where)) || null; },
    async findMany({ where, orderBy, take }) {
      let list = [...rows.values()].filter((r) => matches(r, where));
      list.sort((a, b) => {
        for (const ord of orderBy || []) {
          const [key, dir] = Object.entries(ord)[0];
          if (a[key] < b[key]) return dir === "desc" ? 1 : -1;
          if (a[key] > b[key]) return dir === "desc" ? -1 : 1;
        }
        return 0;
      });
      return list.slice(0, take || list.length).map((r) => ({ ...r }));
    },
    async upsert({ where, create, update }) {
      const current = await model.findUnique({ where });
      const next = current ? applyData(current, update) : { ...create };
      rows.set(next.id, next); return { ...next };
    },
    async update({ where, data }) {
      const current = rows.get(where.id); if (!current) throw new Error("missing row");
      const next = applyData(current, data); rows.set(next.id, next); return { ...next };
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const [id, current] of [...rows.entries()]) {
        if (!matches(current, where)) continue;
        rows.set(id, applyData(current, data)); count += 1;
      }
      return { count };
    },
  };
  const db = { domainWorkItem: model, phase2DependencyState: dependencyModel, async $transaction(work) { return work(db); } };
  return { db, rows, dependencies, dependencyModel };
}

const base = { agencyId: "agency-a", workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, objectType: "CustomOrder", objectId: "order-1", partitionKey: "creator-1", creatorId: "creator-1" };

test("A37-R2: every claim settlement rejects ownership expiring while its row lock is pending", async () => {
  const operations = [
    ["heartbeatDomainWorkClaim", "renewed"], ["ackDomainWorkClaim", "acknowledged"],
    ["blockDomainWorkClaim", "blocked"], ["failDomainWorkClaim", "failed"],
    ["saveDomainWorkProgress", "saved"], ["yieldDomainWorkClaim", "yielded"],
  ];
  for (const [name, resultKey] of operations) {
    const before = new Date("2026-09-23T00:00:00Z");
    const after = new Date(before.getTime() + 60_000);
    const calls = [];
    let locked = false;
    const item = { id: "expiring-work", agencyId: "agency-a", state: "CLAIMED", ownerToken: "owner",
      claimFence: 1n, claimedRevision: 1n, requestedRevision: 1n,
      activeGeneration: authority.DOMAIN_WORK_GENERATION, leaseUntil: new Date(before.getTime() + 1000) };
    const db = {
      async $transaction(work) { return work(db); },
      domainWorkItem: { async updateMany() { throw new Error("Expired ownership attempted a mutation"); } },
      async $queryRawUnsafe(sql) {
        calls.push(sql);
        if (sql.includes("clock_timestamp()")) return [{ authorityNow: locked ? after : before }];
        if (sql.includes('FROM "DomainWorkItem"') && sql.includes("FOR UPDATE")) { locked = true; return [item]; }
        if (sql.includes('"Phase2DependencyState"')) return [{ revision: 0n }];
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const result = await authority[name]({ db, item, dependencyKind: "DEP", dependencyKey: "key", progressCursor: { page: 2 } });
    assert.equal(result[resultKey], false, name);
    assert.equal(result.lost, true, name);
    const lockIndex = calls.findIndex((sql) => sql.includes('FROM "DomainWorkItem"'));
    assert.ok(lockIndex >= 0 && lockIndex < calls.findIndex((sql) => sql.includes("clock_timestamp()")), name);
    if (name === "blockDomainWorkClaim") assert.ok(calls.findIndex((sql) => sql.includes('"Phase2DependencyState"')) < lockIndex);
  }
});

test("A36: immediate PostgreSQL publication is resolved by the database clock", async () => {
  const calls = [];
  const db = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return [{ id: "db-clock-work" }];
    },
  };
  const processClock = new Date("2026-09-23T12:34:56.789Z");

  const immediate = await authority.publishDomainWork({ db, ...base, fallbackNow: processClock });
  assert.equal(immediate.id, "db-clock-work");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /COALESCE\(\$12::timestamptz,clock_timestamp\(\)\)/);
  assert.match(calls[0].sql, /AT TIME ZONE 'UTC'/);
  assert.equal(calls[0].params[11], null,
    "an immediate PostgreSQL write must not serialize the process clock as its due time");

  const scheduledAt = new Date("2026-09-23T13:00:00.000Z");
  await authority.publishDomainWork({ db, ...base, objectId: "order-scheduled", availableAt: scheduledAt });
  assert.equal(calls[1].params[11], scheduledAt,
    "an explicit business deadline must remain explicit at the centralized SQL boundary");
});

test("A36: invalid explicit publication deadlines fail closed", async () => {
  let queries = 0;
  const db = { async $queryRawUnsafe() { queries += 1; return []; } };
  await assert.rejects(
    authority.publishDomainWork({ db, ...base, availableAt: "not-a-timestamp" }),
    (error) => error?.code === "DOMAIN_WORK_AVAILABLE_AT_INVALID",
  );
  assert.equal(queries, 0, "invalid deadlines must be rejected before storage mutation");
});

test("A36: non-PostgreSQL adapters receive the caller fallback clock", async () => {
  const fx = makeDb();
  const fallbackNow = new Date("2026-09-23T12:34:56.789Z");
  const row = await authority.publishDomainWork({ db: fx.db, ...base, objectId: "adapter-immediate", fallbackNow });
  assert.equal(new Date(row.availableAt).getTime(), fallbackNow.getTime());
});

test("A1: newer canonical wakeup survives stale revision ACK", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "worker-v1", fallbackNow: t0, leaseMs: 60_000 });
  assert.equal(claim.items.length, 1);
  const v1 = claim.items[0];
  assert.equal(v1.claimedRevision, 1n);

  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: new Date(t0.getTime() + 1_000) });
  const mid = fx.rows.get(v1.id);
  assert.equal(mid.requestedRevision, 2n);
  assert.equal(mid.state, authority.STATE.CLAIMED);

  const ack = await authority.ackDomainWorkClaim({ db: fx.db, item: v1, ownerToken: "worker-v1", fallbackNow: new Date(t0.getTime() + 2_000) });
  assert.equal(ack.acknowledged, true);
  const final = fx.rows.get(v1.id);
  assert.equal(final.completedRevision, 1n);
  assert.equal(final.requestedRevision, 2n);
  assert.equal(final.state, authority.STATE.READY);
});

test("A1: stale V1 failure cannot put a newer V2 wakeup back behind retry", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "worker-v1", fallbackNow: t0, leaseMs: 60_000 });
  const v1 = claim.items[0];
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: new Date(t0.getTime() + 1_000) });

  const failure = await authority.failDomainWorkClaim({
    db: fx.db, item: v1, ownerToken: "worker-v1", error: Object.assign(new Error("old failure"), { code: "OLD_V1_FAILED" }),
    retryAt: new Date(t0.getTime() + 15 * 60_000), fallbackNow: new Date(t0.getTime() + 2_000),
  });
  assert.equal(failure.lost, false);
  assert.equal(failure.superseded, true);
  const final = fx.rows.get(v1.id);
  assert.equal(final.requestedRevision, 2n);
  assert.equal(final.state, authority.STATE.READY);
  assert.equal(final.nextAttemptAt, null);
  assert.equal(final.errorClass, null);
  assert.equal(final.lastError, null);
  assert.equal(new Date(final.availableAt).getTime(), t0.getTime() + 2_000);
});

test("A1: stale V1 yield cursor/deadline cannot delay a newer V2 wakeup", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "worker-v1", fallbackNow: t0, leaseMs: 60_000 });
  const v1 = claim.items[0];
  fx.rows.get(v1.id).progressCursor = { page: "v1" };
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: new Date(t0.getTime() + 1_000) });

  const yielded = await authority.yieldDomainWorkClaim({
    db: fx.db, item: v1, ownerToken: "worker-v1", progressCursor: { page: "stale-v1" },
    availableAt: new Date(t0.getTime() + 5 * 60_000), fallbackNow: new Date(t0.getTime() + 2_000),
  });
  assert.equal(yielded.lost, false);
  assert.equal(yielded.newerRevision, true);
  const final = fx.rows.get(v1.id);
  assert.equal(final.state, authority.STATE.READY);
  assert.equal(final.progressCursor, null);
  assert.equal(new Date(final.availableAt).getTime(), t0.getTime() + 2_000);
});

test("A4 foundation: commit guard rejects an expired DomainWork owner before domain mutation", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "worker-v1", fallbackNow: t0, leaseMs: 30_000 });
  const item = claim.items[0];
  const valid = await authority.lockDomainWorkClaimForCommit({ db: fx.db, item, ownerToken: "worker-v1", fallbackNow: new Date(t0.getTime() + 10_000) });
  assert.equal(valid.current, true);
  assert.equal(valid.lost, false);
  const expired = await authority.lockDomainWorkClaimForCommit({ db: fx.db, item, ownerToken: "worker-v1", fallbackNow: new Date(t0.getTime() + 31_000) });
  assert.equal(expired.current, false);
  assert.equal(expired.lost, true);
});

test("A4: expired claim is reclaimed with a higher fence and stale owner cannot ACK", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });
  const first = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "worker-old", fallbackNow: t0, leaseMs: 30_000 });
  const oldItem = first.items[0];
  assert.equal(oldItem.claimFence, 1n);

  const afterExpiry = new Date(t0.getTime() + 31_000);
  const second = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "worker-new", fallbackNow: afterExpiry, leaseMs: 30_000 });
  assert.equal(second.items.length, 1);
  const newItem = second.items[0];
  assert.equal(newItem.claimFence, 2n);
  assert.equal(newItem.ownerToken, "worker-new");

  const staleAck = await authority.ackDomainWorkClaim({ db: fx.db, item: oldItem, ownerToken: "worker-old", fallbackNow: new Date(afterExpiry.getTime() + 1_000) });
  assert.equal(staleAck.acknowledged, false);
  assert.equal(staleAck.lost, true);

  const freshAck = await authority.ackDomainWorkClaim({ db: fx.db, item: newItem, ownerToken: "worker-new", fallbackNow: new Date(afterExpiry.getTime() + 2_000) });
  assert.equal(freshAck.acknowledged, true);
  assert.equal(fx.rows.get(newItem.id).state, authority.STATE.DONE);
});


test("A1/A7: stale V1 BLOCKED result cannot sleep a newer V2 canonical wakeup", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "worker-v1", fallbackNow: t0, leaseMs: 60_000 });
  const item = claim.items[0];
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: new Date(t0.getTime() + 500) });

  const blocked = await authority.blockDomainWorkClaim({
    db: fx.db, item, ownerToken: "worker-v1", dependencyKind: "AUTO_PROVIDER", dependencyKey: base.agencyId,
    dependencyRevision: 0n, reason: "OLD_V1_BLOCK", fallbackNow: new Date(t0.getTime() + 1_000),
  });
  assert.equal(blocked.lost, false);
  assert.equal(blocked.ready, true);
  assert.equal(blocked.newerRevision, true);
  const final = fx.rows.get(item.id);
  assert.equal(final.requestedRevision, 2n);
  assert.equal(final.state, authority.STATE.READY);
  assert.equal(final.nextAttemptAt, null);
  assert.equal(final.errorClass, null);
  assert.equal(final.lastError, null);
  assert.equal(new Date(final.availableAt).getTime(), t0.getTime() + 1_000);
});

test("A7 foundation: a dependency change observed before BLOCKED commit cannot be slept through", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "worker-v1", fallbackNow: t0, leaseMs: 60_000 });
  const item = claim.items[0];

  // The worker observed dependency revision 1, then the dependency changed to revision 2
  // before it attempted to publish BLOCKED. The block transaction must keep work READY.
  await fx.dependencyModel.upsert({
    where: { agencyId_dependencyKind_dependencyKey: { agencyId: base.agencyId, dependencyKind: "AUTO_PROVIDER", dependencyKey: base.agencyId } },
    create: { id: "dep-auto", agencyId: base.agencyId, dependencyKind: "AUTO_PROVIDER", dependencyKey: base.agencyId, revision: 2n, changedAt: t0 },
    update: { revision: 2n },
  });
  const blocked = await authority.blockDomainWorkClaim({
    db: fx.db, item, ownerToken: "worker-v1", dependencyKind: "AUTO_PROVIDER", dependencyKey: base.agencyId, dependencyRevision: 1n, reason: "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", fallbackNow: new Date(t0.getTime() + 1_000),
  });
  assert.equal(blocked.lost, false);
  assert.equal(blocked.ready, true);
  assert.equal(blocked.blocked, false);
  const final = fx.rows.get(item.id);
  assert.equal(final.state, authority.STATE.READY);
  assert.equal(final.dependencyRevision, 2n);
});

test("A36 dependency bump publishes one coalescing wake identity without synchronously rewriting blocked work", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-22T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({
    db: fx.db,
    workClass: base.workClass,
    ownerToken: "dependency-blocker",
    fallbackNow: t0,
    leaseMs: 60_000,
  });
  const item = claim.items[0];
  const blocked = await authority.blockDomainWorkClaim({
    db: fx.db,
    item,
    ownerToken: "dependency-blocker",
    dependencyKind: "AUTO_PROVIDER",
    dependencyKey: base.agencyId,
    dependencyRevision: 0n,
    reason: "A36_SCALE_PROBE",
    fallbackNow: new Date(t0.getTime() + 1_000),
  });
  assert.equal(blocked.blocked, true);

  const revision1 = await authority.bumpDomainDependency({
    db: fx.db,
    agencyId: base.agencyId,
    dependencyKind: "AUTO_PROVIDER",
    dependencyKey: base.agencyId,
    fallbackNow: new Date(t0.getTime() + 2_000),
  });
  assert.equal(revision1, 1n);
  assert.equal(fx.rows.get(item.id).state, authority.STATE.BLOCKED,
    "producer transaction must leave population wakeup to bounded durable work");
  const wakeRows = [...fx.rows.values()].filter((row) => row.workClass === authority.WORK_CLASS.DEPENDENCY_WAKE);
  assert.equal(wakeRows.length, 1);
  assert.equal(wakeRows[0].objectType, authority.DOMAIN_DEPENDENCY_WAKE_OBJECT_TYPE);
  assert.equal(wakeRows[0].dependencyRevision, 1n);

  const revision2 = await authority.bumpDomainDependency({
    db: fx.db,
    agencyId: base.agencyId,
    dependencyKind: "AUTO_PROVIDER",
    dependencyKey: base.agencyId,
    fallbackNow: new Date(t0.getTime() + 3_000),
  });
  assert.equal(revision2, 2n);
  const coalesced = [...fx.rows.values()].filter((row) => row.workClass === authority.WORK_CLASS.DEPENDENCY_WAKE);
  assert.equal(coalesced.length, 1);
  assert.equal(coalesced[0].requestedRevision, 2n);
  assert.equal(coalesced[0].dependencyRevision, 2n);
});

test("A5/A18 foundation: partition fairness admits valid work and future due work is not claimed early", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  for (let i = 0; i < 20; i += 1) {
    await authority.publishDomainWork({ db: fx.db, agencyId: "agency-a", workClass: authority.WORK_CLASS.CUSTOM_REMINDER,
      objectType: "CustomReminderObligation", objectId: `poison-${String(i).padStart(2, "0")}`,
      partitionKey: "creator-poison", creatorId: "creator-poison", availableAt: t0 });
  }
  await authority.publishDomainWork({ db: fx.db, agencyId: "agency-a", workClass: authority.WORK_CLASS.CUSTOM_REMINDER,
    objectType: "CustomReminderObligation", objectId: "valid-b", partitionKey: "creator-valid", creatorId: "creator-valid", availableAt: t0 });
  await authority.publishDomainWork({ db: fx.db, agencyId: "agency-b", workClass: authority.WORK_CLASS.CUSTOM_REMINDER,
    objectType: "CustomReminderObligation", objectId: "future", partitionKey: "creator-future", creatorId: "creator-future",
    availableAt: new Date(t0.getTime() + 60_000) });

  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: authority.WORK_CLASS.CUSTOM_REMINDER,
    ownerToken: "fair-worker", limit: 10, perAgencyQuantum: 10, perPartitionQuantum: 2, fallbackNow: t0 });
  assert.equal(claim.items.some((row) => row.objectId === "valid-b"), true);
  assert.equal(claim.items.filter((row) => row.partitionKey === "creator-poison").length <= 2, true);
  assert.equal(claim.items.some((row) => row.objectId === "future"), false);
});


test("A46: retired Actual52 maintenance owner drains before new DomainWork can execute", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: t0 });

  fx.db.phase2LegacyExecutorFence = {
    async findMany() { return [{ laneKey: "provider_operational_dirty_v1" }]; },
  };
  let legacyOwner = "actual52-worker";
  fx.db.maintenanceLaneState = {
    async findMany() {
      return legacyOwner ? [{ key: "provider_operational_dirty_v1", generation: "provider_operational_debt_v1", ownerToken: legacyOwner, leaseUntil: new Date(t0.getTime() + 60_000) }] : [];
    },
  };

  const blocked = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "new-worker", fallbackNow: t0 });
  assert.equal(blocked.items.length, 0);
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, "legacy_executor_drain");
  assert.equal(fx.rows.values().next().value.state, authority.STATE.READY);

  // The already-held Actual52 unit is allowed to finish; the migration trigger
  // prevents it (or any other old replica) from acquiring a new owner token.
  legacyOwner = null;
  const admitted = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: "new-worker", fallbackNow: new Date(t0.getTime() + 1_000) });
  assert.equal(admitted.items.length, 1);
  assert.equal(admitted.items[0].ownerToken, "new-worker");
});

test("F55-04: bounded repair may preserve a semantic cursor across a newer live-tail revision", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-11T00:00:00.000Z");
  await authority.publishDomainWork({ db: fx.db, ...base, workClass: authority.WORK_CLASS.TEAM_DIALOG_PROJECTION, objectType: "CreatorDialog", objectId: '["creator-1","dialog-1"]', availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: authority.WORK_CLASS.TEAM_DIALOG_PROJECTION, ownerToken: "team-worker-v1", fallbackNow: t0, leaseMs: 60_000 });
  const v1 = claim.items[0];
  const progress = { pendingRepair: { eventId: "event-old", cursor: { version: "team_pending_repair_v1", replyAt: null, cursorAt: "2026-09-10T00:00:00.000Z", cursorId: "event-100" } } };

  await authority.publishDomainWork({ db: fx.db, ...base, workClass: authority.WORK_CLASS.TEAM_DIALOG_PROJECTION, objectType: "CreatorDialog", objectId: '["creator-1","dialog-1"]', availableAt: new Date(t0.getTime() + 1000) });
  const yielded = await authority.yieldDomainWorkClaim({
    db: fx.db, item: v1, ownerToken: "team-worker-v1", progressCursor: progress,
    preserveProgressOnNewerRevision: true,
    availableAt: new Date(t0.getTime() + 300_000), fallbackNow: new Date(t0.getTime() + 2000),
  });

  assert.equal(yielded.lost, false);
  assert.equal(yielded.newerRevision, true);
  const current = fx.rows.get(v1.id);
  assert.equal(current.state, authority.STATE.READY);
  assert.deepEqual(current.progressCursor, progress);
  assert.equal(new Date(current.availableAt).getTime(), t0.getTime() + 2000, "new revision must still wake immediately");
});

test("F55-04: repeated live revisions cannot starve a bounded Team repair cursor", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-11T01:00:00.000Z");
  const identity = { ...base, workClass: authority.WORK_CLASS.TEAM_DIALOG_PROJECTION, objectType: "CreatorDialog", objectId: '["creator-1","dialog-hot"]' };
  await authority.publishDomainWork({ db: fx.db, ...identity, availableAt: t0 });
  let expectedCursor = null;
  for (let page = 1; page <= 3; page += 1) {
    const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: identity.workClass, ownerToken: `team-worker-${page}`, fallbackNow: new Date(t0.getTime() + page * 1000), leaseMs: 60_000 });
    assert.equal(claim.items.length, 1);
    const item = claim.items[0];
    expectedCursor = { pendingRepair: { eventId: "event-late", cursor: { version: "team_pending_repair_v1", replyAt: null, cursorAt: `2026-09-11T00:00:0${page}.000Z`, cursorId: `event-${page * 100}` } } };
    await authority.publishDomainWork({ db: fx.db, ...identity, availableAt: new Date(t0.getTime() + page * 1000 + 100) });
    const yielded = await authority.yieldDomainWorkClaim({
      db: fx.db, item, ownerToken: `team-worker-${page}`, progressCursor: expectedCursor,
      preserveProgressOnNewerRevision: true,
      availableAt: new Date(t0.getTime() + 60_000), fallbackNow: new Date(t0.getTime() + page * 1000 + 200),
    });
    assert.equal(yielded.newerRevision, true);
    assert.deepEqual(fx.rows.get(item.id).progressCursor, expectedCursor);
  }
  const current = [...fx.rows.values()].find((row) => row.objectId === identity.objectId);
  assert.deepEqual(current.progressCursor, expectedCursor, "repair prefix must advance despite a live revision between every page");
});

test("F55-04: live publication while repair work is READY preserves only the pending-repair prefix", async () => {
  const fx = makeDb();
  const t0 = new Date("2026-09-11T02:00:00.000Z");
  const identity = { ...base, workClass: authority.WORK_CLASS.TEAM_DIALOG_PROJECTION, objectType: "CreatorDialog", objectId: '["creator-1","dialog-ready"]' };
  await authority.publishDomainWork({ db: fx.db, ...identity, availableAt: t0 });
  const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: identity.workClass, ownerToken: "team-ready", fallbackNow: t0, leaseMs: 60_000 });
  const item = claim.items[0];
  const progress = { pendingRepair: { eventId: "event-old", cursor: { version: "team_pending_repair_v1", replyAt: null, cursorId: "event-100" } } };
  await authority.yieldDomainWorkClaim({ db: fx.db, item, ownerToken: "team-ready", progressCursor: progress, availableAt: t0, fallbackNow: new Date(t0.getTime() + 1000) });
  assert.deepEqual(fx.rows.get(item.id).progressCursor, progress);

  await authority.publishDomainWork({ db: fx.db, ...identity, availableAt: new Date(t0.getTime() + 2000) });
  assert.deepEqual(fx.rows.get(item.id).progressCursor, progress, "ordinary live-tail publication must not erase proven repair prefix");

  fx.rows.get(item.id).progressCursor = { genericCursor: "unsafe" };
  await authority.publishDomainWork({ db: fx.db, ...identity, availableAt: new Date(t0.getTime() + 3000) });
  assert.equal(fx.rows.get(item.id).progressCursor, null, "non-repair cursors keep generic revision invalidation semantics");
});

test("Phase3 closure: failure budget survives fresh claim objects and quarantines poison without consuming healthy claims", async () => {
  const fx = makeDb();
  let at = new Date("2026-09-23T21:00:00Z");
  const row = await authority.publishDomainWork({ db: fx.db, ...base, availableAt: at });
  fx.rows.get(row.id).attempts = 9000; // successful historical batches, not errors
  for (let failures = 1; failures <= 8; failures += 1) {
    const claim = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, ownerToken: `restart-${failures}`, fallbackNow: at });
    assert.equal(claim.items.length, 1);
    const result = await authority.failDomainWorkClaim({ db: fx.db, item: claim.items[0], fallbackNow: at,
      error: Object.assign(new Error("network unavailable"), { code: "ECONNRESET" }), retryAt: new Date(0) });
    assert.equal(result.consecutiveFailures, failures);
    assert.equal(result.state, failures === 8 ? "RECONCILE_REQUIRED" : "READY");
    assert.equal(fx.rows.get(row.id).isOutstanding, true);
    if (failures < 8) {
      assert.equal(result.retryAt.getTime() - at.getTime(), 1000 * 2 ** failures);
      at = result.retryAt;
    } else assert.equal(result.retryAt, null);
  }
  const idle = await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, fallbackNow: new Date(at.getTime() + 86400_000) });
  assert.equal(idle.items.length, 0);
  assert.equal(fx.rows.get(row.id).terminalCause, "RETRY_EXHAUSTED:ECONNRESET");
});

test("Phase3 closure: actual cursor progress resets failures; a heartbeat or empty yield does not", async () => {
  const fx = makeDb();
  const at = new Date("2026-09-23T21:00:00Z");
  const row = await authority.publishDomainWork({ db: fx.db, ...base, availableAt: at });
  const acquire = async () => (await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, fallbackNow: at })).items[0];
  let item = await acquire();
  Object.assign(fx.rows.get(row.id), { consecutiveFailures: 6, failureRevision: 1n, progressCursor: { page: 10 } });
  await authority.heartbeatDomainWorkClaim({ db: fx.db, item, fallbackNow: at });
  await authority.yieldDomainWorkClaim({ db: fx.db, item, progressCursor: { page: 10 }, fallbackNow: at });
  assert.equal(fx.rows.get(row.id).consecutiveFailures, 6);
  item = await acquire();
  await authority.yieldDomainWorkClaim({ db: fx.db, item, fallbackNow: at });
  assert.equal(fx.rows.get(row.id).consecutiveFailures, 6);
  item = await acquire();
  await authority.saveDomainWorkProgress({ db: fx.db, item, progressCursor: { page: 11 }, fallbackNow: at });
  const result = await authority.failDomainWorkClaim({ db: fx.db, item, error: new Error("after durable page"), fallbackNow: at });
  assert.equal(result.consecutiveFailures, 1, "use locked persisted progress, not the stale claimed copy");
});

test("Phase3 closure: contract errors require repair, while new canonical revision supersedes old poison", async () => {
  for (const error of [new TypeError("broken projection"), Object.assign(new Error("bad FK"), { code: "P2010", meta: { code: "23503" } }),
    Object.assign(new Error("bad work identity"), { code: "TEAM_DIALOG_WORK_IDENTITY_INVALID" })]) {
    const fx = makeDb();
    const at = new Date("2026-09-23T21:00:00Z");
    await authority.publishDomainWork({ db: fx.db, ...base, availableAt: at });
    let item = (await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, fallbackNow: at })).items[0];
    const failed = await authority.failDomainWorkClaim({ db: fx.db, item, error, fallbackNow: at });
    assert.equal(failed.reconcileRequired, true);
    await authority.publishDomainWork({ db: fx.db, ...base, availableAt: at });
    item = (await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, fallbackNow: at })).items[0];
    assert.equal(item.claimedRevision, 2n);
    const transient = await authority.failDomainWorkClaim({ db: fx.db, item, error: new Error("retry v2"), fallbackNow: at });
    assert.equal(transient.consecutiveFailures, 1);
    const next = transient.retryAt;
    item = (await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, fallbackNow: next })).items[0];
    await authority.publishDomainWork({ db: fx.db, ...base, availableAt: next });
    assert.equal((await authority.failDomainWorkClaim({ db: fx.db, item, error, fallbackNow: next })).superseded, true);
    assert.equal(fx.rows.get(item.id).consecutiveFailures, 0);
    assert.equal(fx.rows.get(item.id).terminalCause, null);
  }
});

test("Phase3 closure: typed dependency errors block and wake without burning the failure budget", async () => {
  const fx = makeDb();
  const at = new Date("2026-09-23T21:00:00Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: at });
  const item = (await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, fallbackNow: at })).items[0];
  const dependency = { dependencyKind: "CREATOR_BINDING", dependencyKey: base.creatorId, dependencyRevision: 0n };
  const blocked = await authority.failDomainWorkClaim({ db: fx.db, item, dependency, fallbackNow: at });
  assert.equal(blocked.blocked, true);
  assert.equal(Number(fx.rows.get(item.id).consecutiveFailures || 0), 0);
  await authority.bumpDomainDependency({ db: fx.db, agencyId: base.agencyId, ...dependency, fallbackNow: at });
  const wake = await authority.runDomainDependencyWakeSweep({ db: fx.db, now: at });
  assert.equal(wake.ok, true);
  assert.equal(fx.rows.get(item.id).state, "READY");
});

test("Phase3 closure: repair requires tenant and revision, records reason, and refuses retired current work", async () => {
  const { resumeDomainWorkAfterRepair } = require("./domain-work-repair-service");
  const fx = makeDb();
  let retired = false;
  fx.db.agency = { async findFirst() { return { deletedAt: retired ? new Date() : null }; } };
  fx.db.creatorAccount = { async findFirst() { return { deletedAt: null }; } };
  const at = new Date("2026-09-23T21:00:00Z");
  await authority.publishDomainWork({ db: fx.db, ...base, availableAt: at });
  const item = (await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, fallbackNow: at })).items[0];
  await authority.failDomainWorkClaim({ db: fx.db, item, error: new TypeError("broken"), fallbackNow: at });
  const input = { db: fx.db, agencyId: base.agencyId, workId: item.id, expectedRevision: "1", reason: "source repaired", fallbackNow: at };
  assert.equal((await resumeDomainWorkAfterRepair({ ...input, agencyId: "other-tenant" })).resumed, false);
  assert.equal((await resumeDomainWorkAfterRepair({ ...input, expectedRevision: "2" })).resumed, false);
  retired = true;
  assert.equal((await resumeDomainWorkAfterRepair(input)).reason, "lifecycle_retired");
  retired = false;
  assert.equal((await resumeDomainWorkAfterRepair(input)).requestedRevision, "2");
  assert.equal((await resumeDomainWorkAfterRepair(input)).resumed, false, "replay must not republish");
  assert.equal(fx.rows.get(item.id).lastRepair.reason, "source repaired");
  const current = (await authority.claimDomainWorkBatch({ db: fx.db, workClass: base.workClass, fallbackNow: at })).items[0];
  await authority.ackDomainWorkClaim({ db: fx.db, item: current, terminalCause: "CREATOR_RETIRED", fallbackNow: at });
  assert.equal(fx.rows.get(item.id).state, "DONE");
  assert.equal(fx.rows.get(item.id).terminalCause, "CREATOR_RETIRED");
});
