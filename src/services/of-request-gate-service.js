"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { requireCreatorAccess } = require("../middleware/automation-permissions");

// GLOBAL CREATOR REQUEST GATE
// ---------------------------
// Jobs may run concurrently on one or many Desktop devices, but every physical
// OnlyFans request start for one creator must pass through this boundary.
// The two-step permit/started handshake is deliberate: an acquire-only clock
// can be violated by network jitter (a later permit may arrive before an older
// one). The next permit is therefore blocked until the previous Desktop says
// that transport was actually started, and then for another 700ms.
//
// CURRENT LOW-COST DEPLOYMENT:
// Render runs one backend process, so queue state lives in memory and creates no
// per-request PostgreSQL writes. This avoids recreating the Neon resource issue.
//
// FUTURE SERVER/DISTRIBUTED MIGRATION FOUNDATION:
// Keep this API boundary. If ONLINOD later runs several backend instances or
// server-side OF workers, replace only the state adapter with Redis/a dedicated
// coordinator. Never add an independent per-device limiter.
const DEFAULT_INTERVAL_MS = 700;
const MAX_WAIT_MS = 60_000;
const PERMIT_TTL_MS = 15_000;
const ACCESS_CACHE_TTL_MS = 60_000;
const LANE_IDLE_TTL_MS = 5 * 60_000;
const PRIORITIES = ["critical_write", "interactive", "realtime", "normal", "background"];
const PRIORITY_CYCLE = [
  "critical_write", "critical_write", "critical_write",
  "interactive", "interactive",
  "realtime",
  "normal",
  "background",
];

const lanes = new Map();
const accessCache = new Map();

function clean(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}
function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
function laneKey(agencyId, creatorId) { return `${agencyId}:${creatorId}`; }
function getLane(agencyId, creatorId) {
  const key = laneKey(agencyId, creatorId);
  let lane = lanes.get(key);
  if (lane) {
    if (lane.cleanupTimer) {
      clearTimeout(lane.cleanupTimer);
      lane.cleanupTimer = null;
    }
    return lane;
  }
  lane = {
    key,
    agencyId,
    creatorId,
    queues: new Map(PRIORITIES.map((priority) => [priority, []])),
    cursor: 0,
    running: false,
    activePermit: null,
    nextAllowedAt: 0,
    revision: 0,
    lastGrantedAt: 0,
    lastStartedAt: 0,
    lastDeviceId: null,
    cleanupTimer: null,
  };
  lanes.set(key, lane);
  return lane;
}
function queueLength(lane) {
  let total = 0;
  for (const queue of lane.queues.values()) total += queue.length;
  return total;
}
function takeNext(lane) {
  for (let step = 0; step < PRIORITY_CYCLE.length; step += 1) {
    const index = (lane.cursor + step) % PRIORITY_CYCLE.length;
    const priority = PRIORITY_CYCLE[index];
    const queue = lane.queues.get(priority);
    while (queue?.length) {
      const entry = queue.shift();
      if (!entry.cancelled) {
        lane.cursor = (index + 1) % PRIORITY_CYCLE.length;
        return entry;
      }
    }
  }
  return null;
}
function accessKey(userId, deviceId, creatorId) { return `${userId}:${deviceId}:${creatorId}`; }
function pruneAccessCache(now = Date.now()) {
  if (accessCache.size < 2_000) return;
  for (const [key, value] of accessCache) if (value.expiresAt <= now) accessCache.delete(key);
  while (accessCache.size > 2_000) accessCache.delete(accessCache.keys().next().value);
}

async function requireGateAccess({ userId, agencyId, member, deviceId, creatorId }) {
  // Access is server-authoritative and intentionally checked on every request.
  // DeviceCreatorBinding is capability telemetry only and can never grant creator access.
  const creator = await requireCreatorAccess({ agencyId, member, creatorId, db: prisma });
  if (creator.status !== "READY") {
    const error = new Error("Creator is not enrolled for OnlyFans execution");
    error.code = "OF_GATE_CREATOR_NOT_ENROLLED";
    error.status = 409;
    throw error;
  }
  const key = accessKey(userId, deviceId, creatorId);
  const nowMs = Date.now();
  const cached = accessCache.get(key);
  if (cached && cached.expiresAt > nowMs) return cached.value;

  const device = await prisma.workerDevice.findFirst({
    where: { id: deviceId, userId, agencyId },
    select: { id: true, agencyId: true, lastSeenAt: true },
  });
  if (!device) {
    const error = new Error("Worker device not found or does not belong to user");
    error.code = "OF_GATE_DEVICE_FORBIDDEN";
    error.status = 403;
    throw error;
  }
  const freshAfter = new Date(nowMs - 5 * 60_000);
  const binding = await prisma.deviceCreatorBinding.findFirst({
    where: {
      agencyId: device.agencyId,
      deviceId: device.id,
      creatorId,
      status: "ACTIVE",
      sessionReadReady: true,
      lastSeenAt: { gte: freshAfter },
    },
    select: { id: true },
  });
  if (!binding) {
    const error = new Error("Device has no fresh SESSION_READ capability for creator");
    error.code = "OF_GATE_CREATOR_CONTEXT_MISSING";
    error.status = 409;
    throw error;
  }
  const value = { agencyId: device.agencyId, deviceId: device.id };
  pruneAccessCache(nowMs);
  accessCache.set(key, { value, expiresAt: nowMs + ACCESS_CACHE_TTL_MS });
  return value;
}

