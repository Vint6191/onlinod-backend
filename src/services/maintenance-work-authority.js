"use strict";

const { randomUUID } = require("node:crypto");
const prisma = require("../prisma");
const { withDbAdvisoryXactLock, runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

const DEFAULT_LEASE_MS = 15 * 60 * 1000;

function laneLockKey(key) { return `phase2-maintenance-lane:${String(key || "").trim()}`; }
function clean(value, max = 240) { const out = String(value ?? "").trim(); return out ? out.slice(0, max) : null; }
function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (!value) return null;
  const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function asBigInt(value, fallback = 0n) { try { return BigInt(value == null ? fallback : value); } catch (_) { return BigInt(fallback); } }

async function activateMaintenanceLaneGeneration({ db = prisma, key, generation, expectedGeneration = null, fallbackNow = new Date() } = {}) {
  const laneKey = clean(key, 180); const nextGeneration = clean(generation, 120);
  if (!laneKey || !nextGeneration) throw Object.assign(new Error("MAINTENANCE_LANE_IDENTITY_REQUIRED"), { code: "MAINTENANCE_LANE_IDENTITY_REQUIRED" });
  return withDbAdvisoryXactLock({ db, key: laneLockKey(laneKey), work: async (tx) => {
    if (!tx?.maintenanceLaneState?.findUnique || !tx?.maintenanceLaneState?.upsert) return { activated: false, skipped: true, reason: "maintenance_lane_schema_unavailable" };
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const existing = await tx.maintenanceLaneState.findUnique({ where: { key: laneKey } });
    const active = clean(existing?.activeGeneration || existing?.generation, 120);
    if (expectedGeneration != null && active && active !== String(expectedGeneration)) {
      return { activated: false, skipped: true, reason: "active_generation_changed", activeGeneration: active };
    }
    if (existing?.ownerToken && asDate(existing.leaseUntil) && asDate(existing.leaseUntil) > authorityNow) {
      return { activated: false, skipped: true, reason: "lease_held", activeGeneration: active, leaseUntil: existing.leaseUntil };
    }
    const row = await tx.maintenanceLaneState.upsert({
      where: { key: laneKey },
      create: { key: laneKey, generation: nextGeneration, activeGeneration: nextGeneration, claimFence: 0n, ownerToken: null, leaseUntil: authorityNow, nextRunAt: null, completedAt: null, cursor: null, progress: null, lastRunAt: authorityNow, lastOutcome: "GENERATION_ACTIVATED", lastError: null },
      update: { generation: nextGeneration, activeGeneration: nextGeneration, ownerToken: null, leaseUntil: authorityNow, nextRunAt: null, completedAt: null, cursor: null, progress: null, lastRunAt: authorityNow, lastOutcome: "GENERATION_ACTIVATED", lastError: null },
    });
    return { activated: true, key: laneKey, generation: nextGeneration, activeGeneration: row.activeGeneration || nextGeneration };
  }});
}

async function claimMaintenanceLane({ db = prisma, key, generation, ownerToken = randomUUID(), fallbackNow = new Date(), leaseMs = DEFAULT_LEASE_MS, oneTime = false } = {}) {
  const laneKey = clean(key, 180); const laneGeneration = clean(generation, 120);
  if (!laneKey || !laneGeneration) throw Object.assign(new Error("MAINTENANCE_LANE_IDENTITY_REQUIRED"), { code: "MAINTENANCE_LANE_IDENTITY_REQUIRED" });
  return withDbAdvisoryXactLock({ db, key: laneLockKey(laneKey), work: async (tx) => {
    if (!tx?.maintenanceLaneState?.findUnique || !tx?.maintenanceLaneState?.upsert) return { acquired: false, skipped: true, reason: "maintenance_lane_schema_unavailable", key: laneKey, generation: laneGeneration };
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const existing = await tx.maintenanceLaneState.findUnique({ where: { key: laneKey } });
    const activeGeneration = clean(existing?.activeGeneration || existing?.generation, 120);
    if (existing && activeGeneration && activeGeneration !== laneGeneration) {
      return { acquired: false, skipped: true, reason: "inactive_generation", key: laneKey, generation: laneGeneration, activeGeneration };
    }
    const sameGeneration = existing && String(existing.generation || "") === laneGeneration;
    if (sameGeneration && oneTime && existing.completedAt) return { acquired: false, skipped: true, reason: "generation_complete", key: laneKey, generation: laneGeneration, completedAt: existing.completedAt };
    if (sameGeneration) {
      const nextRunAt = asDate(existing.nextRunAt);
      if (nextRunAt && nextRunAt > authorityNow) return { acquired: false, skipped: true, reason: "not_due", key: laneKey, generation: laneGeneration, nextRunAt };
      const leaseUntil = asDate(existing.leaseUntil);
      if (existing.ownerToken && leaseUntil && leaseUntil > authorityNow) return { acquired: false, skipped: true, reason: "lease_held", key: laneKey, generation: laneGeneration, leaseUntil };
    }
    const nextLeaseUntil = new Date(authorityNow.getTime() + Math.max(60_000, Number(leaseMs) || DEFAULT_LEASE_MS));
    const nextFence = asBigInt(existing?.claimFence) + 1n;
    const row = await tx.maintenanceLaneState.upsert({
      where: { key: laneKey },
      create: { key: laneKey, generation: laneGeneration, activeGeneration: laneGeneration, claimFence: 1n, ownerToken, leaseUntil: nextLeaseUntil, nextRunAt: null, completedAt: null, cursor: null, progress: null, lastRunAt: authorityNow, lastOutcome: "RUNNING", lastError: null },
      update: { generation: laneGeneration, activeGeneration: laneGeneration, claimFence: nextFence, ownerToken, leaseUntil: nextLeaseUntil, nextRunAt: null, completedAt: existing?.completedAt || null, cursor: existing?.cursor || null, progress: existing?.progress || null, lastRunAt: authorityNow, lastOutcome: "RUNNING", lastError: null },
    });
    return { acquired: true, skipped: false, key: laneKey, generation: laneGeneration, activeGeneration: row.activeGeneration || laneGeneration, ownerToken, claimFence: row.claimFence ?? nextFence, authorityNow, leaseUntil: row.leaseUntil || nextLeaseUntil, cursor: row.cursor || null, progress: row.progress || null };
  }});
}

function ownershipWhere({ key, generation, ownerToken, claimFence, authorityNow, requireUnexpired = true }) {
  const where = { key, generation, activeGeneration: generation, ownerToken, claimFence };
  if (requireUnexpired) where.leaseUntil = { gt: authorityNow };
  return where;
}

async function heartbeatMaintenanceLane({ db = prisma, key, generation, ownerToken, claimFence, fallbackNow = new Date(), leaseMs = DEFAULT_LEASE_MS, cursor, progress } = {}) {
  if (!ownerToken || claimFence == null) return { renewed: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    if (!tx?.maintenanceLaneState?.updateMany) return { renewed: false, lost: true };
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const leaseUntil = new Date(authorityNow.getTime() + Math.max(60_000, Number(leaseMs) || DEFAULT_LEASE_MS));
    const data = { leaseUntil, lastRunAt: authorityNow, lastOutcome: "RUNNING" };
    if (cursor !== undefined) data.cursor = cursor;
    if (progress !== undefined) data.progress = progress;
    const updated = await tx.maintenanceLaneState.updateMany({ where: ownershipWhere({ key, generation, ownerToken, claimFence, authorityNow }), data });
    if (Number(updated?.count || 0) !== 1) return { renewed: false, lost: true, authorityNow };
    return { renewed: true, lost: false, authorityNow, leaseUntil };
  });
}

