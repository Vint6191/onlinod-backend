"use strict";

const { assertProviderBillingAccess } = require("./billing-execution-access-service");

// R13 cutover is the typed read-job lane. Interactive writes and their
// reconciliation reads require a separate drain contract before global billing
// enforcement can be activated. Never block their post-commit recovery here.
function readJobBillingAdmission(entry) {
  return entry.jobLease || entry.billingRecovery
    ? assertProviderBillingAccess({ db: prisma, ...entry }) : Promise.resolve(null);
}

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { capabilityFreshnessWindow } = require("./capability-freshness-authority-service");
const {
  PROVIDER_GATE_PERMIT_TTL_MS,
  PROVIDER_GATE_WAITER_LEASE_MS,
  PROVIDER_GATE_WAITER_HEARTBEAT_MS,
  PROVIDER_GATE_FAIRNESS_GENERATION,
  readProviderGateFairnessAuthority,
  tryAcquireLegacyCompatibleProviderPermit,
  registerDurableProviderWaiter,
  heartbeatDurableProviderWaiters,
  cancelDurableProviderWaiter,
  tryAcquireDurableProviderPermit,
  acknowledgeDurableProviderStarted,
  cancelDurableProviderPermit,
} = require("./provider-request-credit-authority-service");

// GLOBAL CREATOR REQUEST GATE
// ---------------------------
// Jobs may run concurrently on one or many Desktop devices, but every physical
// OnlyFans request start for one creator must pass through this boundary.
// The two-step permit/started handshake is deliberate: an acquire-only clock
// can be violated by network jitter (a later permit may arrive before an older
// one). The next permit is therefore blocked until the previous Desktop says
// that transport was actually started, and then for another 700ms.
//
// CURRENT DISTRIBUTED AUTHORITY:
// PostgreSQL always owns the physical two-phase singleton permit. A14 rolls the
// cross-replica waiter ordering in explicitly: DRAINING is legacy-compatible so
// an A12 binary can finish a mixed deployment without transient acquire errors;
// QUIESCING stops new A14 starts while legacy traffic drains; ACTIVE enables the
// starvation-resistant PostgreSQL waiter/ticket authority. Local memory is only
// a wake/poll optimization and never owns the physical 700ms chronology.
// Non-sticky /started or /cancel requests remain safe in every rollout state.
//
// A future Redis/dedicated coordinator may replace the durable state adapter,
// but it must preserve the same single permit authority and fail-safe unknown-
// outcome expiry semantics. Never add an independent per-device limiter.
const DEFAULT_INTERVAL_MS = 700;
const MAX_WAIT_MS = 60_000;
const PERMIT_TTL_MS = PROVIDER_GATE_PERMIT_TTL_MS;
const BACKEND_INSTANCE_ID = cleanInstanceId(process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME) || `backend-${crypto.randomUUID()}`;
const ACCESS_CACHE_TTL_MS = 60_000;
const PRIORITIES = ["critical_write", "interactive", "realtime", "normal", "background"];
const PRIORITY_CYCLE = [
  "critical_write", "critical_write", "critical_write",
  "interactive", "interactive",
  "realtime",
  "normal",
  "background",
];

const accessCache = new Map();

// One local coordinator only wakes local HTTP waiters; PostgreSQL owns global waiter order and every physical permit in production.
// The previous implementation had one 700ms clock per creator, which allowed
// many creators to start provider requests simultaneously. That made the
// advertised "global" gate and all fleet-capacity math false. Keep creator
// identity only as a fairness dimension inside each priority bucket; never as
// an independent physical clock.
const coordinator = {
  buckets: new Map(PRIORITIES.map((priority) => [priority, { byCreator: new Map(), order: [], cursor: 0, lastServedKey: null }])),
  priorityCursor: 0,
  running: false,
  activePermit: null,
  nextAllowedAt: 0,
  revision: 0,
  lastGrantedAt: 0,
  lastStartedAt: 0,
  lastDeviceId: null,
  lastCreatorId: null,
  durableSelectedWaiterId: null,
  waiterHeartbeatTimer: null,
  runningEntryId: null,
  runningWaiterRegistered: false,
  fairnessActivationState: "DRAINING",
  fairnessGeneration: PROVIDER_GATE_FAIRNESS_GENERATION,
};

