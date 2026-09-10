"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms); }),
  ]);
}

test("A49/A20 PostgreSQL: opposite money-root reassignments do not deadlock and preserve exact deltas", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { applyTeamMoneyFactToRollups } = require("./team-money-rollup-authority-service");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const agencyId = token("p2_roll_lock_agency");
  const factA = token("p2_roll_lock_fact_a");
  const factB = token("p2_roll_lock_fact_b");
  const sourceA = token("p2_roll_lock_source_a");
  const sourceB = token("p2_roll_lock_source_b");
  const creatorId = token("p2_roll_lock_creator");
  const day = new Date("2026-09-01T12:00:00.000Z");
  try {
    await db1.agency.create({ data: { id: agencyId, name: `Phase2 rollup lock ${agencyId}` } });
    await db1.teamMoneyAttributionFact.createMany({ data: [
      {
        id: factA, agencyId, sourceType: "PPV", sourceRowId: sourceA, creatorId, memberId: "member-a",
        amountCents: 1000, currency: "USD", occurredAt: day, businessStatus: "attributed",
        financialStatus: "done", attributionActive: true, classificationState: "CANONICAL", sourceUpdatedAt: day,
      },
      {
        id: factB, agencyId, sourceType: "PPV", sourceRowId: sourceB, creatorId, memberId: "member-b",
        amountCents: 2000, currency: "USD", occurredAt: day, businessStatus: "attributed",
        financialStatus: "done", attributionActive: true, classificationState: "CANONICAL", sourceUpdatedAt: day,
      },
    ] });

    await applyTeamMoneyFactToRollups({ db: db1, agencyId, factId: factA });
    await applyTeamMoneyFactToRollups({ db: db1, agencyId, factId: factB });

    const changedAt = new Date("2026-09-01T13:00:00.000Z");
    await db1.teamMoneyAttributionFact.update({ where: { id: factA }, data: { memberId: "member-b", sourceUpdatedAt: changedAt } });
    await db1.teamMoneyAttributionFact.update({ where: { id: factB }, data: { memberId: "member-a", sourceUpdatedAt: changedAt } });

    // Two independent Prisma clients force separate PostgreSQL connection pools.
    // The opposite X->Y / Y->X transitions touch the same rollup rows in reverse
    // business direction; deterministic bucket locks must remove the wait cycle.
    await withTimeout(Promise.all([
      applyTeamMoneyFactToRollups({ db: db1, agencyId, factId: factA }),
      applyTeamMoneyFactToRollups({ db: db2, agencyId, factId: factB }),
    ]), 10_000, "PHASE2_TEAM_MONEY_ROLLUP_LOCK");

    const daily = await db1.teamMoneyDailyRollup.findMany({ where: { agencyId }, orderBy: { memberId: "asc" } });
    const dailyByMember = new Map(daily.map((row) => [row.memberId, { amount: BigInt(row.amountCents), count: Number(row.factCount) }]));
    assert.deepEqual(dailyByMember.get("member-a"), { amount: 2000n, count: 1 });
    assert.deepEqual(dailyByMember.get("member-b"), { amount: 1000n, count: 1 });

    const lifetime = await db1.teamMoneyLifetimeRollup.findMany({ where: { agencyId }, orderBy: { memberId: "asc" } });
    const lifetimeByMember = new Map(lifetime.map((row) => [row.memberId, { amount: BigInt(row.amountCents), count: Number(row.factCount) }]));
    assert.deepEqual(lifetimeByMember.get("member-a"), { amount: 2000n, count: 1 });
    assert.deepEqual(lifetimeByMember.get("member-b"), { amount: 1000n, count: 1 });
  } finally {
    try { await db1.agency.delete({ where: { id: agencyId } }); } catch (_) {}
    await Promise.allSettled([db1.$disconnect(), db2.$disconnect()]);
  }
});