async function finishMaintenanceLane({ db = prisma, key, generation, ownerToken, claimFence, complete = false, nextRunAt = null, outcome = "COMPLETE", error = null, cursor, progress, fallbackNow = new Date() } = {}) {
  if (!ownerToken || claimFence == null) return false;
  return runDbTransaction(db, async (tx) => {
    if (!tx?.maintenanceLaneState?.updateMany) return false;
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const data = { ownerToken: null, leaseUntil: authorityNow, nextRunAt: nextRunAt || null, completedAt: complete ? authorityNow : null, lastRunAt: authorityNow, lastOutcome: clean(outcome, 120) || "COMPLETE", lastError: error ? String(error?.message || error).slice(0, 2000) : null };
    if (cursor !== undefined) data.cursor = cursor;
    if (progress !== undefined) data.progress = progress;
    const updated = await tx.maintenanceLaneState.updateMany({ where: ownershipWhere({ key, generation, ownerToken, claimFence, authorityNow }), data });
    return Number(updated?.count || 0) === 1;
  });
}

async function runMaintenanceLane({ db = prisma, key, generation, oneTime = false, leaseMs = DEFAULT_LEASE_MS, minIntervalMs = 0, fallbackNow = new Date(), work } = {}) {
  if (typeof work !== "function") throw new TypeError("runMaintenanceLane requires work");
  const claim = await claimMaintenanceLane({ db, key, generation, oneTime, leaseMs, fallbackNow });
  if (!claim.acquired) return claim;
  const heartbeat = (options = {}) => heartbeatMaintenanceLane({ db, key: claim.key, generation: claim.generation, ownerToken: claim.ownerToken, claimFence: claim.claimFence, leaseMs, fallbackNow: options.fallbackNow || new Date(), cursor: options.cursor, progress: options.progress });
  try {
    const result = await work({ claim, db, heartbeat });
    const renewed = await heartbeat({ fallbackNow: new Date() });
    if (!renewed?.renewed) throw Object.assign(new Error("MAINTENANCE_LANE_OWNERSHIP_LOST"), { code: "MAINTENANCE_LANE_OWNERSHIP_LOST" });
    const complete = oneTime && result?.complete === true;
    const authorityNow = await dbAuthorityNow({ db, fallbackNow: new Date() });
    const requestedNextRunAt = asDate(result?.nextRunAt);
    const next = complete ? null : requestedNextRunAt || (minIntervalMs <= 0 ? null : new Date(authorityNow.getTime() + Math.max(1_000, Number(minIntervalMs) || 0)));
    const finished = await finishMaintenanceLane({ db, key: claim.key, generation: claim.generation, ownerToken: claim.ownerToken, claimFence: claim.claimFence, complete, nextRunAt: next, outcome: result?.outcome || (complete ? "COMPLETE" : "BATCH_COMPLETE"), cursor: result?.cursor, progress: result?.progress, fallbackNow: authorityNow });
    if (!finished) throw Object.assign(new Error("MAINTENANCE_LANE_OWNERSHIP_LOST"), { code: "MAINTENANCE_LANE_OWNERSHIP_LOST" });
    return { ...result, acquired: true, skipped: false, key: claim.key, generation: claim.generation, claimFence: claim.claimFence, complete };
  } catch (error) {
    if (String(error?.code || "") !== "MAINTENANCE_LANE_OWNERSHIP_LOST") {
      try {
        const authorityNow = await dbAuthorityNow({ db, fallbackNow: new Date() });
        const retryAt = new Date(authorityNow.getTime() + Math.max(60_000, Math.min(15 * 60 * 1000, Number(minIntervalMs) || 60_000)));
        await finishMaintenanceLane({ db, key: claim.key, generation: claim.generation, ownerToken: claim.ownerToken, claimFence: claim.claimFence, complete: false, nextRunAt: retryAt, outcome: "FAILED", error, fallbackNow: authorityNow });
      } catch (_) {}
    }
    throw error;
  }
}

module.exports = { DEFAULT_LEASE_MS, activateMaintenanceLaneGeneration, claimMaintenanceLane, heartbeatMaintenanceLane, finishMaintenanceLane, runMaintenanceLane };
