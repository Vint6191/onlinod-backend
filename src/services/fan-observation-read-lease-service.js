"use strict";

const crypto = require("node:crypto");
const { createFanObservationToken, createActionFanObservationToken } = require("./fan-observation-token-service");

const FAN_OBSERVATION_READ_LEASE_TTL_MS = 4 * 60_000;

class FanObservationReadLeaseError extends Error {
  constructor(code, message, status = 409, extras = {}) {
    super(message);
    this.name = "FanObservationReadLeaseError";
    this.code = code;
    this.status = status;
    Object.assign(this, extras);
  }
}

function clean(value, max = 500) {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
}

function validOwner({ jobId = null, deliveryId = null }) {
  const normalizedJobId = clean(jobId, 180);
  const normalizedDeliveryId = clean(deliveryId, 180);
  if ((normalizedJobId ? 1 : 0) + (normalizedDeliveryId ? 1 : 0) !== 1) {
    throw new FanObservationReadLeaseError("FAN_OBSERVATION_READ_LEASE_OWNER_INVALID", "Observation read lease requires exactly one durable owner", 409);
  }
  return { jobId: normalizedJobId, deliveryId: normalizedDeliveryId };
}

function normalizeAcquire(input) {
  const owner = validOwner(input);
  const creatorId = clean(input.creatorId, 180);
  const deviceId = clean(input.deviceId, 200);
  const purpose = clean(input.purpose, 120);
  const requestId = clean(input.requestId, 200);
  const leaseRevision = Number(input.leaseRevision);
  if (!creatorId || !deviceId || !purpose || !requestId || !Number.isInteger(leaseRevision) || leaseRevision < 1) {
    throw new FanObservationReadLeaseError("FAN_OBSERVATION_READ_LEASE_SCOPE_INVALID", "Observation read lease scope is invalid", 400);
  }
  return {
    ...owner,
    agencyId: clean(input.agencyId, 180),
    creatorId,
    deviceId,
    leaseRevision,
    purpose,
    requestId,
  };
}

function sameAcquire(row, scope) {
  return Boolean(row
    && (row.jobId || null) === scope.jobId
    && (row.deliveryId || null) === scope.deliveryId
    && row.deviceId === scope.deviceId
    && Number(row.leaseRevision) === scope.leaseRevision
    && row.purpose === scope.purpose
    && row.requestId === scope.requestId);
}

async function acquireFanObservationReadLease({ db, ttlMs = FAN_OBSERVATION_READ_LEASE_TTL_MS, ...input }) {
  const scope = normalizeAcquire(input);
  const boundedTtlMs = Math.max(60_000, Math.min(10 * 60_000, Math.floor(Number(ttlMs) || FAN_OBSERVATION_READ_LEASE_TTL_MS)));
  const token = crypto.randomBytes(32).toString("base64url");
  const rows = await db.$queryRawUnsafe(`
    INSERT INTO "FanObservationReadLease" (
      "creatorId","agencyId","token","requestId","jobId","deliveryId","deviceId","leaseRevision","purpose","acquiredAt","expiresAt","updatedAt"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + ($10::bigint * INTERVAL '1 millisecond'),CURRENT_TIMESTAMP)
    ON CONFLICT ("creatorId") DO UPDATE SET
      "agencyId" = EXCLUDED."agencyId",
      "token" = EXCLUDED."token",
      "requestId" = EXCLUDED."requestId",
      "jobId" = EXCLUDED."jobId",
      "deliveryId" = EXCLUDED."deliveryId",
      "deviceId" = EXCLUDED."deviceId",
      "leaseRevision" = EXCLUDED."leaseRevision",
      "purpose" = EXCLUDED."purpose",
      "acquiredAt" = CURRENT_TIMESTAMP,
      "expiresAt" = CURRENT_TIMESTAMP + ($10::bigint * INTERVAL '1 millisecond'),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "FanObservationReadLease"."expiresAt" <= CURRENT_TIMESTAMP
    RETURNING *
  `, scope.creatorId, scope.agencyId, token, scope.requestId, scope.jobId, scope.deliveryId,
  scope.deviceId, scope.leaseRevision, scope.purpose, boundedTtlMs);

  const acquired = rows?.[0] || null;
  if (acquired) {
    return { acquired: true, token: acquired.token, acquiredAt: acquired.acquiredAt, expiresAt: acquired.expiresAt };
  }

  const current = await db.fanObservationReadLease.findUnique({ where: { creatorId: scope.creatorId } });
  if (sameAcquire(current, scope)) {
    return { acquired: true, token: current.token, acquiredAt: current.acquiredAt, expiresAt: current.expiresAt, replay: true };
  }
  const expiresAtMs = current?.expiresAt instanceof Date ? current.expiresAt.getTime() : Date.parse(String(current?.expiresAt || ""));
  return {
    acquired: false,
    retryAfterMs: Number.isFinite(expiresAtMs) ? Math.max(250, Math.min(30_000, expiresAtMs - Date.now())) : 1_000,
    heldByDeviceId: current?.deviceId || null,
  };
}

