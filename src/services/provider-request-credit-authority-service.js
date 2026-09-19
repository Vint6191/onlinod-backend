"use strict";

const { runDbTransaction } = require("./db-transaction-service");

const PROVIDER_GATE_STATE_ID = "of-global";
const PROVIDER_GATE_POLL_MS = Math.max(100, Math.min(2_000, Number.parseInt(process.env.OF_PROVIDER_GATE_POLL_MS || "250", 10) || 250));
const PROVIDER_GATE_PERMIT_TTL_MS = Math.max(5_000, Math.min(60_000, Number.parseInt(process.env.OF_PROVIDER_GATE_PERMIT_TTL_MS || "15000", 10) || 15_000));
const PROVIDER_GATE_WAITER_LEASE_MS = Math.max(10_000, Math.min(60_000, Number.parseInt(process.env.OF_PROVIDER_GATE_WAITER_LEASE_MS || "20000", 10) || 20_000));
const PROVIDER_GATE_WAITER_HEARTBEAT_MS = Math.max(2_000, Math.min(Math.floor(PROVIDER_GATE_WAITER_LEASE_MS / 2), Number.parseInt(process.env.OF_PROVIDER_GATE_WAITER_HEARTBEAT_MS || "5000", 10) || 5_000));
const PROVIDER_GATE_FAIRNESS_GENERATION = "phase3_provider_gate_fairness_v2_a14";
const PROVIDER_GATE_FAIRNESS_STATES = Object.freeze(["DRAINING", "QUIESCING", "ACTIVE"]);
const PROVIDER_GATE_LEGACY_QUIET_MS = Math.max(15_000, Math.min(5 * 60_000, Number.parseInt(process.env.OF_PROVIDER_GATE_LEGACY_QUIET_MS || String(PROVIDER_GATE_PERMIT_TTL_MS * 2), 10) || (PROVIDER_GATE_PERMIT_TTL_MS * 2)));

// Preserve the A11 weighted user-facing priority policy, but make the cursor
// PostgreSQL-owned so two Backend replicas cannot each restart the cycle.
const PROVIDER_GATE_PRIORITY_CYCLE = Object.freeze([
  "critical_write", "critical_write", "critical_write",
  "interactive", "interactive",
  "realtime",
  "normal",
  "background",
]);
// Background provider work has its own durable credit cycle. Campaign frontier
// and FanData receive two shares because they are the causal freshness drain;
// directory discovery is independently SLA/admission bounded by A10, while
// unrelated background reads retain a guaranteed turn.
const PROVIDER_GATE_BACKGROUND_CATEGORY_CYCLE = Object.freeze([
  "campaign_frontier",
  "fan_data",
  "campaign_frontier",
  "fan_data",
  "background_other",
  "campaign_directory",
]);
const ALLOWED_PRIORITIES = new Set([...new Set(PROVIDER_GATE_PRIORITY_CYCLE)]);
const ALLOWED_BACKGROUND_CATEGORIES = new Set([...new Set(PROVIDER_GATE_BACKGROUND_CATEGORY_CYCLE)]);

