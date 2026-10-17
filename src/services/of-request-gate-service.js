"use strict";

const { assertProviderBillingAccess } = require("./billing-execution-access-service");
const { isCreatorLifecycleContention } = require("./creator-lifecycle-contention");

// All provider starts use current billing. Durable readback is a separate,
// device/member/operation-bound read permission, never a generic unpaid lane.
function readJobBillingAdmission(entry) {
  return assertProviderBillingAccess({ db: prisma, ...entry });
}

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { requireCreatorAccess, canAccessCreator } = require("../middleware/automation-permissions");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { capabilityFreshnessWindow } = require("./capability-freshness-authority-service");
const {
  PROVIDER_GATE_PERMIT_TTL_MS,
  PROVIDER_GATE_WAITER_LEASE_MS,
  PROVIDER_GATE_WAITER_HEARTBEAT_MS,
  PROVIDER_GATE_FAIRNESS_GENERATION,
  readProviderGateFairnessAuthority,
  registerDurableProviderWaiter,
  heartbeatDurableProviderWaiters,
  cancelDurableProviderWaiter,
  tryAcquireDurableProviderPermit,
  acknowledgeDurableProviderStarted,
  cancelDurableProviderPermit,
} = require("./provider-request-credit-authority-service");

// Every creator owns one distributed start timeline across all tasks/devices.
// The permit/started handshake retains 700ms spacing even with network jitter;
// an unacknowledged permit blocks only its creator until fail-safe expiry.
// Local coordinators wake HTTP waiters independently. PostgreSQL owns grants,
// weighted priority and FIFO order inside each creator on every replica.
const DEFAULT_INTERVAL_MS = 700;
const MAX_WAIT_MS = 60_000;
// Backpressure is local resource admission. PostgreSQL remains the authority
// for the 700ms creator timeline and FIFO/priority across all replicas.
const {
  PROVIDER_GATE_MAX_PENDING: MAX_PENDING_REQUESTS,
  PROVIDER_GATE_MAX_PENDING_PER_DEVICE: MAX_PENDING_PER_DEVICE,
  PROVIDER_GATE_MAX_PENDING_PER_CREATOR: MAX_PENDING_PER_CREATOR,
} = require("./provider-gate-resource-limits");
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
let stopping = false;
let stopPromise = null;
let stopController = new AbortController();
let waiterHeartbeatTimer = null;
let heartbeatFlight = null;
const pendingEntries = new Set();
const pendingByDevice = new Map();
const pendingByCreator = new Map();
function pendingDeviceKey(entry) { return JSON.stringify([entry.agencyId, entry.userId, entry.deviceId]); }
function changePendingCount(map, key, delta) {
  const count = (map.get(key) || 0) + delta;
  if (count > 0) map.set(key, count); else map.delete(key);
}
function assertQueueCapacity(entry) {
  if (pendingEntries.size >= MAX_PENDING_REQUESTS
    || (pendingByDevice.get(pendingDeviceKey(entry)) || 0) >= MAX_PENDING_PER_DEVICE
    || (pendingByCreator.get(creatorQueueKey(entry.agencyId, entry.creatorId)) || 0) >= MAX_PENDING_PER_CREATOR) {
    throw Object.assign(new Error("Provider request queue is full; retry after current requests progress"), {
      code: "OF_GATE_QUEUE_CAPACITY", status: 503, retryable: true, retryAfterMs: 1000,
    });
  }
}
function addPendingEntry(entry) {
  pendingEntries.add(entry);
  changePendingCount(pendingByDevice, pendingDeviceKey(entry), 1);
  changePendingCount(pendingByCreator, creatorQueueKey(entry.agencyId, entry.creatorId), 1);
}
function removePendingEntry(entry) {
  if (!pendingEntries.delete(entry)) return;
  changePendingCount(pendingByDevice, pendingDeviceKey(entry), -1);
  changePendingCount(pendingByCreator, creatorQueueKey(entry.agencyId, entry.creatorId), -1);
}
const backgroundFlights = new Set();
function stoppingError() { return Object.assign(new Error("BACKEND_STOPPING"), { code: "BACKEND_STOPPING", status: 503 }); }
function trackWork(promise) {
  const flight = Promise.resolve(promise).finally(() => backgroundFlights.delete(flight));
  backgroundFlights.add(flight);
  void flight.catch(() => undefined);
  return flight;
}
function assertEntryCurrent(entry) {
  if (stopping) throw stoppingError();
  if (entry.cancelled || entry.signal?.aborted) throw Object.assign(new Error("Creator OF gate request was cancelled"), { code: "OF_GATE_CANCELLED" });
}

