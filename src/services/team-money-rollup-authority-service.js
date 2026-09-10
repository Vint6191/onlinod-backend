"use strict";

const { createHash } = require("node:crypto");
const prisma = require("../prisma");
const { runDbTransaction, lockDbAdvisoryXact } = require("./db-transaction-service");

const TEAM_MONEY_ROLLUP_VERSION = "team_money_rollup_v1";

function clean(value, max = 220) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}
function upperCurrency(value) { return (clean(value,16) || "USD").toUpperCase(); }
function asBigInt(value) { try { return BigInt(value || 0); } catch (_) { return 0n; } }
function utcDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function hashId(prefix, values) {
  return `${prefix}_${createHash("md5").update(values.map((v) => String(v ?? "")).join("\u001f")).digest("hex")}`;
}
function dailyIdentity(row) {
  return {
    agencyId: row.agencyId, memberId: row.memberId, creatorKey: row.creatorKey,
    sourceType: row.sourceType, currency: row.currency, day: row.day,
  };
}
function lifetimeIdentity(row) {
  return {
    agencyId: row.agencyId, memberId: row.memberId, creatorKey: row.creatorKey,
    sourceType: row.sourceType, currency: row.currency,
  };
}
function rollupBucketLockKeys(...rows) {
  const keys = new Set();
  for (const row of rows) {
    if (!row?.active) continue;
    const daily = dailyIdentity(row);
    const lifetime = lifetimeIdentity(row);
    const day = utcDay(daily.day);
    if (!daily.agencyId || !daily.memberId || !daily.creatorKey || !daily.sourceType || !daily.currency || !day) {
      throw Object.assign(new Error("TEAM_MONEY_ROLLUP_BUCKET_IDENTITY_REQUIRED"), { code: "TEAM_MONEY_ROLLUP_BUCKET_IDENTITY_REQUIRED" });
    }
    const prefix = [daily.agencyId, daily.memberId, daily.creatorKey, daily.sourceType, daily.currency];
    keys.add(`team-money-rollup-bucket:daily:${[...prefix, day.toISOString().slice(0, 10)].join("\u001f")}`);
    keys.add(`team-money-rollup-bucket:lifetime:${prefix.join("\u001f")}`);
  }
  return Array.from(keys).sort();
}
async function lockRollupBuckets(tx, previous, next) {
  if (typeof tx?.$executeRawUnsafe !== "function") return [];
  const keys = rollupBucketLockKeys(previous, next);
  // A49/A20 fresh-source closure: different facts can move between the same two
  // aggregate buckets in opposite directions on different replicas. Per-fact
  // locks do not serialize that case, so acquire every affected bucket in one
  // deterministic global order before touching any rollup row.
  for (const key of keys) await lockDbAdvisoryXact({ db: tx, key, mode: "exclusive" });
  return keys;
}
function desiredContribution(fact) {
  const agencyId = clean(fact?.agencyId,160);
  const sourceFactId = clean(fact?.id,220);
  if (!agencyId || !sourceFactId) throw Object.assign(new Error("TEAM_MONEY_FACT_IDENTITY_REQUIRED"), { code: "TEAM_MONEY_FACT_IDENTITY_REQUIRED" });
  const memberId = clean(fact?.memberId,160);
  const creatorId = clean(fact?.creatorId,160);
  const sourceType = clean(fact?.sourceType,20)?.toUpperCase() || null;
  const day = utcDay(fact?.occurredAt);
  const active = String(fact?.classificationState || "") === "CANONICAL"
    && fact?.attributionActive === true && Boolean(memberId) && Boolean(sourceType) && Boolean(day);
  const row = {
    agencyId, sourceFactId, active,
    memberId: active ? memberId : null,
    creatorId: active ? creatorId : null,
    creatorKey: active ? (creatorId || "__none__") : "__none__",
    sourceType: active ? sourceType : null,
    currency: active ? upperCurrency(fact?.currency) : null,
    day: active ? day : null,
    amountCents: active ? asBigInt(fact?.amountCents) : 0n,
  };
  row.factFingerprint = createHash("sha256").update(JSON.stringify({
    active: row.active, memberId: row.memberId, creatorId: row.creatorId, sourceType: row.sourceType,
    currency: row.currency, day: row.day?.toISOString?.() || null, amountCents: row.amountCents.toString(),
    businessStatus: clean(fact?.businessStatus,80), financialStatus: clean(fact?.financialStatus,80),
    sourceUpdatedAt: fact?.sourceUpdatedAt instanceof Date ? fact.sourceUpdatedAt.toISOString() : String(fact?.sourceUpdatedAt || ""),
    classificationState: clean(fact?.classificationState,40),
  })).digest("hex");
  return row;
}