function clean(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function minDate(left, right) {
  const a = asDate(left);
  const b = asDate(right);
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}
function normalizePriority(value) {
  const text = clean(value, 40);
  return text && ALLOWED_PRIORITIES.has(text) ? text : "normal";
}
function normalizeCategory(value, priority) {
  if (priority !== "background") return "default";
  const text = clean(value, 80);
  return text && ALLOWED_BACKGROUND_CATEGORIES.has(text) ? text : "background_other";
}
function assertDurableClient(db) {
  if (typeof db?.$transaction !== "function" || typeof db?.$queryRawUnsafe !== "function") {
    const error = new Error("Durable provider gate requires PostgreSQL transaction/raw-query support");
    error.code = "OF_PROVIDER_DURABLE_GATE_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
}
async function ensureStateRow(db) {
  await db.$queryRawUnsafe(`
    INSERT INTO "OfProviderRequestGateState" (
      "id", "revision", "priorityCursor", "backgroundCategoryCursor",
      "fairnessGeneration", "fairnessActivationState", "fairnessDrainStartedAt", "legacyPermitCount",
      "createdAt", "updatedAt"
    ) VALUES ($1, 0, 0, 0, $2, 'DRAINING', clock_timestamp(), 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING
  `, PROVIDER_GATE_STATE_ID, PROVIDER_GATE_FAIRNESS_GENERATION);
}
async function lockedState(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT
      s."id",
      s."activePermitId",
      s."activeOwnerInstanceId",
      s."activeAgencyId",
      s."activeCreatorId",
      s."activeDeviceId",
      s."activeCapability",
      s."activePriority",
      s."activeCategory",
      s."activeIntervalMs",
      s."activeGrantedAt",
      s."activeExpiresAt",
      s."nextAllowedAt",
      s."revision",
      s."lastStartedAt",
      s."lastStartedCreatorId",
      s."lastStartedDeviceId",
      s."priorityCursor",
      s."backgroundCategoryCursor",
      s."fairnessGeneration",
      s."fairnessActivationState",
      s."fairnessDrainStartedAt",
      s."fairnessActivatedAt",
      s."fairnessActivationConfirmedAt",
      s."legacyPermitLastSeenAt",
      s."legacyPermitCount",
      s."usageWindowStartedAt",
      s."usageTotalStarts",
      s."usageCriticalWriteStarts",
      s."usageInteractiveStarts",
      s."usageRealtimeStarts",
      s."usageNormalStarts",
      s."usageCampaignDirectoryStarts",
      s."usageCampaignFrontierStarts",
      s."usageFanDataStarts",
      s."usageBackgroundOtherStarts",
      s."usageUnclassifiedStarts",
      clock_timestamp() AS "authorityNow"
    FROM "OfProviderRequestGateState" s
    WHERE s."id" = $1
    FOR UPDATE
  `, PROVIDER_GATE_STATE_ID);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    const error = new Error("Durable provider gate singleton is missing");
    error.code = "OF_PROVIDER_GATE_STATE_MISSING";
    error.status = 503;
    throw error;
  }
  return row;
}
function exactPermitMatch(row, input) {
  return Boolean(
    clean(row?.activePermitId, 200) === clean(input?.permitId, 200) &&
    clean(row?.activeAgencyId, 200) === clean(input?.agencyId, 200) &&
    clean(row?.activeCreatorId, 200) === clean(input?.creatorId, 200) &&
    clean(row?.activeDeviceId, 200) === clean(input?.deviceId, 200) &&
    clean(row?.activeCapability, 40) === clean(input?.capability, 40)
  );
}
function normalizeFairnessActivationState(value) {
  const state = String(value || "DRAINING").trim().toUpperCase();
  return PROVIDER_GATE_FAIRNESS_STATES.includes(state) ? state : "DRAINING";
}
function fairnessAuthorityFromRow(row) {
  return {
    generation: clean(row?.fairnessGeneration, 120) || null,
    activationState: normalizeFairnessActivationState(row?.fairnessActivationState),
    drainStartedAt: asDate(row?.fairnessDrainStartedAt),
    activatedAt: asDate(row?.fairnessActivatedAt),
    activationConfirmedAt: asDate(row?.fairnessActivationConfirmedAt),
    legacyPermitLastSeenAt: asDate(row?.legacyPermitLastSeenAt),
    legacyPermitCount: Math.max(0, asNumber(row?.legacyPermitCount, 0)),
    authorityNow: asDate(row?.authorityNow),
  };
}
function cycleChoice(cycle, cursorValue, available) {
  if (!available.size) return null;
  const start = Math.max(0, Math.floor(asNumber(cursorValue, 0))) % cycle.length;
  for (let step = 0; step < cycle.length; step += 1) {
    const index = (start + step) % cycle.length;
    const key = cycle[index];
    if (available.has(key)) return { key, index, nextCursor: (index + 1) % cycle.length };
  }
  return null;
}

async function readProviderGateFairnessAuthority({ db, forUpdate = false } = {}) {
  assertDurableClient(db);
  if (forUpdate) {
    await ensureStateRow(db);
    return fairnessAuthorityFromRow(await lockedState(db));
  }
  await ensureStateRow(db);
  const rows = await db.$queryRawUnsafe(`
    SELECT
      s."fairnessGeneration", s."fairnessActivationState", s."fairnessDrainStartedAt",
      s."fairnessActivatedAt", s."fairnessActivationConfirmedAt", s."legacyPermitLastSeenAt",
      s."legacyPermitCount", clock_timestamp() AS "authorityNow"
    FROM "OfProviderRequestGateState" s
    WHERE s."id"=$1
    LIMIT 1
  `, PROVIDER_GATE_STATE_ID);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw Object.assign(new Error("Durable provider gate singleton is missing"), { code: "OF_PROVIDER_GATE_STATE_MISSING", status: 503 });
  return fairnessAuthorityFromRow(row);
}

async function tryAcquireLegacyCompatibleProviderPermit({
  db, permitId, ownerInstanceId, agencyId, creatorId, deviceId, capability,
  intervalMs, permitTtlMs = PROVIDER_GATE_PERMIT_TTL_MS,
} = {}) {
  assertDurableClient(db);
  const normalized = {
    permitId: clean(permitId, 200), ownerInstanceId: clean(ownerInstanceId, 200),
    agencyId: clean(agencyId, 200), creatorId: clean(creatorId, 200),
    deviceId: clean(deviceId, 200), capability: clean(capability, 40),
  };
  if (!normalized.permitId || !normalized.ownerInstanceId || !normalized.agencyId || !normalized.creatorId || !normalized.deviceId || !normalized.capability) {
    const error = new Error("Legacy-compatible provider permit scope is incomplete");
    error.code = "OF_PROVIDER_GATE_SCOPE_REQUIRED";
    throw error;
  }
  const spacingMs = Math.max(1, Math.floor(asNumber(intervalMs, 700)));
  const ttlMs = Math.max(5_000, Math.floor(asNumber(permitTtlMs, PROVIDER_GATE_PERMIT_TTL_MS)));
  return runDbTransaction(db, async (tx) => {
    await ensureStateRow(tx);
    const state = await lockedState(tx);
    const authorityNow = asDate(state.authorityNow);
    if (!authorityNow) throw new Error("OF_PROVIDER_GATE_DB_TIME_INVALID");
    const fairness = fairnessAuthorityFromRow(state);
    if (fairness.generation !== PROVIDER_GATE_FAIRNESS_GENERATION) {
      return { granted: false, reason: "fairness_generation_mismatch", authorityNow, retryAt: new Date(authorityNow.getTime() + PROVIDER_GATE_POLL_MS), revision: asNumber(state.revision, 0), fairness };
    }
    if (fairness.activationState === "ACTIVE") {
      return { granted: false, reason: "fairness_active", authorityNow, retryAt: new Date(authorityNow.getTime() + PROVIDER_GATE_POLL_MS), revision: asNumber(state.revision, 0), fairness };
    }
    if (fairness.activationState === "QUIESCING") {
      return { granted: false, reason: "fairness_quiescing", authorityNow, retryAt: new Date(authorityNow.getTime() + PROVIDER_GATE_POLL_MS), revision: asNumber(state.revision, 0), fairness };
    }
    const activeExpiresAt = asDate(state.activeExpiresAt);
    if (state.activePermitId && activeExpiresAt && activeExpiresAt.getTime() <= authorityNow.getTime()) {
      const failSafeNext = new Date(authorityNow.getTime() + spacingMs);
      const rows = await tx.$queryRawUnsafe(`
        UPDATE "OfProviderRequestGateState"
        SET "activePermitId"=NULL,"activeOwnerInstanceId"=NULL,"activeAgencyId"=NULL,"activeCreatorId"=NULL,
            "activeDeviceId"=NULL,"activeCapability"=NULL,"activePriority"=NULL,"activeCategory"=NULL,"activeIntervalMs"=NULL,"activeGrantedAt"=NULL,
            "activeExpiresAt"=NULL,"nextAllowedAt"=GREATEST(COALESCE("nextAllowedAt",$2),$2),
            "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP
        WHERE "id"=$1 RETURNING "revision","nextAllowedAt"
      `, PROVIDER_GATE_STATE_ID, failSafeNext);
      const updated = Array.isArray(rows) ? rows[0] : rows;
      return { granted: false, reason: "expired_unknown_outcome", authorityNow, retryAt: asDate(updated?.nextAllowedAt) || failSafeNext, revision: asNumber(updated?.revision, asNumber(state.revision, 0) + 1), fairness };
    }
    if (state.activePermitId) {
      const pollAt = new Date(authorityNow.getTime() + PROVIDER_GATE_POLL_MS);
      return { granted: false, reason: "active_permit", authorityNow, retryAt: minDate(activeExpiresAt, pollAt) || pollAt, revision: asNumber(state.revision, 0), fairness };
    }
    const nextAllowedAt = asDate(state.nextAllowedAt);
    if (nextAllowedAt && nextAllowedAt.getTime() > authorityNow.getTime()) {
      return { granted: false, reason: "spacing", authorityNow, retryAt: nextAllowedAt, revision: asNumber(state.revision, 0), fairness };
    }
    const expiresAt = new Date(authorityNow.getTime() + ttlMs);
    const rows = await tx.$queryRawUnsafe(`
      UPDATE "OfProviderRequestGateState"
      SET "activePermitId"=$2,"activeOwnerInstanceId"=$3,"activeAgencyId"=$4,"activeCreatorId"=$5,
          "activeDeviceId"=$6,"activeCapability"=$7,"activePriority"='legacy',"activeCategory"='legacy',"activeIntervalMs"=$8,"activeGrantedAt"=$9,
          "activeExpiresAt"=$10,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1 RETURNING "revision","legacyPermitLastSeenAt","legacyPermitCount"
    `, PROVIDER_GATE_STATE_ID, normalized.permitId, normalized.ownerInstanceId, normalized.agencyId,
    normalized.creatorId, normalized.deviceId, normalized.capability, spacingMs, authorityNow, expiresAt);
    const updated = Array.isArray(rows) ? rows[0] : rows;
    return {
      granted: true, reason: "granted_legacy_compat", authorityNow, grantedAt: authorityNow, expiresAt,
      revision: asNumber(updated?.revision, asNumber(state.revision, 0) + 1), intervalMs: spacingMs,
      fairness: { ...fairness, legacyPermitLastSeenAt: asDate(updated?.legacyPermitLastSeenAt) || authorityNow, legacyPermitCount: Math.max(fairness.legacyPermitCount + 1, asNumber(updated?.legacyPermitCount, 0)) },
    };
  });
}

async function readProviderGateFairnessDbFenceStatus(db) {
  if (typeof db?.$queryRawUnsafe !== "function") return { supported: false, ready: false, functionProofValid: false, triggerReady: false };
  const rows = await db.$queryRawUnsafe(`
    SELECT t.tgname AS "triggerName", t.tgenabled AS "enabled", p.proname AS "functionName",
           pg_get_functiondef(p.oid) AS "functionDefinition", pg_get_triggerdef(t.oid, true) AS "triggerDefinition"
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid=t.tgfoid
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname=current_schema()
      AND c.relname='OfProviderRequestGateState' AND t.tgname='onlinod_provider_gate_waiter_registration'
  `);
  const row = Array.isArray(rows) ? rows[0] : rows;
  const fn = String(row?.functionDefinition || "");
  const enabled = String(row?.enabled || "").toUpperCase();
  const functionProofValid = fn.includes('fairnessActivationState') && fn.includes("'ACTIVE'") && fn.includes('ONLINOD_PROVIDER_GATE_WAITER_REQUIRED') && fn.includes('legacyPermitLastSeenAt');
  const triggerReady = Boolean(row && ["O", "A"].includes(enabled) && String(row?.functionName || "") === "onlinod_enforce_provider_gate_waiter_registration");
  return { supported: true, ready: triggerReady && functionProofValid, functionProofValid, triggerReady, enabled: row?.enabled || null };
}

async function beginProviderGateFairnessDrain(db) {
  assertDurableClient(db);
  return runDbTransaction(db, async (tx) => {
    await ensureStateRow(tx);
    const state = await lockedState(tx);
    const fairness = fairnessAuthorityFromRow(state);
    if (fairness.generation !== PROVIDER_GATE_FAIRNESS_GENERATION) {
      throw Object.assign(new Error("Provider gate fairness generation mismatch"), { code: "OF_PROVIDER_GATE_FAIRNESS_GENERATION_MISMATCH", status: 503 });
    }
    if (fairness.activationState === "ACTIVE") return { changed: false, alreadyActive: true, row: fairness };
    if (fairness.activationState === "QUIESCING") return { changed: false, alreadyQuiescing: true, row: fairness };
    const rows = await tx.$queryRawUnsafe(`
      UPDATE "OfProviderRequestGateState"
      SET "fairnessActivationState"='QUIESCING',"fairnessDrainStartedAt"=clock_timestamp(),
          "fairnessActivatedAt"=NULL,"fairnessActivationConfirmedAt"=NULL,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1 AND "fairnessGeneration"=$2 AND "fairnessActivationState"='DRAINING'
      RETURNING "fairnessGeneration","fairnessActivationState","fairnessDrainStartedAt","legacyPermitLastSeenAt","legacyPermitCount",clock_timestamp() AS "authorityNow"
    `, PROVIDER_GATE_STATE_ID, PROVIDER_GATE_FAIRNESS_GENERATION);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw Object.assign(new Error("Provider gate fairness drain state changed concurrently"), { code: "OF_PROVIDER_GATE_FAIRNESS_DRAIN_RACE", status: 409 });
    return { changed: true, alreadyActive: false, row: fairnessAuthorityFromRow(row) };
  });
}

async function providerGateFairnessActivationDiagnostics(db) {
  assertDurableClient(db);
  const [authority, fence] = await Promise.all([
    readProviderGateFairnessAuthority({ db }),
    readProviderGateFairnessDbFenceStatus(db),
  ]);
  const now = authority.authorityNow || new Date();
  const quietFloor = new Date(now.getTime() - PROVIDER_GATE_LEGACY_QUIET_MS);
  const legacyQuiet = !authority.legacyPermitLastSeenAt || authority.legacyPermitLastSeenAt.getTime() <= quietFloor.getTime();
  const rows = await db.$queryRawUnsafe(`
    SELECT "activePermitId","activeExpiresAt",
           (SELECT COUNT(*)::int FROM "OfProviderRequestGateWaiter" WHERE "leaseUntil" > clock_timestamp()) AS "liveWaiters",
           clock_timestamp() AS "authorityNow"
    FROM "OfProviderRequestGateState" WHERE "id"=$1 LIMIT 1
  `, PROVIDER_GATE_STATE_ID);
  const state = Array.isArray(rows) ? rows[0] : rows;
  const noActivePermit = !clean(state?.activePermitId, 200);
  const noLiveWaiters = Math.max(0, asNumber(state?.liveWaiters, 0)) === 0;
  const drainOldEnough = Boolean(authority.drainStartedAt && authority.drainStartedAt.getTime() <= quietFloor.getTime());
  return {
    authority, dbFence: fence, legacyQuiet, noActivePermit, noLiveWaiters, drainOldEnough,
    quietMs: PROVIDER_GATE_LEGACY_QUIET_MS,
    readyToActivate: authority.generation === PROVIDER_GATE_FAIRNESS_GENERATION
      && authority.activationState === "QUIESCING" && fence.ready && legacyQuiet && noActivePermit && noLiveWaiters && drainOldEnough,
  };
}

async function activateProviderGateFairnessAfterDrain(db) {
  assertDurableClient(db);
  return runDbTransaction(db, async (tx) => {
    await ensureStateRow(tx);
    const state = await lockedState(tx);
    const fairness = fairnessAuthorityFromRow(state);
    const fence = await readProviderGateFairnessDbFenceStatus(tx);
    if (!fence.ready) throw Object.assign(new Error("Provider gate fairness PostgreSQL fence is incomplete"), { code: "OF_PROVIDER_GATE_FAIRNESS_DB_FENCE_INCOMPLETE", status: 503, details: fence });
    if (fairness.generation !== PROVIDER_GATE_FAIRNESS_GENERATION) throw Object.assign(new Error("Provider gate fairness generation mismatch"), { code: "OF_PROVIDER_GATE_FAIRNESS_GENERATION_MISMATCH", status: 503 });
    if (fairness.activationState === "ACTIVE") return { activated: false, alreadyActive: true, row: fairness };
    if (fairness.activationState !== "QUIESCING") throw Object.assign(new Error("Provider gate fairness must be quiescing before activation"), { code: "OF_PROVIDER_GATE_FAIRNESS_NOT_QUIESCING", status: 409 });
    const authorityNow = asDate(state.authorityNow);
    const quietFloor = new Date(authorityNow.getTime() - PROVIDER_GATE_LEGACY_QUIET_MS);
    const legacySeen = asDate(state.legacyPermitLastSeenAt);
    const drainStarted = asDate(state.fairnessDrainStartedAt);
    if (state.activePermitId) throw Object.assign(new Error("Provider gate still has an active permit"), { code: "OF_PROVIDER_GATE_FAIRNESS_ACTIVE_PERMIT", status: 409, retryable: true });
    if (!drainStarted || drainStarted.getTime() > quietFloor.getTime() || (legacySeen && legacySeen.getTime() > quietFloor.getTime())) {
      throw Object.assign(new Error("Provider gate legacy compatibility traffic has not been quiet long enough"), { code: "OF_PROVIDER_GATE_FAIRNESS_LEGACY_NOT_DRAINED", status: 409, retryable: true, quietMs: PROVIDER_GATE_LEGACY_QUIET_MS });
    }
    const liveRows = await tx.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "OfProviderRequestGateWaiter" WHERE "leaseUntil" > $1`, authorityNow);
    const liveCount = Math.max(0, asNumber((Array.isArray(liveRows) ? liveRows[0] : liveRows)?.count, 0));
    if (liveCount > 0) throw Object.assign(new Error("Provider gate still has live durable waiters"), { code: "OF_PROVIDER_GATE_FAIRNESS_WAITERS_NOT_DRAINED", status: 409, retryable: true, liveCount });
    const rows = await tx.$queryRawUnsafe(`
      UPDATE "OfProviderRequestGateState"
      SET "fairnessActivationState"='ACTIVE',"fairnessActivatedAt"=clock_timestamp(),
          "fairnessActivationConfirmedAt"=clock_timestamp(),"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1 AND "fairnessGeneration"=$2 AND "fairnessActivationState"='QUIESCING'
      RETURNING "fairnessGeneration","fairnessActivationState","fairnessDrainStartedAt","fairnessActivatedAt","fairnessActivationConfirmedAt","legacyPermitLastSeenAt","legacyPermitCount",clock_timestamp() AS "authorityNow"
    `, PROVIDER_GATE_STATE_ID, PROVIDER_GATE_FAIRNESS_GENERATION);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw Object.assign(new Error("Provider gate fairness activation raced with another transition"), { code: "OF_PROVIDER_GATE_FAIRNESS_ACTIVATION_RACE", status: 409 });
    return { activated: true, alreadyActive: false, row: fairnessAuthorityFromRow(row) };
  });
}