const coordinators = new Map();
function coordinatorFor(agencyId, creatorId) {
  const key = creatorQueueKey(agencyId, creatorId);
  let value = coordinators.get(key);
  if (!value) {
    value = { ...createCoordinator(), key, agencyId, creatorId };
    coordinators.set(key, value);
  }
  if (value.cleanupTimer) clearTimeout(value.cleanupTimer);
  value.cleanupTimer = null;
  return value;
}
function createCoordinator() {
return {
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
  retryTimer: null,
  cleanupTimer: null,
  runningEntryId: null,
  runningWaiterRegistered: false,
  fairnessActivationState: "UNAVAILABLE",
  fairnessGeneration: PROVIDER_GATE_FAIRNESS_GENERATION,
};
}
function retireCoordinatorWhenIdle(coordinator) {
  if (coordinator.running || coordinator.activePermit || queueLength(coordinator) || coordinator.retryTimer) return;
  if (coordinator.cleanupTimer) clearTimeout(coordinator.cleanupTimer);
  // In-memory fixtures must also preserve the creator's last spacing deadline.
  const delay = Math.max(1000, coordinator.nextAllowedAt - Date.now() + 1);
  coordinator.cleanupTimer = setTimeout(() => {
    coordinator.cleanupTimer = null;
    if (!coordinator.running && !coordinator.activePermit && !queueLength(coordinator)
      && !coordinator.retryTimer && coordinators.get(coordinator.key) === coordinator) coordinators.delete(coordinator.key);
  }, delay);
  coordinator.cleanupTimer.unref?.();
}

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
function bucketFor(coordinator, priority) { return coordinator.buckets.get(priority); }
function enqueue(entry) {
  const bucket = bucketFor(entry.coordinator, entry.priority);
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
function takeFromPriority(coordinator, priority) {
  const bucket = bucketFor(coordinator, priority);
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
function queueLength(coordinator) {
  let total = 0;
  for (const bucket of coordinator.buckets.values()) {
    for (const queue of bucket.byCreator.values()) total += queue.filter((entry) => !entry.cancelled).length;
  }
  return total;
}
function takeSpecific(coordinator, waiterId) {
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
function takeNext(coordinator) {
  if (coordinator.durableSelectedWaiterId) {
    const selected = takeSpecific(coordinator, coordinator.durableSelectedWaiterId);
    if (selected) {
      coordinator.durableSelectedWaiterId = null;
      return selected;
    }
  }
  for (let step = 0; step < PRIORITY_CYCLE.length; step += 1) {
    const index = (coordinator.priorityCursor + step) % PRIORITY_CYCLE.length;
    const priority = PRIORITY_CYCLE[index];
    const entry = takeFromPriority(coordinator, priority);
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
  return [...pendingEntries].filter(entry => entry.waiterRegistered && !entry.cancelled && !entry.settled).map(entry => entry.id);
}
function stopWaiterHeartbeatIfIdle() {
  if (!waiterHeartbeatTimer || liveLocalWaiterIds().length) return;
  clearInterval(waiterHeartbeatTimer);
  waiterHeartbeatTimer = null;
}
function ensureWaiterHeartbeat() {
  if (stopping || !durableGateAvailable() || waiterHeartbeatTimer) return;
  waiterHeartbeatTimer = setInterval(() => {
    if (stopping || heartbeatFlight) return;
    const waiterIds = liveLocalWaiterIds();
    if (!waiterIds.length) {
      stopWaiterHeartbeatIfIdle();
      return;
    }
    heartbeatFlight = trackWork(heartbeatDurableProviderWaiters({
      db: prisma,
      ownerInstanceId: BACKEND_INSTANCE_ID,
      waiterIds,
      waiterTtlMs: PROVIDER_GATE_WAITER_LEASE_MS,
    }).catch(() => null)).finally(() => { heartbeatFlight = null; });
  }, PROVIDER_GATE_WAITER_HEARTBEAT_MS);
  waiterHeartbeatTimer.unref?.();
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
  if (signal?.aborted) return Promise.reject(stopping ? stoppingError() : Object.assign(new Error("OF_GATE_CANCELLED"), { code: "OF_GATE_CANCELLED" }));
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
      const error = new Error("Creator OF gate request was cancelled");
      error.code = "OF_GATE_CANCELLED";
      finish(error);
    };
    const timer = setTimeout(() => finish(), delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function clearActivePermit(coordinator, permit) {
  if (permit?.expiryTimer) clearTimeout(permit.expiryTimer);
  if (coordinator.activePermit?.id === permit?.id) coordinator.activePermit = null;
}

function expirePermit(coordinator, permit) {
  if (coordinator.activePermit?.id !== permit.id) return;
  clearActivePermit(coordinator, permit);
  // The client may have started transport but lost the acknowledgement. Wait an
  // extra creator interval before granting another permit; this fails safe.
  coordinator.nextAllowedAt = Math.max(coordinator.nextAllowedAt, Date.now() + permit.intervalMs);
  coordinator.revision += 1;
  setImmediate(() => pump(coordinator));
}

function pump(coordinator) {
  if (stopping) return;
  const durable = durableGateAvailable();
  if (coordinator.running || (!durable && coordinator.activePermit)) return;
  const entry = takeNext(coordinator);
  if (!entry) { retireCoordinatorWhenIdle(coordinator); return; }
  coordinator.running = true;
  coordinator.runningEntryId = entry.id;
  let durableRetryAtMs = 0;
  let durableGranted = false;
  trackWork((async () => {
    try {
      let permit;
      let preGrantElapsedMs = 0;
      if (durable) {
        coordinator.durableSelectedWaiterId = null;
        if (entry.cancelled || entry.signal?.aborted) {
          const error = new Error("Creator OF gate request was cancelled");
          error.code = "OF_GATE_CANCELLED";
          throw error;
        }
        const fairness = await readProviderGateFairnessAuthority({ db: prisma, creatorId: entry.creatorId });
        assertEntryCurrent(entry);
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
            if (stopping || entry.cancelled || entry.signal?.aborted) {
              await cancelDurableProviderWaiter({ db: prisma, waiterId: entry.id, ownerInstanceId: BACKEND_INSTANCE_ID }).catch(() => null);
              entry.waiterRegistered = false;
              coordinator.runningWaiterRegistered = false;
              assertEntryCurrent(entry);
            }
            ensureWaiterHeartbeat();
          }
          // Measure only time known to precede the successful grant transaction.
          // Its execution and response transit must still count against the TTL.
          preGrantElapsedMs = Math.max(0, Math.floor(performance.now() - entry.acquireStartedMono));
          admission = await tryAcquireDurableProviderPermit({
            db: prisma, waiterId: entry.id, permitId, ownerInstanceId: BACKEND_INSTANCE_ID,
            agencyId: entry.agencyId, creatorId: entry.creatorId, deviceId: entry.deviceId,
            capability: entry.capability, intervalMs: entry.intervalMs, permitTtlMs: PERMIT_TTL_MS,
          });
        } else {
          throw Object.assign(new Error("Provider queue schema is unavailable"), { code: "OF_PROVIDER_GATE_NOT_READY", status: 503 });
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
        durableGranted = true;
        entry.waiterRegistered = false;
        coordinator.runningWaiterRegistered = false;
        if (entry.cancelled || entry.signal?.aborted) {
          await cancelDurableProviderPermit({
            db: prisma, permitId, agencyId: entry.agencyId, creatorId: entry.creatorId,
            deviceId: entry.deviceId, capability: entry.capability,
          }).catch(() => null);
          const error = new Error("Creator OF gate request was cancelled after durable grant");
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
          if (coordinator.activePermit?.id === permit.id) clearActivePermit(coordinator, permit);
          retireCoordinatorWhenIdle(coordinator);
        }, Math.max(0, permit.expiresAt - Date.now()) + 50);
        permit.expiryTimer.unref?.();
      } else {
        await waitUntil(Math.max(Date.now(), coordinator.nextAllowedAt || 0), AbortSignal.any([stopController.signal, ...(entry.signal ? [entry.signal] : [])]));
        if (entry.cancelled) return;
        preGrantElapsedMs = Math.max(0, Math.floor(performance.now() - entry.acquireStartedMono));
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
        permit.expiryTimer = setTimeout(() => expirePermit(coordinator, permit), PERMIT_TTL_MS);
        permit.expiryTimer.unref?.();
      }
      // Admission can wait behind another replica or a long queue. Re-read
      // membership and billing after the durable grant; the entry-time check
      // and the device telemetry cache cannot authorize a later physical start.
      try {
        await requireGateAccess(entry);
        const billing = await readJobBillingAdmission(entry);
        if (billing?.validUntil) permit.expiresAt = Math.min(permit.expiresAt, billing.validUntil.getTime());
        assertEntryCurrent(entry);
      } catch (error) {
        clearTimeout(permit.expiryTimer);
        if (permit.durable) await cancelDurableProviderPermit({
          db: prisma, permitId: permit.id, agencyId: entry.agencyId, creatorId: entry.creatorId,
          deviceId: entry.deviceId, capability: entry.capability,
        }).catch(() => null);
        throw error;
      }
      // /started may have reached another replica. Replace its stale local hint
      // and timer only after PostgreSQL has admitted the next permit.
      if (coordinator.activePermit) clearActivePermit(coordinator, coordinator.activePermit);
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
        preGrantElapsedMs,
      });
    } catch (error) {
      // The creator NOWAIT trigger rejected the SQL statement/transaction, so
      // no permit was committed. Retry outside the rolled-back transaction,
      // keeping the original waiter identity, timeout and cancellation fences.
      if (durable && !durableGranted && isCreatorLifecycleContention(error)
        && !stopping && !entry.cancelled && !entry.signal?.aborted) {
        enqueue(entry);
        durableRetryAtMs = Date.now() + 500;
        return;
      }
      entry.reject(error);
    } finally {
      coordinator.running = false;
      coordinator.runningEntryId = null;
      coordinator.runningWaiterRegistered = false;
      stopWaiterHeartbeatIfIdle();
      if (stopping) return;
      if (durableRetryAtMs > 0) {
        const delay = Math.max(0, durableRetryAtMs - Date.now());
        if (coordinator.retryTimer) clearTimeout(coordinator.retryTimer);
        coordinator.retryTimer = setTimeout(() => { coordinator.retryTimer = null; pump(coordinator); }, delay);
      } else if (durable || !coordinator.activePermit) {
        setImmediate(() => pump(coordinator));
      }
    }
  })());
}

async function acquireOfRequestSlot(input) {
  const acquireStartedMono = performance.now();
  if (stopping) throw stoppingError();
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
  const billingContext = { userId, member: input.member, retirementSnapshot: input.retirementSnapshot || null, billingRecovery: input.billingRecovery || null, jobLease: input.jobLease || null, operationReadback: input.operationReadback || null, physicalRequest: input.physicalRequest || null };
  await readJobBillingAdmission({ ...billingContext, agencyId: access.agencyId, creatorId,
    deviceId: access.deviceId, capability, operation });
  if (stopping) throw stoppingError();
  assertQueueCapacity({ agencyId: access.agencyId, userId, creatorId, deviceId: access.deviceId });
  const coordinator = coordinatorFor(access.agencyId, creatorId);
  return new Promise((resolve, reject) => {
    const entry = {
      ...billingContext,
      coordinator,
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
      acquireStartedMono,
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
      removePendingEntry(entry);
      takeSpecific(coordinator, entry.id);
      entry.cancelled = true;
      clearTimeout(timer);
      entry.signal?.removeEventListener("abort", onAbort);
      if (durableGateAvailable() && entry.waiterRegistered === true) {
        trackWork(cancelDurableProviderWaiter({ db: prisma, waiterId: entry.id, ownerInstanceId: BACKEND_INSTANCE_ID }).catch(() => null));
        entry.waiterRegistered = false;
      }
      setImmediate(() => pump(coordinator));
      reject(error);
    };
    const onAbort = () => {
      const error = new Error("Creator OF gate request was cancelled");
      error.code = "OF_GATE_CANCELLED";
      settleReject(error);
    };
    addPendingEntry(entry);
    if (entry.signal?.aborted) return onAbort();
    entry.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`Timed out waiting for creator OF gate after ${timeoutMs}ms`);
      error.code = "OF_GATE_TIMEOUT";
      error.status = 503;
      settleReject(error);
    }, timeoutMs);
    entry.resolve = (value) => {
      if (entry.settled) return;
      entry.settled = true;
      removePendingEntry(entry);
      clearTimeout(timer);
      entry.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    entry.reject = settleReject;
    enqueue(entry);
    setImmediate(() => pump(coordinator));
  });
}

