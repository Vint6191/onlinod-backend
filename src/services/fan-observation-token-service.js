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

async function nextObservationTime(db) {
  const rows = await db.$queryRawUnsafe(`
    UPDATE "FanObservationClock"
    SET "lastObservedAt" = GREATEST(
          CURRENT_TIMESTAMP,
          "lastObservedAt" + INTERVAL '1 millisecond'
        ),
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 1
    RETURNING "lastObservedAt"
  `);
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
  if (!normalizedPurpose || !clean(deviceId, 200) || !Number.isInteger(Number(leaseRevision))) {
    throw new Error("FAN_OBSERVATION_TOKEN_SCOPE_INVALID");
  }
  if (!normalizedSubjects.length) throw new Error("FAN_OBSERVATION_TOKEN_SUBJECT_REQUIRED");
  const scopeHash = observationScopeHash({ purpose: normalizedPurpose, subjects: normalizedSubjects });
  await cleanupStaleFanObservationTokens(db);
  const observedAt = await nextObservationTime(db);
  const token = crypto.randomBytes(32).toString("base64url");
  await db.fanObservationToken.create({
    data: {
      token,
      jobId: owner.jobId,
      deliveryId: owner.deliveryId,
      agencyId: clean(agencyId, 180),
      creatorId: clean(creatorId, 180),
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
  createActionFanObservationToken,
  consumeActionFanObservationToken,
  cleanupStaleFanObservationTokens,
  FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS,
  FAN_OBSERVATION_TOKEN_CLEANUP_INTERVAL_MS,
  FAN_OBSERVATION_TOKEN_MAX_SUBJECTS,
};