async function registerDurableProviderWaiter({
  db,
  waiterId,
  ownerInstanceId,
  agencyId,
  creatorId,
  deviceId,
  capability,
  priority,
  category,
  operation,
  source,
  waiterTtlMs = PROVIDER_GATE_WAITER_LEASE_MS,
} = {}) {
  assertDurableClient(db);
  const normalizedPriority = normalizePriority(priority);
  const normalized = {
    waiterId: clean(waiterId, 200),
    ownerInstanceId: clean(ownerInstanceId, 200),
    agencyId: clean(agencyId, 200),
    creatorId: clean(creatorId, 200),
    deviceId: clean(deviceId, 200),
    capability: clean(capability, 40),
    priority: normalizedPriority,
    category: normalizeCategory(category, normalizedPriority),
    operation: clean(operation, 160) || "unknown",
    source: clean(source, 240),
  };
  if (!normalized.waiterId || !normalized.ownerInstanceId || !normalized.agencyId || !normalized.creatorId || !normalized.deviceId || !normalized.capability) {
    const error = new Error("Durable provider waiter scope is incomplete");
    error.code = "OF_PROVIDER_GATE_WAITER_SCOPE_REQUIRED";
    throw error;
  }
  const ttlMs = Math.max(5_000, Math.min(60_000, Math.floor(asNumber(waiterTtlMs, PROVIDER_GATE_WAITER_LEASE_MS))));
  const rows = await db.$queryRawUnsafe(`
    INSERT INTO "OfProviderRequestGateWaiter" (
      "waiterId", "ownerInstanceId", "agencyId", "creatorId", "deviceId", "capability",
      "priority", "category", "operation", "source", "enqueuedAt", "leaseUntil", "createdAt", "updatedAt"
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      clock_timestamp(), clock_timestamp() + ($11::bigint * INTERVAL '1 millisecond'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("waiterId") DO UPDATE SET
      "leaseUntil" = clock_timestamp() + ($11::bigint * INTERVAL '1 millisecond'),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "OfProviderRequestGateWaiter"."ownerInstanceId" = EXCLUDED."ownerInstanceId"
      AND "OfProviderRequestGateWaiter"."agencyId" = EXCLUDED."agencyId"
      AND "OfProviderRequestGateWaiter"."creatorId" = EXCLUDED."creatorId"
      AND "OfProviderRequestGateWaiter"."deviceId" = EXCLUDED."deviceId"
      AND "OfProviderRequestGateWaiter"."capability" = EXCLUDED."capability"
    RETURNING "ticket", "enqueuedAt", "leaseUntil", "priority", "category"
  `,
  normalized.waiterId, normalized.ownerInstanceId, normalized.agencyId, normalized.creatorId,
  normalized.deviceId, normalized.capability, normalized.priority, normalized.category,
  normalized.operation, normalized.source, ttlMs);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    const error = new Error("Durable provider waiter identity collided with another scope");
    error.code = "OF_PROVIDER_GATE_WAITER_COLLISION";
    error.status = 409;
    throw error;
  }
  return {
    waiterId: normalized.waiterId,
    ticket: row.ticket,
    priority: clean(row.priority, 40) || normalized.priority,
    category: clean(row.category, 80) || normalized.category,
    enqueuedAt: asDate(row.enqueuedAt),
    leaseUntil: asDate(row.leaseUntil),
  };
}