async function subtractOldContribution(tx, old) {
  if (!old?.active) return;
  const daily = await tx.teamMoneyDailyRollup.updateMany({
    where: dailyIdentity(old),
    data: { amountCents: { decrement: asBigInt(old.amountCents) }, factCount: { decrement: 1 } },
  });
  const lifetime = await tx.teamMoneyLifetimeRollup.updateMany({
    where: lifetimeIdentity(old),
    data: { amountCents: { decrement: asBigInt(old.amountCents) }, factCount: { decrement: 1 } },
  });
  if (Number(daily?.count || 0) !== 1 || Number(lifetime?.count || 0) !== 1) {
    const error = new Error("TEAM_MONEY_ROLLUP_OLD_CONTRIBUTION_MISSING");
    error.code = "TEAM_MONEY_ROLLUP_OLD_CONTRIBUTION_MISSING";
    throw error;
  }
}

async function addNewContribution(tx, next) {
  if (!next.active) return;
  const d = dailyIdentity(next); const l = lifetimeIdentity(next);
  await tx.teamMoneyDailyRollup.upsert({
    where: { agencyId_memberId_creatorKey_sourceType_currency_day: d },
    create: {
      id: hashId("tmdr", [d.agencyId,d.memberId,d.creatorKey,d.sourceType,d.currency,d.day.toISOString()]),
      ...d, creatorId: next.creatorId, amountCents: next.amountCents, factCount: 1, projectionVersion: TEAM_MONEY_ROLLUP_VERSION,
    },
    update: { creatorId: next.creatorId, amountCents: { increment: next.amountCents }, factCount: { increment: 1 }, projectionVersion: TEAM_MONEY_ROLLUP_VERSION },
  });
  await tx.teamMoneyLifetimeRollup.upsert({
    where: { agencyId_memberId_creatorKey_sourceType_currency: l },
    create: {
      id: hashId("tmlr", [l.agencyId,l.memberId,l.creatorKey,l.sourceType,l.currency]),
      ...l, creatorId: next.creatorId, amountCents: next.amountCents, factCount: 1, projectionVersion: TEAM_MONEY_ROLLUP_VERSION,
    },
    update: { creatorId: next.creatorId, amountCents: { increment: next.amountCents }, factCount: { increment: 1 }, projectionVersion: TEAM_MONEY_ROLLUP_VERSION },
  });
}

async function applyTeamMoneyFactToRollups({ db = prisma, agencyId, factId } = {}) {
  agencyId = clean(agencyId,160); factId = clean(factId,220);
  if (!agencyId || !factId) throw Object.assign(new Error("TEAM_MONEY_FACT_IDENTITY_REQUIRED"), { code: "TEAM_MONEY_FACT_IDENTITY_REQUIRED" });
  return runDbTransaction(db, async (tx) => {
    if (typeof tx?.$executeRawUnsafe === "function") {
      await lockDbAdvisoryXact({ db: tx, key: `team-money-rollup:${agencyId}:${factId}`, mode: "exclusive" });
    }
    const fact = await tx.teamMoneyAttributionFact.findFirst({ where: { id: factId, agencyId } });
    if (!fact) return { ok: true, obsolete: true, changed: false };
    const next = desiredContribution(fact);
    const existing = await tx.teamMoneyRollupContribution.findUnique({ where: { sourceFactId: factId } });
    if (existing && String(existing.factFingerprint) === next.factFingerprint) {
      return { ok: true, changed: false, idempotent: true, contribution: existing };
    }
    await lockRollupBuckets(tx, existing, next);
    if (existing) await subtractOldContribution(tx, existing);
    await addNewContribution(tx, next);
    const contribution = await tx.teamMoneyRollupContribution.upsert({
      where: { sourceFactId: factId },
      create: {
        id: hashId("tmrc", [agencyId,factId]), agencyId, sourceFactId: factId,
        factFingerprint: next.factFingerprint, active: next.active, memberId: next.memberId,
        creatorKey: next.creatorKey, creatorId: next.creatorId, sourceType: next.sourceType,
        currency: next.currency, day: next.day, amountCents: next.amountCents,
        projectionVersion: TEAM_MONEY_ROLLUP_VERSION,
      },
      update: {
        agencyId, factFingerprint: next.factFingerprint, active: next.active, memberId: next.memberId,
        creatorKey: next.creatorKey, creatorId: next.creatorId, sourceType: next.sourceType,
        currency: next.currency, day: next.day, amountCents: next.amountCents,
        projectionVersion: TEAM_MONEY_ROLLUP_VERSION,
      },
    });
    return { ok: true, changed: true, contribution };
  });
}

module.exports = {
  TEAM_MONEY_ROLLUP_VERSION,
  desiredContribution,
  rollupBucketLockKeys,
  applyTeamMoneyFactToRollups,
};