function waitUntil(targetMs, signal) {
  const delay = Math.max(0, targetMs - Date.now());
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => {
      const error = new Error("Global OF gate request was cancelled");
      error.code = "OF_GATE_CANCELLED";
      finish(error);
    };
    const timer = setTimeout(() => finish(), delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function scheduleLaneCleanup(lane) {
  if (lane.cleanupTimer || lane.running || lane.activePermit || queueLength(lane) > 0) return;
  const delay = Math.max(
    DEFAULT_INTERVAL_MS,
    Math.min(LANE_IDLE_TTL_MS, Math.max(0, lane.nextAllowedAt - Date.now()) + DEFAULT_INTERVAL_MS),
  );
  lane.cleanupTimer = setTimeout(() => {
    lane.cleanupTimer = null;
    if (!lane.running && !lane.activePermit && queueLength(lane) === 0 && Date.now() >= lane.nextAllowedAt) {
      lanes.delete(lane.key);
    } else {
      scheduleLaneCleanup(lane);
    }
  }, delay);
  lane.cleanupTimer.unref?.();
}

function clearActivePermit(lane, permit) {
  if (permit?.expiryTimer) clearTimeout(permit.expiryTimer);
  if (lane.activePermit?.id === permit?.id) lane.activePermit = null;
}

function expirePermit(lane, permit) {
  if (lane.activePermit?.id !== permit.id) return;
  clearActivePermit(lane, permit);
  // The client may have started transport but lost the acknowledgement. Wait an
  // extra interval before granting another permit; this fails safe, not fast.
  lane.nextAllowedAt = Math.max(lane.nextAllowedAt, Date.now() + permit.intervalMs);
  lane.revision += 1;
  setImmediate(() => pump(lane));
}

function pump(lane) {
  if (lane.running || lane.activePermit) return;
  const entry = takeNext(lane);
  if (!entry) {
    scheduleLaneCleanup(lane);
    return;
  }
  lane.running = true;
  void (async () => {
    try {
      await waitUntil(Math.max(Date.now(), lane.nextAllowedAt || 0), entry.signal);
      if (entry.cancelled) return;
      const permit = {
        id: crypto.randomUUID(),
        deviceId: entry.deviceId,
        priority: entry.priority,
        operation: entry.operation,
        source: entry.source,
        intervalMs: entry.intervalMs,
        grantedAt: Date.now(),
        expiryTimer: null,
      };
      permit.expiryTimer = setTimeout(() => expirePermit(lane, permit), PERMIT_TTL_MS);
      permit.expiryTimer.unref?.();
      lane.activePermit = permit;
      lane.lastGrantedAt = permit.grantedAt;
      lane.lastDeviceId = entry.deviceId;
      lane.revision += 1;
      entry.resolve({
        permitId: permit.id,
        grantedAt: new Date(permit.grantedAt).toISOString(),
        expiresAt: new Date(permit.grantedAt + PERMIT_TTL_MS).toISOString(),
        revision: lane.revision,
        intervalMs: entry.intervalMs,
        queueWaitMs: Math.max(0, Date.now() - entry.enqueuedAt),
      });
    } catch (error) {
      entry.reject(error);
    } finally {
      lane.running = false;
      if (!lane.activePermit) setImmediate(() => pump(lane));
    }
  })();
}

async function acquireOfRequestSlot(input) {
  const creatorId = clean(input.creatorId, 200);
  const deviceId = clean(input.deviceId, 200);
  const userId = clean(input.userId, 200);
  const priority = PRIORITIES.includes(input.priority) ? input.priority : "normal";
  const intervalMs = clampInt(input.intervalMs, DEFAULT_INTERVAL_MS, DEFAULT_INTERVAL_MS, 60_000);
  const timeoutMs = clampInt(input.timeoutMs, MAX_WAIT_MS, 5_000, MAX_WAIT_MS);
  if (!creatorId || !deviceId || !userId) {
    const error = new Error("creatorId, deviceId and userId are required");
    error.code = "OF_GATE_SCOPE_REQUIRED";
    error.status = 400;
    throw error;
  }
  const access = await requireGateAccess({
    userId,
    agencyId: clean(input.agencyId, 200),
    member: input.member,
    deviceId,
    creatorId,
  });
  const lane = getLane(access.agencyId, creatorId);

  return new Promise((resolve, reject) => {
    const entry = {
      id: crypto.randomUUID(),
      deviceId: access.deviceId,
      priority,
      operation: clean(input.operation, 160) || "unknown",
      source: clean(input.source, 240) || null,
      intervalMs,
      enqueuedAt: Date.now(),
      signal: input.signal || null,
      cancelled: false,
      settled: false,
      resolve,
      reject,
    };
    let timer = null;
    const settleReject = (error) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.cancelled = true;
      clearTimeout(timer);
      entry.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      const error = new Error("Global OF gate request was cancelled");
      error.code = "OF_GATE_CANCELLED";
      settleReject(error);
    };
    if (entry.signal?.aborted) return onAbort();
    entry.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`Timed out waiting for global OF gate after ${timeoutMs}ms`);
      error.code = "OF_GATE_TIMEOUT";
      error.status = 503;
      settleReject(error);
    }, timeoutMs);
    entry.resolve = (value) => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(timer);
      entry.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    entry.reject = settleReject;
    lane.queues.get(priority).push(entry);
    setImmediate(() => pump(lane));
  });
}

