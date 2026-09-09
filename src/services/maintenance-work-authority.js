"use strict";

const { randomUUID } = require("node:crypto");
const prisma = require("../prisma");
const { withDbAdvisoryXactLock, runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

const DEFAULT_LEASE_MS = 15 * 60 * 1000;

function laneLockKey(key) {
  return `phase2-maintenance-lane:${String(key || "").trim()}`;
}

function clean(value, max = 240) {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
}

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function claimMaintenanceLane({
  db = prisma,
  key,
  generation,
  ownerToken = randomUUID(),
  fallbackNow = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  oneTime = false,
} = {}) {
  const laneKey = clean(key, 180);
  const laneGeneration = clean(generation, 120);
  if (!laneKey || !laneGeneration) throw Object.assign(new Error("MAINTENANCE_LANE_IDENTITY_REQUIRED"), { code: "MAINTENANCE_LANE_IDENTITY_REQUIRED" });

  return withDbAdvisoryXactLock({
    db,
    key: laneLockKey(laneKey),
    work: async (tx) => {
      if (!tx?.maintenanceLaneState?.findUnique || !tx?.maintenanceLaneState?.upsert) {
        return { acquired: false, skipped: true, reason: "maintenance_lane_schema_unavailable", key: laneKey, generation: laneGeneration };
      }
      const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
      const existing = await tx.maintenanceLaneState.findUnique({ where: { key: laneKey } });
      const sameGeneration = existing && String(existing.generation || "") === laneGeneration;
      if (sameGeneration && oneTime && existing.completedAt) {
        return { acquired: false, skipped: true, reason: "generation_complete", key: laneKey, generation: laneGeneration, completedAt: existing.completedAt };
      }
      if (sameGeneration) {
        const nextRunAt = asDate(existing.nextRunAt);
        if (nextRunAt && nextRunAt > authorityNow) {
          return { acquired: false, skipped: true, reason: "not_due", key: laneKey, generation: laneGeneration, nextRunAt };
        }
        const leaseUntil = asDate(existing.leaseUntil);
        if (existing.ownerToken && leaseUntil && leaseUntil > authorityNow) {
          return { acquired: false, skipped: true, reason: "lease_held", key: laneKey, generation: laneGeneration, leaseUntil };
        }
      }
      const nextLeaseUntil = new Date(authorityNow.getTime() + Math.max(60_000, Number(leaseMs) || DEFAULT_LEASE_MS));
      const resetGeneration = !sameGeneration;
      const row = await tx.maintenanceLaneState.upsert({
        where: { key: laneKey },
        create: {
          key: laneKey,
          generation: laneGeneration,
          ownerToken,
          leaseUntil: nextLeaseUntil,
          nextRunAt: null,
          completedAt: null,
          cursor: null,
          progress: null,
          lastRunAt: authorityNow,
          lastOutcome: "RUNNING",
          lastError: null,
        },
        update: {
          generation: laneGeneration,
          ownerToken,
          leaseUntil: nextLeaseUntil,
          nextRunAt: null,
          completedAt: resetGeneration ? null : existing?.completedAt || null,
          cursor: resetGeneration ? null : existing?.cursor || null,
          progress: resetGeneration ? null : existing?.progress || null,
          lastRunAt: authorityNow,
          lastOutcome: "RUNNING",
          lastError: null,
        },
      });
      return {
        acquired: true,
        skipped: false,
        key: laneKey,
        generation: laneGeneration,
        ownerToken,
        authorityNow,
        leaseUntil: row.leaseUntil || nextLeaseUntil,
        cursor: row.cursor || null,
        progress: row.progress || null,
      };
    },
  });
}

async function heartbeatMaintenanceLane({ db = prisma, key, generation, ownerToken, fallbackNow = new Date(), leaseMs = DEFAULT_LEASE_MS, cursor, progress } = {}) {
  if (!ownerToken) return false;
  return runDbTransaction(db, async (tx) => {
    if (!tx?.maintenanceLaneState?.updateMany) return false;
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const leaseUntil = new Date(authorityNow.getTime() + Math.max(60_000, Number(leaseMs) || DEFAULT_LEASE_MS));
    const data = { leaseUntil, lastRunAt: authorityNow, lastOutcome: "RUNNING" };
    if (cursor !== undefined) data.cursor = cursor;
    if (progress !== undefined) data.progress = progress;
    const updated = await tx.maintenanceLaneState.updateMany({
      where: { key, generation, ownerToken, completedAt: null },
      data,
    });
    if (Number(updated?.count || 0) !== 1) throw Object.assign(new Error("MAINTENANCE_LANE_OWNERSHIP_LOST"), { code: "MAINTENANCE_LANE_OWNERSHIP_LOST" });
    return { renewed: true, authorityNow, leaseUntil };
  });
}

async function finishMaintenanceLane({
  db = prisma,
  key,
  generation,
  ownerToken,
  complete = false,
  nextRunAt = null,
  outcome = "COMPLETE",
  error = null,
  cursor,
  progress,
  fallbackNow = new Date(),
} = {}) {
  if (!ownerToken) return false;
  return runDbTransaction(db, async (tx) => {
    if (!tx?.maintenanceLaneState?.updateMany) return false;
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const data = {
      ownerToken: null,
      leaseUntil: authorityNow,
      nextRunAt: nextRunAt || null,
      completedAt: complete ? authorityNow : null,
      lastRunAt: authorityNow,
      lastOutcome: clean(outcome, 120) || "COMPLETE",
      lastError: error ? String(error?.message || error).slice(0, 2000) : null,
    };
    if (cursor !== undefined) data.cursor = cursor;
    if (progress !== undefined) data.progress = progress;
    const updated = await tx.maintenanceLaneState.updateMany({ where: { key, generation, ownerToken }, data });
    return Number(updated?.count || 0) === 1;
  });
}

async function runMaintenanceLane({
  db = prisma,
  key,
  generation,
  oneTime = false,
  leaseMs = DEFAULT_LEASE_MS,
  minIntervalMs = 0,
  fallbackNow = new Date(),
  work,
} = {}) {
  if (typeof work !== "function") throw new TypeError("runMaintenanceLane requires work");
  const claim = await claimMaintenanceLane({ db, key, generation, oneTime, leaseMs, fallbackNow });
  if (!claim.acquired) return claim;
  try {
    const result = await work({ claim, db });
    const complete = oneTime && result?.complete === true;
    const authorityNow = await dbAuthorityNow({ db, fallbackNow });
    const requestedNextRunAt = asDate(result?.nextRunAt);
    const nextRunAt = complete
      ? null
      : requestedNextRunAt || (minIntervalMs <= 0 ? null : new Date(authorityNow.getTime() + Math.max(1_000, Number(minIntervalMs) || 0)));
    await finishMaintenanceLane({
      db,
      key: claim.key,
      generation: claim.generation,
      ownerToken: claim.ownerToken,
      complete,
      nextRunAt,
      outcome: result?.outcome || (complete ? "COMPLETE" : "BATCH_COMPLETE"),
      cursor: result?.cursor,
      progress: result?.progress,
      fallbackNow: authorityNow,
    });
    return { ...result, acquired: true, skipped: false, key: claim.key, generation: claim.generation, complete };
  } catch (error) {
    try {
      const authorityNow = await dbAuthorityNow({ db, fallbackNow });
      const nextRunAt = new Date(authorityNow.getTime() + Math.max(60_000, Math.min(15 * 60 * 1000, Number(minIntervalMs) || 60_000)));
      await finishMaintenanceLane({
        db,
        key: claim.key,
        generation: claim.generation,
        ownerToken: claim.ownerToken,
        complete: false,
        nextRunAt,
        outcome: "FAILED",
        error,
        fallbackNow: authorityNow,
      });
    } catch (_) {}
    throw error;
  }
}

module.exports = {
  DEFAULT_LEASE_MS,
  claimMaintenanceLane,
  heartbeatMaintenanceLane,
  finishMaintenanceLane,
  runMaintenanceLane,
};