function stopOfRequestGate() {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopController.abort();
  if (waiterHeartbeatTimer) clearInterval(waiterHeartbeatTimer);
  waiterHeartbeatTimer = null;
  for (const entry of [...pendingEntries]) entry.reject(stoppingError());
  for (const coordinator of coordinators.values()) {
    if (coordinator.retryTimer) clearTimeout(coordinator.retryTimer);
    if (coordinator.cleanupTimer) clearTimeout(coordinator.cleanupTimer);
    coordinator.retryTimer = null;
    for (const bucket of coordinator.buckets.values()) { bucket.byCreator.clear(); bucket.order.length = 0; }
    // A delivered permit may already have crossed dispatch. Only remove hints.
    clearActivePermit(coordinator, coordinator.activePermit);
  }
  stopPromise = (async () => {
    while (backgroundFlights.size) await Promise.allSettled([...backgroundFlights]);
    coordinators.clear();
  })();
  return stopPromise;
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
  const coordinator = coordinatorFor(access.agencyId, creatorId);
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
    if (permit?.id === permitId) clearActivePermit(coordinator, permit);
    coordinator.lastStartedAt = started.startedAt.getTime();
    coordinator.nextAllowedAt = started.nextAllowedAt.getTime();
    coordinator.lastDeviceId = access.deviceId;
    coordinator.lastCreatorId = creatorId;
    coordinator.revision = Math.max(coordinator.revision + 1, Number(started.revision || 0));
    setImmediate(() => pump(coordinator));
    return {
      startedAt: started.startedAt.toISOString(),
      nextAllowedAt: started.nextAllowedAt.toISOString(),
      revision: started.revision,
      intervalMs: started.intervalMs,
    };
  }
  const permit = coordinator.activePermit;
  if (!permit || permit.id !== permitId || permit.agencyId !== access.agencyId || permit.creatorId !== creatorId || permit.deviceId !== access.deviceId || permit.capability !== input.capability) {
    const error = new Error("Creator OF request permit is missing, expired or belongs to another device/capability");
    error.code = "OF_GATE_PERMIT_INVALID";
    error.status = 409;
    throw error;
  }
  const startedAtMs = Date.now();
  clearActivePermit(coordinator, permit);
  coordinator.lastStartedAt = startedAtMs;
  coordinator.nextAllowedAt = startedAtMs + permit.intervalMs;
  coordinator.lastDeviceId = access.deviceId;
  coordinator.lastCreatorId = creatorId;
  coordinator.revision += 1;
  setImmediate(() => pump(coordinator));
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
  const coordinator = coordinatorFor(access.agencyId, creatorId);
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
    if (result.cancelled && permit?.id === permitId) clearActivePermit(coordinator, permit);
    coordinator.revision = Math.max(coordinator.revision + (result.cancelled ? 1 : 0), Number(result.revision || 0));
    setImmediate(() => pump(coordinator));
    return result;
  }
  const permit = coordinator.activePermit;
  if (!permit || permit.id !== permitId || permit.agencyId !== access.agencyId || permit.creatorId !== creatorId || permit.deviceId !== access.deviceId || permit.capability !== input.capability) return { cancelled: false };
  clearActivePermit(coordinator, permit);
  coordinator.revision += 1;
  setImmediate(() => pump(coordinator));
  return { cancelled: true, revision: coordinator.revision };
}