async function heartbeatDurableProviderWaiters({ db, ownerInstanceId, waiterIds, waiterTtlMs = PROVIDER_GATE_WAITER_LEASE_MS } = {}) {
  assertDurableClient(db);
  const normalizedOwner = clean(ownerInstanceId, 200);
  const ids = [...new Set((Array.isArray(waiterIds) ? waiterIds : []).map((value) => clean(value, 200)).filter(Boolean))].slice(0, 5000);
  if (!normalizedOwner || !ids.length) return { touched: 0 };
  const ttlMs = Math.max(5_000, Math.min(60_000, Math.floor(asNumber(waiterTtlMs, PROVIDER_GATE_WAITER_LEASE_MS))));
  const rows = await db.$queryRawUnsafe(`
    UPDATE "OfProviderRequestGateWaiter"
    SET
      "leaseUntil" = clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "ownerInstanceId" = $1
      AND "waiterId" IN (SELECT jsonb_array_elements_text($2::jsonb))
      AND "leaseUntil" > clock_timestamp()
    RETURNING "waiterId"
  `, normalizedOwner, JSON.stringify(ids), ttlMs);
  return { touched: Array.isArray(rows) ? rows.length : (rows ? 1 : 0) };
}

async function cancelDurableProviderWaiter({ db, waiterId, ownerInstanceId } = {}) {
  assertDurableClient(db);
  const normalizedWaiterId = clean(waiterId, 200);
  const normalizedOwner = clean(ownerInstanceId, 200);
  if (!normalizedWaiterId || !normalizedOwner) return { cancelled: false };
  const rows = await db.$queryRawUnsafe(`
    DELETE FROM "OfProviderRequestGateWaiter"
    WHERE "waiterId" = $1 AND "ownerInstanceId" = $2
    RETURNING "waiterId"
  `, normalizedWaiterId, normalizedOwner);
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { cancelled: Boolean(row) };
}

