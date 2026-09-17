"use strict";

const crypto = require("node:crypto");

const FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS = 24 * 60 * 60_000;
const FAN_OBSERVATION_TOKEN_CLEANUP_INTERVAL_MS = 5 * 60_000;
const FAN_OBSERVATION_TOKEN_MAX_SUBJECTS = 500;
let nextFanObservationTokenCleanupAt = 0;

function clean(value, max = 500) {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
}

function normalizeSubjects(subjects) {
  const normalized = [...new Set((Array.isArray(subjects) ? subjects : [])
    .map((value) => clean(value, 180))
    .filter(Boolean))]
    .sort();
  if (normalized.length > FAN_OBSERVATION_TOKEN_MAX_SUBJECTS) {
    throw new Error("FAN_OBSERVATION_TOKEN_SCOPE_TOO_LARGE");
  }
  return normalized;
}

function observationScopeHash({ purpose, subjects }) {
  const normalizedPurpose = clean(purpose, 120);
  if (!normalizedPurpose) throw new Error("FAN_OBSERVATION_TOKEN_PURPOSE_REQUIRED");
  const normalizedSubjects = normalizeSubjects(subjects);
  const canonical = `${normalizedPurpose}|${normalizedSubjects.join("\n")}`;
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function nextObservationTime(db, { creatorId }) {
  const normalizedCreatorId = clean(creatorId, 180);
  if (!normalizedCreatorId) throw new Error("FAN_OBSERVATION_TOKEN_CREATOR_REQUIRED");
  const rows = await db.$queryRawUnsafe(`
    WITH clock_mode AS MATERIALIZED (
      SELECT
        COALESCE(("value"->>'active')::boolean, false) AS "active",
        CASE
          WHEN COALESCE(("value"->>'active')::boolean, false)
          THEN ((NULLIF("value"->>'floorObservedAt', ''))::timestamptz AT TIME ZONE 'UTC')::timestamp(3)
          ELSE NULL
        END AS "floorObservedAt"
      FROM "SystemSetting"
      WHERE "key" = 'phase3.fanObservationCreatorClockV1'
      FOR SHARE
    ),
    bridge_legacy_lock AS MATERIALIZED (
      SELECT g."lastObservedAt"
      FROM "FanObservationClock" AS g
      CROSS JOIN clock_mode AS m
      WHERE g."id" = 1
        AND m."active" = false
      FOR UPDATE OF g
    ),
    bridge_creator_step AS MATERIALIZED (
      INSERT INTO "FanObservationCreatorClock" ("creatorId", "lastObservedAt", "updatedAt")
      SELECT
        $1,
        GREATEST(
          CURRENT_TIMESTAMP,
          b."lastObservedAt" + INTERVAL '1 millisecond'
        ),
        CURRENT_TIMESTAMP
      FROM bridge_legacy_lock AS b
      ON CONFLICT ("creatorId") DO UPDATE
      SET "lastObservedAt" = GREATEST(
            CURRENT_TIMESTAMP,
            "FanObservationCreatorClock"."lastObservedAt" + INTERVAL '1 millisecond',
            EXCLUDED."lastObservedAt"
          ),
          "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "lastObservedAt"
    ),
    bridge_global_sync AS MATERIALIZED (
      UPDATE "FanObservationClock" AS g
      SET "lastObservedAt" = GREATEST(g."lastObservedAt", c."lastObservedAt"),
          "updatedAt" = CURRENT_TIMESTAMP
      FROM bridge_creator_step AS c
      WHERE g."id" = 1
      RETURNING c."lastObservedAt"
    ),
    active_creator_step AS MATERIALIZED (
      INSERT INTO "FanObservationCreatorClock" ("creatorId", "lastObservedAt", "updatedAt")
      SELECT
        $1,
        GREATEST(
          CURRENT_TIMESTAMP,
          m."floorObservedAt" + INTERVAL '1 millisecond'
        ),
        CURRENT_TIMESTAMP
      FROM clock_mode AS m
      WHERE m."active" = true
        AND m."floorObservedAt" IS NOT NULL
      ON CONFLICT ("creatorId") DO UPDATE
      SET "lastObservedAt" = GREATEST(
            CURRENT_TIMESTAMP,
            "FanObservationCreatorClock"."lastObservedAt" + INTERVAL '1 millisecond',
            EXCLUDED."lastObservedAt"
          ),
          "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "lastObservedAt"
    )
    SELECT "lastObservedAt" FROM bridge_global_sync
    UNION ALL
    SELECT "lastObservedAt" FROM active_creator_step
  `, normalizedCreatorId);
  const observedAt = rows?.[0]?.lastObservedAt instanceof Date
    ? rows[0].lastObservedAt
    : new Date(rows?.[0]?.lastObservedAt);
  if (!observedAt || !Number.isFinite(observedAt.getTime())) {
    throw new Error("FAN_OBSERVATION_CLOCK_UNAVAILABLE");
  }
  return observedAt;
}

function tokenOwner({ jobId = null, deliveryId = null }) {
  const normalizedJobId = clean(jobId, 180);
  const normalizedDeliveryId = clean(deliveryId, 180);
  if ((normalizedJobId ? 1 : 0) + (normalizedDeliveryId ? 1 : 0) !== 1) {
    throw new Error("FAN_OBSERVATION_TOKEN_OWNER_INVALID");
  }
  return { jobId: normalizedJobId, deliveryId: normalizedDeliveryId };
}

async function cleanupStaleFanObservationTokens(db, { now = new Date(), force = false } = {}) {
  const deleteMany = db?.fanObservationToken?.deleteMany;
  if (typeof deleteMany !== "function") return { deleted: 0, skipped: true };
  const authorityNow = now instanceof Date ? now : new Date(now);
  const nowMs = authorityNow.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("FAN_OBSERVATION_TOKEN_CLEANUP_TIME_INVALID");
  if (!force && nowMs < nextFanObservationTokenCleanupAt) return { deleted: 0, skipped: true };
  const cutoff = new Date(nowMs - FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS);
  const result = await db.fanObservationToken.deleteMany({ where: { createdAt: { lt: cutoff } } });
  nextFanObservationTokenCleanupAt = nowMs + FAN_OBSERVATION_TOKEN_CLEANUP_INTERVAL_MS;
  return { deleted: Number(result?.count || 0), skipped: false, cutoff };
}

async function createScopedFanObservationToken({ db, jobId = null, deliveryId = null, agencyId = null, creatorId = null, deviceId, leaseRevision, purpose, subjects }) {
  const normalizedPurpose = clean(purpose, 120);
  const normalizedSubjects = normalizeSubjects(subjects);
  const owner = tokenOwner({ jobId, deliveryId });
  const normalizedCreatorId = clean(creatorId, 180);
  if (!normalizedPurpose || !normalizedCreatorId || !clean(deviceId, 200) || !Number.isInteger(Number(leaseRevision))) {
    throw new Error("FAN_OBSERVATION_TOKEN_SCOPE_INVALID");
  }
  if (!normalizedSubjects.length) throw new Error("FAN_OBSERVATION_TOKEN_SUBJECT_REQUIRED");
  const scopeHash = observationScopeHash({ purpose: normalizedPurpose, subjects: normalizedSubjects });
  await cleanupStaleFanObservationTokens(db);
  const observedAt = await nextObservationTime(db, { creatorId: normalizedCreatorId });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.fanObservationToken.create({
    data: {
      token,
      jobId: owner.jobId,
      deliveryId: owner.deliveryId,
      agencyId: clean(agencyId, 180),
      creatorId: normalizedCreatorId,
      deviceId: clean(deviceId, 200),
      leaseRevision: Number(leaseRevision),
      purpose: normalizedPurpose,
      scopeHash,
      observedAt,
    },
  });
  return { token, observedAt, purpose: normalizedPurpose, subjects: normalizedSubjects };
}

async function consumeScopedFanObservationToken({ db, jobId = null, deliveryId = null, deviceId, leaseRevision, token, purpose, subjects }) {
  const normalizedToken = clean(token, 500);
  const normalizedPurpose = clean(purpose, 120);
  const owner = tokenOwner({ jobId, deliveryId });
  if (!normalizedToken || !normalizedPurpose) {
    throw new Error("FAN_OBSERVATION_TOKEN_REQUIRED");
  }
  const scopeHash = observationScopeHash({ purpose: normalizedPurpose, subjects });
  const row = await db.fanObservationToken.findUnique({ where: { token: normalizedToken } });
  if (!row
    || (row.jobId || null) !== owner.jobId
    || (row.deliveryId || null) !== owner.deliveryId
    || row.deviceId !== clean(deviceId, 200)
    || Number(row.leaseRevision) !== Number(leaseRevision)
    || row.purpose !== normalizedPurpose
    || row.scopeHash !== scopeHash
    || row.consumedAt) {
    throw new Error("FAN_OBSERVATION_TOKEN_INVALID");
  }
  const consumeWhere = {
    token: normalizedToken,
    jobId: owner.jobId,
    deliveryId: owner.deliveryId,
    deviceId: clean(deviceId, 200),
    leaseRevision: Number(leaseRevision),
    purpose: normalizedPurpose,
    scopeHash,
    consumedAt: null,
  };
  // Production consumes by DELETE rather than leaving an ever-growing audit row.
  // A replay still fails closed because the unique token no longer exists. Tiny
  // in-memory test adapters that predate deleteMany retain the old consumedAt
  // fallback, but PostgreSQL/Prisma always takes the bounded-storage path.
  const consumed = typeof db.fanObservationToken.deleteMany === "function"
    ? await db.fanObservationToken.deleteMany({ where: consumeWhere })
    : await db.fanObservationToken.updateMany({ where: consumeWhere, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw new Error("FAN_OBSERVATION_TOKEN_REPLAYED");
  return { observedAt: row.observedAt, tokenId: row.id };
}

async function createFanObservationToken({ db, job, deviceId, leaseRevision, purpose, subjects }) {
  if (!job?.id) throw new Error("FAN_OBSERVATION_TOKEN_SCOPE_INVALID");
  return createScopedFanObservationToken({
    db, jobId: job.id, agencyId: job.agencyId, creatorId: job.creatorId,
    deviceId, leaseRevision, purpose, subjects,
  });
}

async function consumeFanObservationToken({ db, job, deviceId, leaseRevision, token, purpose, subjects }) {
  if (!job?.id) throw new Error("FAN_OBSERVATION_TOKEN_REQUIRED");
  return consumeScopedFanObservationToken({
    db, jobId: job.id, deviceId, leaseRevision, token, purpose, subjects,
  });
}

async function consumeFanObservationTokensBatch({ db, job, deviceId, leaseRevision, requests }) {
  if (!job?.id) throw new Error("FAN_OBSERVATION_TOKEN_REQUIRED");
  const input = Array.isArray(requests) ? requests : [];
  if (!input.length) return [];
  if (input.length > FAN_OBSERVATION_TOKEN_MAX_SUBJECTS) throw new Error("FAN_OBSERVATION_TOKEN_BATCH_TOO_LARGE");

  const ownerJobId = clean(job.id, 180);
  const ownerDeviceId = clean(deviceId, 200);
  const ownerRevision = Number(leaseRevision);
  if (!ownerJobId || !ownerDeviceId || !Number.isInteger(ownerRevision)) throw new Error("FAN_OBSERVATION_TOKEN_SCOPE_INVALID");

  const normalized = input.map((request) => {
    const token = clean(request?.token, 500);
    const purpose = clean(request?.purpose, 120);
    if (!token || !purpose) throw new Error("FAN_OBSERVATION_TOKEN_REQUIRED");
    return {
      token,
      purpose,
      scopeHash: observationScopeHash({ purpose, subjects: request?.subjects }),
    };
  });
  if (new Set(normalized.map((request) => request.token)).size !== normalized.length) {
    throw new Error("FAN_OBSERVATION_TOKEN_DUPLICATE");
  }

  // PostgreSQL/Prisma path: validate the complete bounded token set first, then
  // consume it with one deleteMany. If any token is missing, replayed or scoped to
  // another owner/purpose/fan, nothing is consumed before the transaction fails.
  if (typeof db?.fanObservationToken?.findMany === "function" && typeof db?.fanObservationToken?.deleteMany === "function") {
    const tokens = normalized.map((request) => request.token);
    const rows = await db.fanObservationToken.findMany({ where: { token: { in: tokens } } });
    const byToken = new Map((rows || []).map((row) => [String(row.token), row]));
    const orderedRows = normalized.map((request) => {
      const row = byToken.get(request.token);
      if (!row
        || (row.jobId || null) !== ownerJobId
        || (row.deliveryId || null) !== null
        || row.deviceId !== ownerDeviceId
        || Number(row.leaseRevision) !== ownerRevision
        || row.purpose !== request.purpose
        || row.scopeHash !== request.scopeHash
        || row.consumedAt) {
        throw new Error("FAN_OBSERVATION_TOKEN_INVALID");
      }
      return row;
    });
    const consumed = await db.fanObservationToken.deleteMany({
      where: {
        token: { in: tokens },
        jobId: ownerJobId,
        deliveryId: null,
        deviceId: ownerDeviceId,
        leaseRevision: ownerRevision,
        consumedAt: null,
      },
    });
    if (Number(consumed?.count || 0) !== normalized.length) throw new Error("FAN_OBSERVATION_TOKEN_REPLAYED");
    return orderedRows.map((row) => ({ observedAt: row.observedAt, tokenId: row.id }));
  }

  // Compatibility fallback for the small in-memory adapters used by legacy tests.
  const consumed = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const request = input[index];
    consumed.push(await consumeFanObservationToken({
      db, job, deviceId, leaseRevision, token: normalized[index].token,
      purpose: normalized[index].purpose, subjects: request?.subjects,
    }));
  }
  return consumed;
}

async function createActionFanObservationToken({ db, delivery, deviceId, leaseRevision, purpose, subjects }) {
  if (!delivery?.id) throw new Error("FAN_OBSERVATION_TOKEN_SCOPE_INVALID");
  return createScopedFanObservationToken({
    db, deliveryId: delivery.id, agencyId: delivery.agencyId, creatorId: delivery.creatorId,
    deviceId, leaseRevision, purpose, subjects,
  });
}

async function consumeActionFanObservationToken({ db, delivery, deviceId, leaseRevision, token, purpose, subjects }) {
  if (!delivery?.id) throw new Error("FAN_OBSERVATION_TOKEN_REQUIRED");
  return consumeScopedFanObservationToken({
    db, deliveryId: delivery.id, deviceId, leaseRevision, token, purpose, subjects,
  });
}

module.exports = {
  normalizeSubjects,
  observationScopeHash,
  createFanObservationToken,
  consumeFanObservationToken,
  consumeFanObservationTokensBatch,
  createActionFanObservationToken,
  consumeActionFanObservationToken,
  cleanupStaleFanObservationTokens,
  FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS,
  FAN_OBSERVATION_TOKEN_CLEANUP_INTERVAL_MS,
  FAN_OBSERVATION_TOKEN_MAX_SUBJECTS,
};