function getOfRequestGateSnapshot(scope = null) {
  const byCreator = {}, activePermits = [];
  let queued = 0, running = false, revision = 0, latest = null;
  for (const coordinator of coordinators.values()) {
    if (scope && (coordinator.agencyId !== scope.agencyId || !canAccessCreator(scope.member, coordinator.creatorId))) continue;
    const byPriority = Object.fromEntries(PRIORITIES.map(priority => [priority, 0]));
    for (const priority of PRIORITIES) for (const queue of bucketFor(coordinator, priority).byCreator.values()) {
      byPriority[priority] += queue.filter(entry => !entry.cancelled).length;
    }
    const permit = coordinator.activePermit;
    const activePermit = permit ? { permitId: permit.id, creatorId: permit.creatorId, deviceId: permit.deviceId,
      priority: permit.priority, operation: permit.operation, capability: permit.capability,
      grantedAt: new Date(permit.grantedAt).toISOString() } : null;
    if (activePermit) activePermits.push(activePermit);
    const count = Object.values(byPriority).reduce((sum, value) => sum + value, 0);
    byCreator[coordinator.creatorId] = { queued: count, activePermit, byPriority,
      nextAllowedAt: coordinator.nextAllowedAt ? new Date(coordinator.nextAllowedAt).toISOString() : null,
      lastStartedAt: coordinator.lastStartedAt ? new Date(coordinator.lastStartedAt).toISOString() : null };
    queued += count; running ||= coordinator.running; revision += coordinator.revision;
    if (!latest || coordinator.lastStartedAt > latest.lastStartedAt) latest = coordinator;
  }
  return { scope: "CREATOR", intervalMs: DEFAULT_INTERVAL_MS, permitTtlMs: PERMIT_TTL_MS,
    coordinator: durableGateAvailable() ? "postgres_durable_creator_two_phase" : "single_backend_process_creator_two_phase",
    fairnessGeneration: PROVIDER_GATE_FAIRNESS_GENERATION,
    distributedAdapterRequiredForMultipleBackendInstances: !durableGateAvailable(), backendInstanceId: BACKEND_INSTANCE_ID,
    queued, running, activePermits, activePermit: activePermits.length === 1 ? activePermits[0] : null,
    nextAllowedAt: null, lastStartedAt: latest?.lastStartedAt ? new Date(latest.lastStartedAt).toISOString() : null,
    lastCreatorId: latest?.lastCreatorId || null, lastDeviceId: latest?.lastDeviceId || null,
    revision, activeCreators: Object.keys(byCreator).length, accessCacheEntries: scope ? null : accessCache.size, byCreator };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  PRIORITIES,
  acquireOfRequestSlot,
  acknowledgeOfRequestStarted,
  cancelOfRequestPermit,
  getOfRequestGateSnapshot,
  stopOfRequestGate,
  _test: {
    providerWaiterCategory,
    reset() {
      for (const coordinator of coordinators.values()) {
        if (coordinator.retryTimer) clearTimeout(coordinator.retryTimer);
        if (coordinator.cleanupTimer) clearTimeout(coordinator.cleanupTimer);
        if (coordinator.activePermit?.expiryTimer) clearTimeout(coordinator.activePermit.expiryTimer);
      }
      if (waiterHeartbeatTimer) clearInterval(waiterHeartbeatTimer);
      waiterHeartbeatTimer = null;
      stopping = false; stopPromise = null; stopController = new AbortController();
      heartbeatFlight = null; pendingEntries.clear(); pendingByDevice.clear(); pendingByCreator.clear(); backgroundFlights.clear();
      coordinators.clear(); accessCache.clear();
    },
  },
};