function cleanInstanceId(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 180) : null;
}
function clean(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}
function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
function providerWaiterCategory({ priority, operation, source }) {
  if (priority !== "background") return "default";
  const op = clean(operation, 160);
  const src = clean(source, 240);
  if (op === "campaigns.list") return "campaign_directory";
  if (op === "campaigns.claimers") return "campaign_frontier";
  if (op === "users.profile" && src.startsWith("backend.readonly.fan_data_point_refresh")) return "fan_data";
  return "background_other";
}
function creatorQueueKey(agencyId, creatorId) { return `${agencyId}:${creatorId}`; }
function bucketFor(priority) { return coordinator.buckets.get(priority); }
function enqueue(entry) {
  const bucket = bucketFor(entry.priority);
  const key = creatorQueueKey(entry.agencyId, entry.creatorId);
  let queue = bucket.byCreator.get(key);
  if (!queue) {
    queue = [];
    bucket.byCreator.set(key, queue);
    bucket.order.push(key);
  }
  queue.push(entry);
}
function dropEmptyCreator(bucket, index, key) {
  bucket.byCreator.delete(key);
  bucket.order.splice(index, 1);
  bucket.cursor = bucket.order.length ? index % bucket.order.length : 0;
}
function takeFromPriority(priority) {
  const bucket = bucketFor(priority);
  let remaining = bucket.order.length;
  if (bucket.lastServedKey && bucket.order.length > 1) {
    const lastIndex = bucket.order.indexOf(bucket.lastServedKey);
    if (lastIndex >= 0) bucket.cursor = (lastIndex + 1) % bucket.order.length;
  }
  while (remaining > 0 && bucket.order.length) {
    remaining -= 1;
    const index = bucket.cursor % bucket.order.length;
    const key = bucket.order[index];
    const queue = bucket.byCreator.get(key) || [];
    while (queue.length && queue[0].cancelled) queue.shift();
    if (!queue.length) {
      dropEmptyCreator(bucket, index, key);
      continue;
    }
    const entry = queue.shift();
    bucket.lastServedKey = key;
    if (!queue.length) dropEmptyCreator(bucket, index, key);
    else bucket.cursor = (index + 1) % bucket.order.length;
    return entry;
  }
  return null;
}
function queueLength() {
  let total = 0;
  for (const bucket of coordinator.buckets.values()) {
    for (const queue of bucket.byCreator.values()) total += queue.filter((entry) => !entry.cancelled).length;
  }
  return total;
}
function takeSpecific(waiterId) {
  const target = clean(waiterId, 200);
  if (!target) return null;
  for (const bucket of coordinator.buckets.values()) {
    for (let orderIndex = 0; orderIndex < bucket.order.length; orderIndex += 1) {
      const key = bucket.order[orderIndex];
      const queue = bucket.byCreator.get(key) || [];
      const index = queue.findIndex((entry) => !entry.cancelled && entry.id === target);
      if (index < 0) continue;
      const [entry] = queue.splice(index, 1);
      if (!queue.length) dropEmptyCreator(bucket, orderIndex, key);
      return entry || null;
    }
  }
  return null;
}
function takeNext() {
  if (coordinator.durableSelectedWaiterId) {
    const selected = takeSpecific(coordinator.durableSelectedWaiterId);
    if (selected) {
      coordinator.durableSelectedWaiterId = null;
      return selected;
    }
  }
  for (let step = 0; step < PRIORITY_CYCLE.length; step += 1) {
    const index = (coordinator.priorityCursor + step) % PRIORITY_CYCLE.length;
    const priority = PRIORITY_CYCLE[index];
    const entry = takeFromPriority(priority);
    if (entry) {
      coordinator.priorityCursor = (index + 1) % PRIORITY_CYCLE.length;
      return entry;
    }
  }
  return null;
}
function accessKey(userId, deviceId, creatorId, capability) { return `${userId}:${deviceId}:${creatorId}:${capability}`; }
function pruneAccessCache(now = Date.now()) {
  if (accessCache.size < 2_000) return;
  for (const [key, value] of accessCache) if (value.expiresAt <= now) accessCache.delete(key);
  while (accessCache.size > 2_000) accessCache.delete(accessCache.keys().next().value);
}

