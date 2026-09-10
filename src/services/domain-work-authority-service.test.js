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