async function deleteExpiredWaiters(tx, authorityNow) {
  await tx.$queryRawUnsafe(`
    DELETE FROM "OfProviderRequestGateWaiter"
    WHERE "leaseUntil" <= $1
  `, authorityNow);
}

async function waiterHeads(tx, authorityNow) {
  const rows = await tx.$queryRawUnsafe(`
    SELECT DISTINCT ON (w."priority", w."category")
      w."waiterId", w."ownerInstanceId", w."agencyId", w."creatorId", w."deviceId",
      w."capability", w."priority", w."category", w."operation", w."source",
      w."ticket", w."enqueuedAt", w."leaseUntil"
    FROM "OfProviderRequestGateWaiter" w
    WHERE w."leaseUntil" > $1
    ORDER BY w."priority" ASC, w."category" ASC, w."ticket" ASC
  `, authorityNow);
  return Array.isArray(rows) ? rows : (rows ? [rows] : []);
}

function chooseDurableWaiter(state, heads) {
  const valid = heads.filter((row) => clean(row?.waiterId, 200));
  if (!valid.length) return null;
  const availablePriorities = new Set(valid.map((row) => normalizePriority(row.priority)));
  const priorityChoice = cycleChoice(PROVIDER_GATE_PRIORITY_CYCLE, state.priorityCursor, availablePriorities);
  if (!priorityChoice) return null;
  const priority = priorityChoice.key;
  let categoryChoice = null;
  let candidates = valid.filter((row) => normalizePriority(row.priority) === priority);
  if (priority === "background") {
    const categories = new Set(candidates.map((row) => normalizeCategory(row.category, "background")));
    categoryChoice = cycleChoice(PROVIDER_GATE_BACKGROUND_CATEGORY_CYCLE, state.backgroundCategoryCursor, categories);
    if (!categoryChoice) return null;
    candidates = candidates.filter((row) => normalizeCategory(row.category, "background") === categoryChoice.key);
  }
  candidates.sort((a, b) => {
    const ta = BigInt(a.ticket ?? 0);
    const tb = BigInt(b.ticket ?? 0);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const waiter = candidates[0];
  return {
    waiter,
    priority,
    category: priority === "background" ? categoryChoice.key : "default",
    nextPriorityCursor: priorityChoice.nextCursor,
    nextBackgroundCategoryCursor: categoryChoice ? categoryChoice.nextCursor : Math.max(0, Math.floor(asNumber(state.backgroundCategoryCursor, 0))) % PROVIDER_GATE_BACKGROUND_CATEGORY_CYCLE.length,
  };
}

async function tryAcquireDurableProviderPermit({
  db,
  waiterId,
  permitId,
  ownerInstanceId,
  agencyId,
  creatorId,
  deviceId,
  capability,
  intervalMs,
  permitTtlMs = PROVIDER_GATE_PERMIT_TTL_MS,
} = {}) {
  assertDurableClient(db);
  const normalized = {
    waiterId: clean(waiterId, 200),
    permitId: clean(permitId, 200),
    ownerInstanceId: clean(ownerInstanceId, 200),
    agencyId: clean(agencyId, 200),
    creatorId: clean(creatorId, 200),
    deviceId: clean(deviceId, 200),
    capability: clean(capability, 40),
  };
  if (!normalized.waiterId || !normalized.permitId || normalized.waiterId !== normalized.permitId || !normalized.ownerInstanceId || !normalized.agencyId || !normalized.creatorId || !normalized.deviceId || !normalized.capability) {
    const error = new Error("Durable provider permit requires an exact registered waiter permit identity");
    error.code = "OF_PROVIDER_GATE_WAITER_PERMIT_REQUIRED";
    throw error;
  }
  const spacingMs = Math.max(1, Math.floor(asNumber(intervalMs, 700)));
  const ttlMs = Math.max(5_000, Math.floor(asNumber(permitTtlMs, PROVIDER_GATE_PERMIT_TTL_MS)));

  return runDbTransaction(db, async (tx) => {
    await ensureStateRow(tx);
    const state = await lockedState(tx);
    const authorityNow = asDate(state.authorityNow);
    if (!authorityNow) throw new Error("OF_PROVIDER_GATE_DB_TIME_INVALID");
    await deleteExpiredWaiters(tx, authorityNow);

    const callerRows = await tx.$queryRawUnsafe(`
      SELECT "waiterId", "ownerInstanceId", "agencyId", "creatorId", "deviceId", "capability", "priority", "category", "ticket", "leaseUntil"
      FROM "OfProviderRequestGateWaiter"
      WHERE "waiterId" = $1 AND "leaseUntil" > $2
      LIMIT 1
    `, normalized.waiterId, authorityNow);
    const caller = Array.isArray(callerRows) ? callerRows[0] : callerRows;
    if (!caller || clean(caller.ownerInstanceId, 200) !== normalized.ownerInstanceId || clean(caller.agencyId, 200) !== normalized.agencyId || clean(caller.creatorId, 200) !== normalized.creatorId || clean(caller.deviceId, 200) !== normalized.deviceId || clean(caller.capability, 40) !== normalized.capability) {
      return { granted: false, reason: "waiter_missing", authorityNow, retryAt: new Date(authorityNow.getTime() + PROVIDER_GATE_POLL_MS), revision: asNumber(state.revision, 0) };
    }

    const activeExpiresAt = asDate(state.activeExpiresAt);
    if (state.activePermitId && activeExpiresAt && activeExpiresAt.getTime() <= authorityNow.getTime()) {
      // Unknown outcome: transport may have started while /started was lost.
      // Fail closed by imposing one full interval from the DB-observed expiry cleanup.
      const failSafeNext = new Date(authorityNow.getTime() + spacingMs);
      const rows = await tx.$queryRawUnsafe(`
        UPDATE "OfProviderRequestGateState"
        SET
          "activePermitId" = NULL,
          "activeOwnerInstanceId" = NULL,
          "activeAgencyId" = NULL,
          "activeCreatorId" = NULL,
          "activeDeviceId" = NULL,
          "activeCapability" = NULL,
          "activeIntervalMs" = NULL,
          "activeGrantedAt" = NULL,
          "activeExpiresAt" = NULL,
          "nextAllowedAt" = GREATEST(COALESCE("nextAllowedAt", $2), $2),
          "revision" = "revision" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
        RETURNING "revision", "nextAllowedAt"
      `, PROVIDER_GATE_STATE_ID, failSafeNext);
      const updated = Array.isArray(rows) ? rows[0] : rows;
      return {
        granted: false,
        reason: "expired_unknown_outcome",
        authorityNow,
        retryAt: asDate(updated?.nextAllowedAt) || failSafeNext,
        revision: asNumber(updated?.revision, asNumber(state.revision, 0) + 1),
      };
    }

    if (state.activePermitId) {
      const pollAt = new Date(authorityNow.getTime() + PROVIDER_GATE_POLL_MS);
      return {
        granted: false,
        reason: "active_permit",
        authorityNow,
        retryAt: minDate(activeExpiresAt, pollAt) || pollAt,
        revision: asNumber(state.revision, 0),
      };
    }

    const nextAllowedAt = asDate(state.nextAllowedAt);
    if (nextAllowedAt && nextAllowedAt.getTime() > authorityNow.getTime()) {
      return {
        granted: false,
        reason: "spacing",
        authorityNow,
        retryAt: nextAllowedAt,
        revision: asNumber(state.revision, 0),
      };
    }

    const heads = await waiterHeads(tx, authorityNow);
    const selected = chooseDurableWaiter(state, heads);
    if (!selected || clean(selected.waiter.waiterId, 200) !== normalized.waiterId) {
      return {
        granted: false,
        reason: "not_turn",
        authorityNow,
        retryAt: new Date(authorityNow.getTime() + PROVIDER_GATE_POLL_MS),
        revision: asNumber(state.revision, 0),
        selectedWaiterId: clean(selected?.waiter?.waiterId, 200),
        selectedPriority: selected?.priority || null,
        selectedCategory: selected?.category || null,
      };
    }

    const expiresAt = new Date(authorityNow.getTime() + ttlMs);
    const rows = await tx.$queryRawUnsafe(`
      UPDATE "OfProviderRequestGateState"
      SET
        "activePermitId" = $2,
        "activeOwnerInstanceId" = $3,
        "activeAgencyId" = $4,
        "activeCreatorId" = $5,
        "activeDeviceId" = $6,
        "activeCapability" = $7,
        "activeIntervalMs" = $8,
        "activeGrantedAt" = $9,
        "activeExpiresAt" = $10,
        "priorityCursor" = $11,
        "backgroundCategoryCursor" = $12,
        "activePriority" = $13,
        "activeCategory" = $14,
        "revision" = "revision" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
      RETURNING "revision"
    `,
    PROVIDER_GATE_STATE_ID,
    normalized.permitId,
    normalized.ownerInstanceId,
    normalized.agencyId,
    normalized.creatorId,
    normalized.deviceId,
    normalized.capability,
    spacingMs,
    authorityNow,
    expiresAt,
    selected.nextPriorityCursor,
    selected.nextBackgroundCategoryCursor,
    selected.priority,
    selected.category);
    await tx.$queryRawUnsafe(`
      DELETE FROM "OfProviderRequestGateWaiter"
      WHERE "waiterId" = $1 AND "ownerInstanceId" = $2
    `, normalized.waiterId, normalized.ownerInstanceId);
    const updated = Array.isArray(rows) ? rows[0] : rows;
    return {
      granted: true,
      reason: "granted",
      authorityNow,
      grantedAt: authorityNow,
      expiresAt,
      revision: asNumber(updated?.revision, asNumber(state.revision, 0) + 1),
      intervalMs: spacingMs,
      priority: selected.priority,
      category: selected.category,
    };
  });
}

async function acknowledgeDurableProviderStarted({ db, permitId, agencyId, creatorId, deviceId, capability } = {}) {
  assertDurableClient(db);
  const input = { permitId, agencyId, creatorId, deviceId, capability };
  return runDbTransaction(db, async (tx) => {
    await ensureStateRow(tx);
    const state = await lockedState(tx);
    if (!exactPermitMatch(state, input)) {
      const error = new Error("Durable OF provider permit is missing, expired, replaced or belongs to another scope");
      error.code = "OF_GATE_PERMIT_INVALID";
      error.status = 409;
      throw error;
    }
    const authorityNow = asDate(state.authorityNow);
    if (!authorityNow) throw new Error("OF_PROVIDER_GATE_DB_TIME_INVALID");
    const intervalMs = Math.max(1, Math.floor(asNumber(state.activeIntervalMs, 700)));
    const nextAllowedAt = new Date(authorityNow.getTime() + intervalMs);
    const activePriority = state.activePriority === "legacy" ? "legacy" : normalizePriority(state.activePriority);
    const activeCategory = state.activePriority === "legacy" ? "legacy" : normalizeCategory(state.activeCategory, activePriority);
    const usageWindowStartedAt = asDate(state.usageWindowStartedAt);
    const resetUsageWindow = !usageWindowStartedAt || (authorityNow.getTime() - usageWindowStartedAt.getTime()) >= 3_600_000;
    const rows = await tx.$queryRawUnsafe(`
      UPDATE "OfProviderRequestGateState"
      SET
        "activePermitId" = NULL,
        "activeOwnerInstanceId" = NULL,
        "activeAgencyId" = NULL,
        "activeCreatorId" = NULL,
        "activeDeviceId" = NULL,
        "activeCapability" = NULL,
        "activePriority" = NULL,
        "activeCategory" = NULL,
        "activeIntervalMs" = NULL,
        "activeGrantedAt" = NULL,
        "activeExpiresAt" = NULL,
        "lastStartedAt" = $2,
        "lastStartedCreatorId" = $3,
        "lastStartedDeviceId" = $4,
        "nextAllowedAt" = GREATEST(COALESCE("nextAllowedAt", $5), $5),
        "usageWindowStartedAt" = CASE WHEN $8::boolean THEN $2 ELSE COALESCE("usageWindowStartedAt", $2) END,
        "usageTotalStarts" = CASE WHEN $8::boolean THEN 1 ELSE "usageTotalStarts" + 1 END,
        "usageCriticalWriteStarts" = CASE WHEN $8::boolean THEN CASE WHEN $6='critical_write' THEN 1 ELSE 0 END ELSE "usageCriticalWriteStarts" + CASE WHEN $6='critical_write' THEN 1 ELSE 0 END END,
        "usageInteractiveStarts" = CASE WHEN $8::boolean THEN CASE WHEN $6='interactive' THEN 1 ELSE 0 END ELSE "usageInteractiveStarts" + CASE WHEN $6='interactive' THEN 1 ELSE 0 END END,
        "usageRealtimeStarts" = CASE WHEN $8::boolean THEN CASE WHEN $6='realtime' THEN 1 ELSE 0 END ELSE "usageRealtimeStarts" + CASE WHEN $6='realtime' THEN 1 ELSE 0 END END,
        "usageNormalStarts" = CASE WHEN $8::boolean THEN CASE WHEN $6='normal' THEN 1 ELSE 0 END ELSE "usageNormalStarts" + CASE WHEN $6='normal' THEN 1 ELSE 0 END END,
        "usageCampaignDirectoryStarts" = CASE WHEN $8::boolean THEN CASE WHEN $7='campaign_directory' THEN 1 ELSE 0 END ELSE "usageCampaignDirectoryStarts" + CASE WHEN $7='campaign_directory' THEN 1 ELSE 0 END END,
        "usageCampaignFrontierStarts" = CASE WHEN $8::boolean THEN CASE WHEN $7='campaign_frontier' THEN 1 ELSE 0 END ELSE "usageCampaignFrontierStarts" + CASE WHEN $7='campaign_frontier' THEN 1 ELSE 0 END END,
        "usageFanDataStarts" = CASE WHEN $8::boolean THEN CASE WHEN $7='fan_data' THEN 1 ELSE 0 END ELSE "usageFanDataStarts" + CASE WHEN $7='fan_data' THEN 1 ELSE 0 END END,
        "usageBackgroundOtherStarts" = CASE WHEN $8::boolean THEN CASE WHEN $7='background_other' THEN 1 ELSE 0 END ELSE "usageBackgroundOtherStarts" + CASE WHEN $7='background_other' THEN 1 ELSE 0 END END,
        "usageUnclassifiedStarts" = CASE WHEN $8::boolean THEN CASE WHEN $6='legacy' OR $7='legacy' THEN 1 ELSE 0 END ELSE "usageUnclassifiedStarts" + CASE WHEN $6='legacy' OR $7='legacy' THEN 1 ELSE 0 END END,
        "revision" = "revision" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
      RETURNING "revision", "usageWindowStartedAt", "usageTotalStarts", "usageUnclassifiedStarts"
    `, PROVIDER_GATE_STATE_ID, authorityNow, clean(creatorId, 200), clean(deviceId, 200), nextAllowedAt, activePriority, activeCategory, resetUsageWindow);
    const updated = Array.isArray(rows) ? rows[0] : rows;
    return {
      startedAt: authorityNow,
      nextAllowedAt,
      revision: asNumber(updated?.revision, asNumber(state.revision, 0) + 1),
      intervalMs,
      usageWindowStartedAt: asDate(updated?.usageWindowStartedAt),
      usageTotalStarts: asNumber(updated?.usageTotalStarts, 0),
      usageUnclassifiedStarts: asNumber(updated?.usageUnclassifiedStarts, 0),
    };
  });
}

async function cancelDurableProviderPermit({ db, permitId, agencyId, creatorId, deviceId, capability } = {}) {
  assertDurableClient(db);
  const input = { permitId, agencyId, creatorId, deviceId, capability };
  return runDbTransaction(db, async (tx) => {
    await ensureStateRow(tx);
    const state = await lockedState(tx);
    if (!exactPermitMatch(state, input)) return { cancelled: false, revision: asNumber(state.revision, 0) };
    const rows = await tx.$queryRawUnsafe(`
      UPDATE "OfProviderRequestGateState"
      SET
        "activePermitId" = NULL,
        "activeOwnerInstanceId" = NULL,
        "activeAgencyId" = NULL,
        "activeCreatorId" = NULL,
        "activeDeviceId" = NULL,
        "activeCapability" = NULL,
        "activePriority" = NULL,
        "activeCategory" = NULL,
        "activeIntervalMs" = NULL,
        "activeGrantedAt" = NULL,
        "activeExpiresAt" = NULL,
        "revision" = "revision" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
      RETURNING "revision"
    `, PROVIDER_GATE_STATE_ID);
    const updated = Array.isArray(rows) ? rows[0] : rows;
    return { cancelled: true, revision: asNumber(updated?.revision, asNumber(state.revision, 0) + 1) };
  });
}

async function readDurableProviderGateState({ db } = {}) {
  assertDurableClient(db);
  return runDbTransaction(db, async (tx) => {
    await ensureStateRow(tx);
    const state = await lockedState(tx);
    return {
      id: state.id,
      activePermitId: clean(state.activePermitId, 200),
      activeOwnerInstanceId: clean(state.activeOwnerInstanceId, 200),
      activeCreatorId: clean(state.activeCreatorId, 200),
      activeDeviceId: clean(state.activeDeviceId, 200),
      activeCapability: clean(state.activeCapability, 40),
      activeGrantedAt: asDate(state.activeGrantedAt),
      activeExpiresAt: asDate(state.activeExpiresAt),
      nextAllowedAt: asDate(state.nextAllowedAt),
      lastStartedAt: asDate(state.lastStartedAt),
      lastStartedCreatorId: clean(state.lastStartedCreatorId, 200),
      lastStartedDeviceId: clean(state.lastStartedDeviceId, 200),
      authorityNow: asDate(state.authorityNow),
      revision: asNumber(state.revision, 0),
      priorityCursor: asNumber(state.priorityCursor, 0),
      backgroundCategoryCursor: asNumber(state.backgroundCategoryCursor, 0),
      fairness: fairnessAuthorityFromRow(state),
    };
  });
}

module.exports = {
  PROVIDER_GATE_STATE_ID,
  PROVIDER_GATE_POLL_MS,
  PROVIDER_GATE_PERMIT_TTL_MS,
  PROVIDER_GATE_WAITER_LEASE_MS,
  PROVIDER_GATE_WAITER_HEARTBEAT_MS,
  PROVIDER_GATE_FAIRNESS_GENERATION,
  PROVIDER_GATE_FAIRNESS_STATES,
  PROVIDER_GATE_LEGACY_QUIET_MS,
  PROVIDER_GATE_PRIORITY_CYCLE,
  PROVIDER_GATE_BACKGROUND_CATEGORY_CYCLE,
  readProviderGateFairnessAuthority,
  readProviderGateFairnessDbFenceStatus,
  beginProviderGateFairnessDrain,
  providerGateFairnessActivationDiagnostics,
  activateProviderGateFairnessAfterDrain,
  tryAcquireLegacyCompatibleProviderPermit,
  registerDurableProviderWaiter,
  heartbeatDurableProviderWaiters,
  cancelDurableProviderWaiter,
  tryAcquireDurableProviderPermit,
  acknowledgeDurableProviderStarted,
  cancelDurableProviderPermit,
  readDurableProviderGateState,
  _test: { cycleChoice, chooseDurableWaiter, normalizePriority, normalizeCategory, normalizeFairnessActivationState, fairnessAuthorityFromRow },
};