function durableGateAvailable() {
  return typeof prisma?.$transaction === "function" && typeof prisma?.$queryRawUnsafe === "function";
}
function liveLocalWaiterIds() {
  const ids = new Set();
  if (coordinator.runningEntryId && coordinator.runningWaiterRegistered) ids.add(coordinator.runningEntryId);
  for (const bucket of coordinator.buckets.values()) {
    for (const queue of bucket.byCreator.values()) {
      for (const entry of queue) if (entry.waiterRegistered === true && !entry.cancelled && !entry.settled) ids.add(entry.id);
    }
  }
  return [...ids];
}
function stopWaiterHeartbeatIfIdle() {
  if (!coordinator.waiterHeartbeatTimer) return;
  if (queueLength() > 0 || coordinator.running) return;
  clearInterval(coordinator.waiterHeartbeatTimer);
  coordinator.waiterHeartbeatTimer = null;
}
function ensureWaiterHeartbeat() {
  if (!durableGateAvailable() || coordinator.waiterHeartbeatTimer) return;
  coordinator.waiterHeartbeatTimer = setInterval(() => {
    const waiterIds = liveLocalWaiterIds();
    if (!waiterIds.length) {
      stopWaiterHeartbeatIfIdle();
      return;
    }
    void heartbeatDurableProviderWaiters({
      db: prisma,
      ownerInstanceId: BACKEND_INSTANCE_ID,
      waiterIds,
      waiterTtlMs: PROVIDER_GATE_WAITER_LEASE_MS,
    }).catch(() => null);
  }, PROVIDER_GATE_WAITER_HEARTBEAT_MS);
  coordinator.waiterHeartbeatTimer.unref?.();
}


