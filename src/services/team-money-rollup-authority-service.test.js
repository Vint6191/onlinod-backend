"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function phase2MoneyRollupTestLoad(request, parent, isMain) {
  if (request === "../prisma" && String(parent?.filename || "").endsWith("team-money-rollup-authority-service.js")) {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
let rollupService;
try {
  rollupService = require("./team-money-rollup-authority-service");
} finally {
  Module._load = originalLoad;
}
const { applyTeamMoneyFactToRollups, desiredContribution, rollupBucketLockKeys } = rollupService;

function createFixture() {
  const fact = {
    id: "fact-1", agencyId: "agency-1", sourceType: "PPV", creatorId: "creator-1", memberId: "member-a",
    amountCents: 1000, currency: "USD", occurredAt: new Date("2026-09-01T12:00:00Z"), businessStatus: "attributed",
    financialStatus: "done", attributionActive: true, classificationState: "CANONICAL", sourceUpdatedAt: new Date("2026-09-01T12:01:00Z"),
  };
  const contributions = new Map(); const daily = new Map(); const lifetime = new Map();
  const dayKey = (r) => [r.agencyId,r.memberId,r.creatorKey,r.sourceType,r.currency,new Date(r.day).toISOString().slice(0,10)].join("|");
  const lifeKey = (r) => [r.agencyId,r.memberId,r.creatorKey,r.sourceType,r.currency].join("|");
  const mutate = (row, data) => {
    if (data.amountCents?.increment !== undefined) row.amountCents += BigInt(data.amountCents.increment);
    if (data.amountCents?.decrement !== undefined) row.amountCents -= BigInt(data.amountCents.decrement);
    if (data.factCount?.increment !== undefined) row.factCount += Number(data.factCount.increment);
    if (data.factCount?.decrement !== undefined) row.factCount -= Number(data.factCount.decrement);
    for (const [k,v] of Object.entries(data)) if (!["amountCents","factCount"].includes(k)) row[k]=v;
  };
  const rollupModel = (map, keyFn) => ({
    async upsert({ where, create, update }) {
      const identity = Object.values(where)[0]; const key = keyFn(identity); let row = map.get(key);
      if (!row) { row = { ...create, amountCents: BigInt(create.amountCents), factCount: Number(create.factCount) }; map.set(key,row); }
      else mutate(row, update);
      return { ...row };
    },
    async updateMany({ where, data }) {
      const key = keyFn(where); const row = map.get(key); if (!row) return { count: 0 }; mutate(row,data); return { count: 1 };
    },
  });
  const db = {
    $transaction: async (fn) => fn(db),
    teamMoneyAttributionFact: { async findFirst({ where }) { return where.id===fact.id && where.agencyId===fact.agencyId ? { ...fact } : null; } },
    teamMoneyRollupContribution: {
      async findUnique({ where }) { const row=contributions.get(where.sourceFactId); return row ? { ...row } : null; },
      async upsert({ where, create, update }) { const key=where.sourceFactId; const row=contributions.get(key); const next=row ? { ...row,...update } : { ...create }; contributions.set(key,next); return { ...next }; },
    },
    teamMoneyDailyRollup: rollupModel(daily,dayKey),
    teamMoneyLifetimeRollup: rollupModel(lifetime,lifeKey),
  };
  return { db, fact, contributions, daily, lifetime, dayKey, lifeKey };
}

function total(map, predicate=()=>true) {
  let amount=0n, count=0;
  for (const row of map.values()) if (predicate(row)) { amount += BigInt(row.amountCents); count += Number(row.factCount); }
  return { amount, count };
}

test("A49 rollup replay/reassignment/currency-day correction/refund applies exact old->new delta once", async () => {
  const fx=createFixture();
  let r=await applyTeamMoneyFactToRollups({ db:fx.db, agencyId:"agency-1", factId:"fact-1" });
  assert.equal(r.changed,true);
  assert.deepEqual(total(fx.daily),{amount:1000n,count:1});
  assert.deepEqual(total(fx.lifetime),{amount:1000n,count:1});

  r=await applyTeamMoneyFactToRollups({ db:fx.db, agencyId:"agency-1", factId:"fact-1" });
  assert.equal(r.idempotent,true,"same worker replay must not double contribution");
  assert.deepEqual(total(fx.daily),{amount:1000n,count:1});

  fx.fact.memberId="member-b"; fx.fact.currency="EUR"; fx.fact.amountCents=800;
  fx.fact.occurredAt=new Date("2026-09-02T01:00:00Z"); fx.fact.sourceUpdatedAt=new Date("2026-09-02T01:01:00Z");
  await applyTeamMoneyFactToRollups({ db:fx.db, agencyId:"agency-1", factId:"fact-1" });
  assert.deepEqual(total(fx.daily,r=>r.memberId==="member-a"),{amount:0n,count:0},"old member/day/currency bucket must be reversed");
  assert.deepEqual(total(fx.daily,r=>r.memberId==="member-b" && r.currency==="EUR"),{amount:800n,count:1});
  assert.deepEqual(total(fx.lifetime,r=>r.memberId==="member-a"),{amount:0n,count:0});
  assert.deepEqual(total(fx.lifetime,r=>r.memberId==="member-b" && r.currency==="EUR"),{amount:800n,count:1});

  fx.fact.financialStatus="undo"; fx.fact.attributionActive=false; fx.fact.sourceUpdatedAt=new Date("2026-09-02T02:00:00Z");
  await applyTeamMoneyFactToRollups({ db:fx.db, agencyId:"agency-1", factId:"fact-1" });
  assert.deepEqual(total(fx.daily),{amount:0n,count:0},"refund/deactivation must remove contribution exactly once");
  assert.deepEqual(total(fx.lifetime),{amount:0n,count:0});

  const desired=desiredContribution(fx.fact);
  assert.equal(desired.active,false);
  const applied=fx.contributions.get("fact-1");
  assert.equal(applied.active,false);
});


test("A49/A20 opposite rollup reassignments acquire the same bucket locks in deterministic order before mutation", async () => {
  const day = new Date("2026-09-01T00:00:00.000Z");
  const a = { active: true, agencyId: "agency-1", memberId: "member-a", creatorKey: "creator-1", creatorId: "creator-1", sourceType: "PPV", currency: "USD", day, amountCents: 1000n };
  const b = { active: true, agencyId: "agency-1", memberId: "member-b", creatorKey: "creator-1", creatorId: "creator-1", sourceType: "PPV", currency: "USD", day, amountCents: 1000n };
  const forward = rollupBucketLockKeys(a, b);
  const reverse = rollupBucketLockKeys(b, a);
  assert.deepEqual(forward, reverse, "X->Y and Y->X must acquire the identical lock set in identical order");
  assert.deepEqual(forward, [...forward].sort(), "bucket lock order must be globally deterministic");
  assert.equal(forward.length, 4, "two distinct member buckets require daily+lifetime locks for both sides");

  const fx = createFixture();
  await applyTeamMoneyFactToRollups({ db: fx.db, agencyId: "agency-1", factId: "fact-1" });
  fx.fact.memberId = "member-b";
  fx.fact.sourceUpdatedAt = new Date("2026-09-01T12:02:00Z");

  const events = [];
  fx.db.$executeRawUnsafe = async (_sql, key) => { events.push(`lock:${String(key)}`); return 1; };
  for (const [name, model] of [["daily", fx.db.teamMoneyDailyRollup], ["lifetime", fx.db.teamMoneyLifetimeRollup]]) {
    const originalUpdateMany = model.updateMany.bind(model);
    const originalUpsert = model.upsert.bind(model);
    model.updateMany = async (args) => { events.push(`mutate:${name}:update`); return originalUpdateMany(args); };
    model.upsert = async (args) => { events.push(`mutate:${name}:upsert`); return originalUpsert(args); };
  }

  await applyTeamMoneyFactToRollups({ db: fx.db, agencyId: "agency-1", factId: "fact-1" });
  assert.match(events[0], /^lock:team-money-rollup:agency-1:fact-1$/, "per-fact serialization remains the first authority lock");
  const bucketLocks = events.filter((event) => event.startsWith("lock:team-money-rollup-bucket:"));
  assert.equal(bucketLocks.length, 4);
  assert.deepEqual(bucketLocks, [...bucketLocks].sort(), "production transaction must acquire bucket locks in sorted order");
  const lastBucketLockIndex = Math.max(...bucketLocks.map((event) => events.indexOf(event)));
  const firstMutationIndex = events.findIndex((event) => event.startsWith("mutate:"));
  assert.ok(firstMutationIndex > lastBucketLockIndex, `all bucket locks must precede rollup mutation: ${JSON.stringify(events)}`);
});