async function acknowledgeOfRequestStarted(input) {
  const creatorId = clean(input.creatorId, 200);
  const deviceId = clean(input.deviceId, 200);
  const userId = clean(input.userId, 200);
  const permitId = clean(input.permitId, 200);
  if (!creatorId || !deviceId || !userId || !permitId) {
    const error = new Error("creatorId, deviceId, userId and permitId are required");
    error.code = "OF_GATE_PERMIT_SCOPE_REQUIRED";
    error.status = 400;
    throw error;
  }
  const access = await requireGateAccess({
    userId,
    agencyId: clean(input.agencyId, 200),
    member: input.member,
    deviceId,
    creatorId,
  });
  const lane = getLane(access.agencyId, creatorId);
  const permit = lane.activePermit;
  if (!permit || permit.id !== permitId || permit.deviceId !== access.deviceId) {
    const error = new Error("Global OF request permit is missing, expired or belongs to another device");
    error.code = "OF_GATE_PERMIT_INVALID";
    error.status = 409;
    throw error;
  }
  const startedAtMs = Date.now();
  clearActivePermit(lane, permit);
  lane.lastStartedAt = startedAtMs;
  lane.nextAllowedAt = startedAtMs + permit.intervalMs;
  lane.lastDeviceId = access.deviceId;
  lane.revision += 1;
  setImmediate(() => pump(lane));
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    nextAllowedAt: new Date(lane.nextAllowedAt).toISOString(),
    revision: lane.revision,
    intervalMs: permit.intervalMs,
  };
}

async function cancelOfRequestPermit(input) {
  const creatorId = clean(input.creatorId, 200);
  const deviceId = clean(input.deviceId, 200);
  const userId = clean(input.userId, 200);
  const permitId = clean(input.permitId, 200);
  if (!creatorId || !deviceId || !userId || !permitId) return { cancelled: false };
  const access = await requireGateAccess({
    userId,
    agencyId: clean(input.agencyId, 200),
    member: input.member,
    deviceId,
    creatorId,
  });
  const lane = getLane(access.agencyId, creatorId);
  const permit = lane.activePermit;
  if (!permit || permit.id !== permitId || permit.deviceId !== access.deviceId) return { cancelled: false };
  clearActivePermit(lane, permit);
  lane.revision += 1;
  setImmediate(() => pump(lane));
  return { cancelled: true, revision: lane.revision };
}

function getOfRequestGateSnapshot() {
  const byCreator = {};
  for (const lane of lanes.values()) {
    byCreator[lane.creatorId] = {
      queued: queueLength(lane),
      running: lane.running,
      activePermit: lane.activePermit ? {
        permitId: lane.activePermit.id,
        deviceId: lane.activePermit.deviceId,
        priority: lane.activePermit.priority,
        operation: lane.activePermit.operation,
        grantedAt: new Date(lane.activePermit.grantedAt).toISOString(),
      } : null,
      nextAllowedAt: lane.nextAllowedAt ? new Date(lane.nextAllowedAt).toISOString() : null,
      lastGrantedAt: lane.lastGrantedAt ? new Date(lane.lastGrantedAt).toISOString() : null,
      lastStartedAt: lane.lastStartedAt ? new Date(lane.lastStartedAt).toISOString() : null,
      lastDeviceId: lane.lastDeviceId,
      revision: lane.revision,
      byPriority: Object.fromEntries(PRIORITIES.map((priority) => [priority, lane.queues.get(priority).length])),
    };
  }
  return {
    intervalMs: DEFAULT_INTERVAL_MS,
    permitTtlMs: PERMIT_TTL_MS,
    coordinator: "single_backend_process_memory_two_phase",
    distributedAdapterRequiredForMultipleBackendInstances: true,
    activeCreators: lanes.size,
    accessCacheEntries: accessCache.size,
    byCreator,
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  PRIORITIES,
  acquireOfRequestSlot,
  acknowledgeOfRequestStarted,
  cancelOfRequestPermit,
  getOfRequestGateSnapshot,
  _test: {
    reset() {
      for (const lane of lanes.values()) {
        if (lane.cleanupTimer) clearTimeout(lane.cleanupTimer);
        if (lane.activePermit?.expiryTimer) clearTimeout(lane.activePermit.expiryTimer);
      }
      lanes.clear();
      accessCache.clear();
    },
  },
};