async function requireGateAccess({ userId, agencyId, member, deviceId, creatorId, capability = "read" }) {
  // Access is server-authoritative and intentionally checked on every request.
  // DeviceCreatorBinding is capability telemetry only and can never grant creator access.
  const creator = await requireCreatorAccess({ agencyId, member, creatorId, db: prisma });
  if (creator.status !== "READY") {
    const error = new Error("Creator is not enrolled for OnlyFans execution");
    error.code = "OF_GATE_CREATOR_NOT_ENROLLED";
    error.status = 409;
    throw error;
  }
  const normalizedCapability = ["security_probe", "read", "write"].includes(capability) ? capability : "read";
  const key = accessKey(userId, deviceId, creatorId, normalizedCapability);
  const nowMs = Date.now();
  const cached = accessCache.get(key);
  if (cached && cached.expiresAt > nowMs) return cached.value;

  let device = await prisma.workerDevice.findFirst({
    where: { id: deviceId, userId, agencyId },
    select: { id: true, agencyId: true, lastSeenAt: true },
  });
  if (!device) {
    const error = new Error("Worker device not found or does not belong to user");
    error.code = "OF_GATE_DEVICE_FORBIDDEN";
    error.status = 403;
    throw error;
  }
  if (normalizedCapability !== "security_probe") {
    // Capability telemetry is stamped by PostgreSQL at heartbeat receipt. Use
    // the same DB clock when deciding freshness so replica wall-clock skew
    // cannot disagree with Job claim admission. This runs only on cache miss.
    const authorityNow = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
    const freshnessWindow = capabilityFreshnessWindow(authorityNow, 5 * 60_000);
    if (!device.lastSeenAt || device.lastSeenAt < freshnessWindow.gte || device.lastSeenAt > freshnessWindow.lte) {
      const error = new Error("Worker device heartbeat is stale or future-poisoned");
      error.code = "OF_GATE_DEVICE_STALE";
      error.status = 409;
      throw error;
    }
    const binding = await prisma.deviceCreatorBinding.findFirst({
      where: {
        agencyId: device.agencyId,
        deviceId: device.id,
        creatorId,
        status: "ACTIVE",
        ...(normalizedCapability === "write" ? { sessionWriteReady: true } : { sessionReadReady: true }),
        lastSeenAt: freshnessWindow,
      },
      select: { id: true },
    });
    if (!binding) {
      const error = new Error(`Device has no fresh ${normalizedCapability === "write" ? "SESSION_WRITE" : "SESSION_READ"} capability for creator`);
      error.code = "OF_GATE_CREATOR_CONTEXT_MISSING";
      error.status = 409;
      throw error;
    }
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

function clearActivePermit(permit) {
  if (permit?.expiryTimer) clearTimeout(permit.expiryTimer);
  if (coordinator.activePermit?.id === permit?.id) coordinator.activePermit = null;
}

function expirePermit(permit) {
  if (coordinator.activePermit?.id !== permit.id) return;
  clearActivePermit(permit);
  // The client may have started transport but lost the acknowledgement. Wait an
  // extra global interval before granting another permit; this fails safe.
  coordinator.nextAllowedAt = Math.max(coordinator.nextAllowedAt, Date.now() + permit.intervalMs);
  coordinator.revision += 1;
  setImmediate(pump);
}

function pump() {
  const durable = durableGateAvailable();
  if (coordinator.running || (!durable && coordinator.activePermit)) return;
  const entry = takeNext();
  if (!entry) return;
  coordinator.running = true;
  coordinator.runningEntryId = entry.id;
  let durableRetryAtMs = 0;
  void (async () => {
    try {
      let permit;
      if (durable) {
        coordinator.durableSelectedWaiterId = null;
        if (entry.cancelled || entry.signal?.aborted) {
          const error = new Error("Global OF gate request was cancelled");
          error.code = "OF_GATE_CANCELLED";
          throw error;
        }
        const fairness = await readProviderGateFairnessAuthority({ db: prisma });
        coordinator.fairnessActivationState = fairness.activationState;
        coordinator.fairnessGeneration = fairness.generation || PROVIDER_GATE_FAIRNESS_GENERATION;
        let admission;
        const permitId = entry.id;
        if (fairness.activationState === "ACTIVE") {
          if (entry.waiterRegistered !== true) {
            await registerDurableProviderWaiter({
              db: prisma, waiterId: entry.id, ownerInstanceId: BACKEND_INSTANCE_ID,
              agencyId: entry.agencyId, creatorId: entry.creatorId, deviceId: entry.deviceId,
              capability: entry.capability, priority: entry.priority,
              category: providerWaiterCategory({ priority: entry.priority, operation: entry.operation, source: entry.source }),
              operation: entry.operation, source: entry.source, waiterTtlMs: PROVIDER_GATE_WAITER_LEASE_MS,
            });
            entry.waiterRegistered = true;
            coordinator.runningWaiterRegistered = true;
            ensureWaiterHeartbeat();
          }
          admission = await tryAcquireDurableProviderPermit({
            db: prisma, waiterId: entry.id, permitId, ownerInstanceId: BACKEND_INSTANCE_ID,
            agencyId: entry.agencyId, creatorId: entry.creatorId, deviceId: entry.deviceId,
            capability: entry.capability, intervalMs: entry.intervalMs, permitTtlMs: PERMIT_TTL_MS,
          });
        } else if (fairness.activationState === "QUIESCING") {
          admission = { granted: false, reason: "fairness_quiescing", retryAt: new Date(Date.now() + 250) };
        } else {
          admission = await tryAcquireLegacyCompatibleProviderPermit({
            db: prisma, permitId, ownerInstanceId: BACKEND_INSTANCE_ID, agencyId: entry.agencyId,
            creatorId: entry.creatorId, deviceId: entry.deviceId, capability: entry.capability,
            intervalMs: entry.intervalMs, permitTtlMs: PERMIT_TTL_MS,
          });
        }
        if (!admission.granted) {
          if (admission.reason === "waiter_missing") {
            entry.waiterRegistered = false;
            coordinator.runningWaiterRegistered = false;
            const error = new Error("Durable OF provider waiter expired or was removed before grant");
            error.code = "OF_GATE_WAITER_EXPIRED";
            error.status = 503;
            throw error;
          }
          if (admission.selectedWaiterId) coordinator.durableSelectedWaiterId = admission.selectedWaiterId;
          if (!entry.cancelled) enqueue(entry);
          durableRetryAtMs = admission.retryAt instanceof Date ? admission.retryAt.getTime() : Date.now() + 250;
          return;
        }
        entry.waiterRegistered = false;
        coordinator.runningWaiterRegistered = false;
        if (entry.cancelled || entry.signal?.aborted) {
          await cancelDurableProviderPermit({
            db: prisma, permitId, agencyId: entry.agencyId, creatorId: entry.creatorId,
            deviceId: entry.deviceId, capability: entry.capability,
          }).catch(() => null);
          const error = new Error("Global OF gate request was cancelled after durable grant");
          error.code = "OF_GATE_CANCELLED";
          throw error;
        }
        permit = {
          id: permitId,
          agencyId: entry.agencyId,
          creatorId: entry.creatorId,
          deviceId: entry.deviceId,
          priority: entry.priority,
          operation: entry.operation,
          source: entry.source,
          capability: entry.capability,
          intervalMs: admission.intervalMs,
          grantedAt: admission.grantedAt.getTime(),
          expiresAt: admission.expiresAt.getTime(),
          expiryTimer: null,
          durable: true,
        };
        // Informational local cleanup only. PostgreSQL remains the permit owner;
        // this timer never advances spacing or grants work.
        permit.expiryTimer = setTimeout(() => {
          if (coordinator.activePermit?.id === permit.id) clearActivePermit(permit);
        }, Math.max(0, permit.expiresAt - Date.now()) + 50);
        permit.expiryTimer.unref?.();
      } else {
        await waitUntil(Math.max(Date.now(), coordinator.nextAllowedAt || 0), entry.signal);
        if (entry.cancelled) return;
        permit = {
          id: crypto.randomUUID(),
          agencyId: entry.agencyId,
          creatorId: entry.creatorId,
          deviceId: entry.deviceId,
          priority: entry.priority,
          operation: entry.operation,
          source: entry.source,
          capability: entry.capability,
          intervalMs: entry.intervalMs,
          grantedAt: Date.now(),
          expiresAt: Date.now() + PERMIT_TTL_MS,
          expiryTimer: null,
          durable: false,
        };
        permit.expiryTimer = setTimeout(() => expirePermit(permit), PERMIT_TTL_MS);
        permit.expiryTimer.unref?.();
      }
      // Admission can wait behind another replica or a long queue. Re-read
      // membership and billing after the durable grant; the entry-time check
      // and the device telemetry cache cannot authorize a later physical start.
      try {
        await requireGateAccess(entry);
        const billing = await readJobBillingAdmission(entry);
        if (billing?.validUntil) permit.expiresAt = Math.min(permit.expiresAt, billing.validUntil.getTime());
      } catch (error) {
        clearTimeout(permit.expiryTimer);
        if (permit.durable) await cancelDurableProviderPermit({
          db: prisma, permitId: permit.id, agencyId: entry.agencyId, creatorId: entry.creatorId,
          deviceId: entry.deviceId, capability: entry.capability,
        }).catch(() => null);
        throw error;
      }
      coordinator.activePermit = permit;
      coordinator.lastGrantedAt = permit.grantedAt;
      coordinator.lastDeviceId = entry.deviceId;
      coordinator.lastCreatorId = entry.creatorId;
      coordinator.revision += 1;
      entry.resolve({
        permitId: permit.id,
        grantedAt: new Date(permit.grantedAt).toISOString(),
        expiresAt: new Date(permit.expiresAt).toISOString(),
        revision: coordinator.revision,
        intervalMs: permit.intervalMs,
        capability: entry.capability,
        queueWaitMs: Math.max(0, Date.now() - entry.enqueuedAt),
      });
    } catch (error) {
      entry.reject(error);
    } finally {
      coordinator.running = false;
      coordinator.runningEntryId = null;
      coordinator.runningWaiterRegistered = false;
      stopWaiterHeartbeatIfIdle();
      if (durableRetryAtMs > 0) {
        const delay = Math.max(0, durableRetryAtMs - Date.now());
        setTimeout(pump, delay);
      } else if (durable || !coordinator.activePermit) {
        setImmediate(pump);
      }
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
    capability: input.capability,
  });
  const entryId = crypto.randomUUID();
  const capability = ["security_probe", "read", "write"].includes(input.capability) ? input.capability : "read";
  const operation = clean(input.operation, 160) || "unknown";
  const source = clean(input.source, 240) || null;
  const billingContext = { userId, member: input.member, billingRecovery: input.billingRecovery || null, jobLease: input.jobLease || null };
  await readJobBillingAdmission({ ...billingContext, agencyId: access.agencyId, creatorId,
    deviceId: access.deviceId, capability, operation });
  return new Promise((resolve, reject) => {
    const entry = {
      ...billingContext,
      id: entryId,
      agencyId: access.agencyId,
      creatorId,
      deviceId: access.deviceId,
      priority,
      operation,
      source,
      capability,
      intervalMs,
      waiterRegistered: false,
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
      if (durableGateAvailable() && entry.waiterRegistered === true) {
        void cancelDurableProviderWaiter({ db: prisma, waiterId: entry.id, ownerInstanceId: BACKEND_INSTANCE_ID }).catch(() => null);
        entry.waiterRegistered = false;
      }
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
    enqueue(entry);
    setImmediate(pump);
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
    capability: input.capability,
  });
  if (durableGateAvailable()) {
    const started = await acknowledgeDurableProviderStarted({
      db: prisma,
      permitId,
      agencyId: access.agencyId,
      creatorId,
      deviceId: access.deviceId,
      capability: input.capability,
    });
    const permit = coordinator.activePermit;
    if (permit?.id === permitId) clearActivePermit(permit);
    coordinator.lastStartedAt = started.startedAt.getTime();
    coordinator.nextAllowedAt = started.nextAllowedAt.getTime();
    coordinator.lastDeviceId = access.deviceId;
    coordinator.lastCreatorId = creatorId;
    coordinator.revision = Math.max(coordinator.revision + 1, Number(started.revision || 0));
    setImmediate(pump);
    return {
      startedAt: started.startedAt.toISOString(),
      nextAllowedAt: started.nextAllowedAt.toISOString(),
      revision: started.revision,
      intervalMs: started.intervalMs,
    };
  }
  const permit = coordinator.activePermit;
  if (!permit || permit.id !== permitId || permit.agencyId !== access.agencyId || permit.creatorId !== creatorId || permit.deviceId !== access.deviceId || permit.capability !== input.capability) {
    const error = new Error("Global OF request permit is missing, expired or belongs to another device/capability");
    error.code = "OF_GATE_PERMIT_INVALID";
    error.status = 409;
    throw error;
  }
  const startedAtMs = Date.now();
  clearActivePermit(permit);
  coordinator.lastStartedAt = startedAtMs;
  coordinator.nextAllowedAt = startedAtMs + permit.intervalMs;
  coordinator.lastDeviceId = access.deviceId;
  coordinator.lastCreatorId = creatorId;
  coordinator.revision += 1;
  setImmediate(pump);
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    nextAllowedAt: new Date(coordinator.nextAllowedAt).toISOString(),
    revision: coordinator.revision,
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
    capability: input.capability,
  });
  if (durableGateAvailable()) {
    const result = await cancelDurableProviderPermit({
      db: prisma,
      permitId,
      agencyId: access.agencyId,
      creatorId,
      deviceId: access.deviceId,
      capability: input.capability,
    });
    const permit = coordinator.activePermit;
    if (result.cancelled && permit?.id === permitId) clearActivePermit(permit);
    coordinator.revision = Math.max(coordinator.revision + (result.cancelled ? 1 : 0), Number(result.revision || 0));
    setImmediate(pump);
    return result;
  }
  const permit = coordinator.activePermit;
  if (!permit || permit.id !== permitId || permit.agencyId !== access.agencyId || permit.creatorId !== creatorId || permit.deviceId !== access.deviceId || permit.capability !== input.capability) return { cancelled: false };
  clearActivePermit(permit);
  coordinator.revision += 1;
  setImmediate(pump);
  return { cancelled: true, revision: coordinator.revision };
}

function getOfRequestGateSnapshot() {
  const byCreator = {};
  const ensureCreator = (creatorId) => {
    if (!byCreator[creatorId]) {
      byCreator[creatorId] = {
        queued: 0,
        activePermit: null,
        byPriority: Object.fromEntries(PRIORITIES.map((priority) => [priority, 0])),
      };
    }
    return byCreator[creatorId];
  };
  for (const priority of PRIORITIES) {
    const bucket = bucketFor(priority);
    for (const queue of bucket.byCreator.values()) {
      for (const entry of queue) {
        if (entry.cancelled) continue;
        const row = ensureCreator(entry.creatorId);
        row.queued += 1;
        row.byPriority[priority] += 1;
      }
    }
  }
  if (coordinator.activePermit) {
    const row = ensureCreator(coordinator.activePermit.creatorId);
    row.activePermit = {
      permitId: coordinator.activePermit.id,
      deviceId: coordinator.activePermit.deviceId,
      priority: coordinator.activePermit.priority,
      operation: coordinator.activePermit.operation,
      capability: coordinator.activePermit.capability,
      grantedAt: new Date(coordinator.activePermit.grantedAt).toISOString(),
    };
  }
  return {
    intervalMs: DEFAULT_INTERVAL_MS,
    permitTtlMs: PERMIT_TTL_MS,
    coordinator: durableGateAvailable()
      ? (coordinator.fairnessActivationState === "ACTIVE" ? "postgres_durable_waiter_weighted_fair_global_two_phase" : "postgres_rolling_legacy_compatible_global_two_phase")
      : "single_backend_process_global_two_phase_creator_round_robin",
    fairnessGeneration: coordinator.fairnessGeneration,
    fairnessActivationState: coordinator.fairnessActivationState,
    distributedAdapterRequiredForMultipleBackendInstances: !durableGateAvailable(),
    backendInstanceId: BACKEND_INSTANCE_ID,
    queued: queueLength(),
    running: coordinator.running,
    activePermit: coordinator.activePermit ? {
      permitId: coordinator.activePermit.id,
      creatorId: coordinator.activePermit.creatorId,
      deviceId: coordinator.activePermit.deviceId,
      priority: coordinator.activePermit.priority,
      operation: coordinator.activePermit.operation,
      capability: coordinator.activePermit.capability,
      grantedAt: new Date(coordinator.activePermit.grantedAt).toISOString(),
    } : null,
    nextAllowedAt: coordinator.nextAllowedAt ? new Date(coordinator.nextAllowedAt).toISOString() : null,
    lastGrantedAt: coordinator.lastGrantedAt ? new Date(coordinator.lastGrantedAt).toISOString() : null,
    lastStartedAt: coordinator.lastStartedAt ? new Date(coordinator.lastStartedAt).toISOString() : null,
    lastDeviceId: coordinator.lastDeviceId,
    lastCreatorId: coordinator.lastCreatorId,
    revision: coordinator.revision,
    activeCreators: Object.keys(byCreator).length,
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
    providerWaiterCategory,
    reset() {
      if (coordinator.activePermit?.expiryTimer) clearTimeout(coordinator.activePermit.expiryTimer);
      if (coordinator.waiterHeartbeatTimer) clearInterval(coordinator.waiterHeartbeatTimer);
      coordinator.buckets = new Map(PRIORITIES.map((priority) => [priority, { byCreator: new Map(), order: [], cursor: 0, lastServedKey: null }]));
      coordinator.priorityCursor = 0;
      coordinator.running = false;
      coordinator.activePermit = null;
      coordinator.nextAllowedAt = 0;
      coordinator.revision = 0;
      coordinator.lastGrantedAt = 0;
      coordinator.lastStartedAt = 0;
      coordinator.lastDeviceId = null;
      coordinator.lastCreatorId = null;
      coordinator.durableSelectedWaiterId = null;
      coordinator.waiterHeartbeatTimer = null;
      coordinator.runningEntryId = null;
      coordinator.runningWaiterRegistered = false;
      coordinator.fairnessActivationState = "DRAINING";
      coordinator.fairnessGeneration = PROVIDER_GATE_FAIRNESS_GENERATION;
      accessCache.clear();
    },
  },
};