async function lockReadLease(db, creatorId) {
  const rows = await db.$queryRawUnsafe(`
    SELECT * FROM "FanObservationReadLease"
    WHERE "creatorId" = $1
      AND "expiresAt" > CURRENT_TIMESTAMP
    FOR UPDATE
  `, creatorId);
  return rows?.[0] || null;
}

function assertReadLease(row, { token, jobId = null, deliveryId = null, deviceId, leaseRevision, purpose }) {
  const owner = validOwner({ jobId, deliveryId });
  if (!row
    || row.token !== clean(token, 500)
    || (row.jobId || null) !== owner.jobId
    || (row.deliveryId || null) !== owner.deliveryId
    || row.deviceId !== clean(deviceId, 200)
    || Number(row.leaseRevision) !== Number(leaseRevision)
    || row.purpose !== clean(purpose, 120)) {
    throw new FanObservationReadLeaseError("FAN_OBSERVATION_READ_LEASE_INVALID", "Observation read lease is missing, expired or belongs to another execution", 409);
  }
  return owner;
}

async function completeJobFanObservationReadLease({ db, job, deviceId, leaseRevision, readLeaseToken, purpose, subjects }) {
  if (!job?.id || !job?.creatorId) {
    throw new FanObservationReadLeaseError("FAN_OBSERVATION_READ_LEASE_OWNER_INVALID", "Observation read lease job scope is invalid", 409);
  }
  const row = await lockReadLease(db, job.creatorId);
  assertReadLease(row, { token: readLeaseToken, jobId: job.id, deviceId, leaseRevision, purpose });
  const issued = await createFanObservationToken({ db, job, deviceId, leaseRevision, purpose, subjects });
  const released = await db.fanObservationReadLease.deleteMany({
    where: { creatorId: job.creatorId, token: clean(readLeaseToken, 500), jobId: job.id, deviceId: clean(deviceId, 200), leaseRevision: Number(leaseRevision), purpose: clean(purpose, 120) },
  });
  if (released.count !== 1) throw new FanObservationReadLeaseError("FAN_OBSERVATION_READ_LEASE_CHANGED", "Observation read lease changed before completion", 409);
  return issued;
}


async function completeDeliveryFanObservationReadLease({ db, delivery, deviceId, leaseRevision, readLeaseToken, purpose, subjects }) {
  if (!delivery?.id || !delivery?.creatorId) {
    throw new FanObservationReadLeaseError("FAN_OBSERVATION_READ_LEASE_OWNER_INVALID", "Observation read lease delivery scope is invalid", 409);
  }
  const row = await lockReadLease(db, delivery.creatorId);
  assertReadLease(row, { token: readLeaseToken, deliveryId: delivery.id, deviceId, leaseRevision, purpose });
  const issued = await createActionFanObservationToken({
    db, delivery, deviceId, leaseRevision, purpose, subjects,
  });
  const released = await db.fanObservationReadLease.deleteMany({
    where: { creatorId: delivery.creatorId, token: clean(readLeaseToken, 500), deliveryId: delivery.id, deviceId: clean(deviceId, 200), leaseRevision: Number(leaseRevision), purpose: clean(purpose, 120) },
  });
  if (released.count !== 1) throw new FanObservationReadLeaseError("FAN_OBSERVATION_READ_LEASE_CHANGED", "Observation read lease changed before completion", 409);
  return issued;
}

async function releaseDeliveryFanObservationReadLease({ db, delivery, deviceId, leaseRevision, readLeaseToken }) {
  if (!delivery?.id || !delivery?.creatorId) return { released: false };
  const result = await db.fanObservationReadLease.deleteMany({
    where: {
      creatorId: delivery.creatorId,
      token: clean(readLeaseToken, 500),
      deliveryId: delivery.id,
      deviceId: clean(deviceId, 200),
      leaseRevision: Number(leaseRevision),
    },
  });
  return { released: result.count === 1 };
}

async function releaseJobFanObservationReadLease({ db, job, deviceId, leaseRevision, readLeaseToken }) {
  if (!job?.id || !job?.creatorId) return { released: false };
  const result = await db.fanObservationReadLease.deleteMany({
    where: {
      creatorId: job.creatorId,
      token: clean(readLeaseToken, 500),
      jobId: job.id,
      deviceId: clean(deviceId, 200),
      leaseRevision: Number(leaseRevision),
    },
  });
  return { released: result.count === 1 };
}

module.exports = {
  FanObservationReadLeaseError,
  FAN_OBSERVATION_READ_LEASE_TTL_MS,
  acquireFanObservationReadLease,
  completeJobFanObservationReadLease,
  releaseJobFanObservationReadLease,
  completeDeliveryFanObservationReadLease,
  releaseDeliveryFanObservationReadLease,
};
