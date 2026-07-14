"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { applyJobResult, recordJobFailure } = require("./job-result-service");
const { filterClaimableDesktopJobKeys } = require("./job-catalog");

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MIN_LEASE_MS = 30 * 1000;
const MAX_LEASE_MS = 15 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

class JobLeaseError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "JobLeaseError";
    this.code = code;
    this.status = status;
  }
}
function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function tokenMatches(token, expectedHash) {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(String(expectedHash), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function leaseDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LEASE_MS;
  return Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(parsed)));
}
function safeProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  const percent = Number(value.percent);
  const current = Number(value.current);
  const total = Number(value.total);
  const message = clean(value.message, 500);
  if (Number.isFinite(percent)) out.percent = Math.max(0, Math.min(100, percent));
  if (Number.isFinite(current)) out.current = Math.max(0, current);
  if (Number.isFinite(total)) out.total = Math.max(0, total);
  if (message) out.message = message;
  return Object.keys(out).length ? out : null;
}
async function requireOwnedDevice({ userId, deviceId }) {
  const device = await prisma.workerDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== userId) throw new JobLeaseError("NOT_YOUR_DEVICE", "Invalid device", 403);
  const member = await prisma.agencyMember.findFirst({
    where: { agencyId: device.agencyId, userId, deletedAt: null, agency: { deletedAt: null } },
    select: { id: true },
  });
  if (!member) throw new JobLeaseError("DEVICE_AGENCY_ACCESS_REVOKED", "Device agency access was revoked", 403);
  return device;
}
async function scopedCreatorIds({ userId, device }) {
  const member = await prisma.agencyMember.findFirst({
    where: { agencyId: device.agencyId, userId, deletedAt: null, agency: { deletedAt: null } },
  });
  if (!member) return [];
  const roleKey = String(member.roleKey || "").toLowerCase();
  const broad = member.role === "OWNER" || member.role === "MANAGER" || roleKey === "owner" || roleKey === "manager" || !member.assignedCreators || member.assignedCreators === "all";
  const creators = await prisma.creatorAccount.findMany({
    where: {
      agencyId: device.agencyId,
      deletedAt: null,
      status: "READY",
      ...(!broad ? { id: { in: Array.isArray(member.assignedCreators) ? member.assignedCreators.map(String).filter(Boolean) : ["__none__"] } } : {}),
    },
    select: { id: true },
    take: 10000,
  });
  const visibleIds = creators.map((item) => item.id);
  if (!visibleIds.length) return [];
  const freshAfter = new Date(Date.now() - 2 * 60 * 1000);
  const bindings = await prisma.deviceCreatorBinding.findMany({
    where: {
      agencyId: device.agencyId,
      deviceId: device.id,
      status: "ACTIVE",
      lastSeenAt: { gte: freshAfter },
      creatorId: { in: visibleIds },
    },
    select: { creatorId: true },
    take: 10000,
  });
  // A device may claim work only for creators it advertised as READY in a
  // recent heartbeat. Role visibility is necessary, but never sufficient.
  return bindings.map((item) => item.creatorId);
}
async function sweepExpiredLeases(now = new Date()) {
  const terminal = await prisma.jobInstance.updateMany({
    where: {
      status: "CLAIMED",
      leaseUntil: { lt: now },
      attempts: { gte: MAX_ATTEMPTS - 1 },
    },
    data: {
      status: "FAILED",
      attempts: { increment: 1 },
      completedAt: now,
      lastError: "lease expired",
      claimedAt: null,
      claimedByDeviceId: null,
      leaseUntil: null,
      leaseTokenHash: null,
      workId: null,
    },
  });
  const retry = await prisma.jobInstance.updateMany({
    where: {
      status: "CLAIMED",
      leaseUntil: { lt: now },
      attempts: { lt: MAX_ATTEMPTS - 1 },
    },
    data: {
      status: "SCHEDULED",
      attempts: { increment: 1 },
      nextRunAt: new Date(now.getTime() + RETRY_BACKOFF_MS),
      lastError: "lease expired",
      claimedAt: null,
      claimedByDeviceId: null,
      leaseUntil: null,
      leaseTokenHash: null,
      workId: null,
    },
  });
  return terminal.count + retry.count;
}
async function claimJob({ userId, deviceId, leaseMs, jobKeys }) {
  const device = await requireOwnedDevice({ userId, deviceId });
  await sweepExpiredLeases();
  if (!device.lastSeenAt || device.lastSeenAt < new Date(Date.now() - 5 * 60 * 1000)) return { job: null, reason: "device-stale" };
  const creatorIds = await scopedCreatorIds({ userId, device });
  if (!creatorIds.length) return { job: null, reason: "no-creators-visible" };
  const allowedJobKeys = filterClaimableDesktopJobKeys(jobKeys);
  if (!allowedJobKeys.length) return { job: null, reason: "no-capabilities" };
  const now = new Date();
  for (let race = 0; race < 5; race += 1) {
    const candidate = await prisma.jobInstance.findFirst({
      where: {
        status: "SCHEDULED", nextRunAt: { lte: now }, attempts: { lt: MAX_ATTEMPTS }, jobKey: { in: allowedJobKeys },
        creatorId: { in: creatorIds },
      },
      orderBy: [{ priority: "desc" }, { nextRunAt: "asc" }],
    });
    if (!candidate) return { job: null, reason: "no-work" };
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const until = new Date(now.getTime() + leaseDuration(leaseMs));
    const updated = await prisma.jobInstance.updateMany({
      where: {
        id: candidate.id,
        status: "SCHEDULED",
        nextRunAt: { lte: now },
        attempts: { lt: MAX_ATTEMPTS },
        jobKey: { in: allowedJobKeys },
        creatorId: { in: creatorIds },
      },
      data: {
        status: "CLAIMED", claimedAt: now, claimedByDeviceId: device.id, leaseUntil: until,
        leaseTokenHash: hashToken(leaseToken), leaseRevision: { increment: 1 }, startedAt: candidate.startedAt || now, lastError: null,
      },
    });
    if (!updated.count) continue;
    const claimed = await prisma.jobInstance.findUnique({
      where: { id: candidate.id },
      include: { creator: { select: { id: true, remoteId: true, username: true, displayName: true, partition: true } } },
    });
    if (!claimed) continue;
    return {
      job: {
        id: claimed.id, jobKey: claimed.jobKey, scope: claimed.scope, creatorId: claimed.creatorId, agencyId: claimed.agencyId,
        idempotencyKey: claimed.idempotencyKey, params: claimed.params || {}, priority: claimed.priority, creator: claimed.creator || null,
        attempt: claimed.attempts + 1, leaseUntil: claimed.leaseUntil, leaseToken, leaseRevision: claimed.leaseRevision,
        workId: claimed.workId, continuation: claimed.continuation, progress: claimed.progress,
      },
      reason: "claimed",
    };
  }
  return { job: null, reason: "race-lost" };
}
async function requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision, allowExpired = false }) {
  const device = await requireOwnedDevice({ userId, deviceId });
  const job = await prisma.jobInstance.findUnique({ where: { id: jobId } });
  if (!job) throw new JobLeaseError("JOB_NOT_FOUND", "Job not found", 404);
  if (job.agencyId && job.agencyId !== device.agencyId) throw new JobLeaseError("JOB_DEVICE_AGENCY_MISMATCH", "Job belongs to a different device agency", 403);
  if (job.status !== "CLAIMED") throw new JobLeaseError("JOB_NOT_CLAIMED", `Job status is ${job.status}`);
  if (job.claimedByDeviceId !== deviceId) throw new JobLeaseError("JOB_CLAIMED_BY_OTHER", "Job is claimed by a different device");
  if (!tokenMatches(leaseToken, job.leaseTokenHash)) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease token is stale");
  if (!Number.isInteger(leaseRevision) || job.leaseRevision !== leaseRevision) throw new JobLeaseError("JOB_LEASE_REVISION_STALE", "Job lease revision is stale");
  if (!allowExpired && (!job.leaseUntil || job.leaseUntil.getTime() <= Date.now())) throw new JobLeaseError("JOB_LEASE_EXPIRED", "Job lease expired");
  return job;
}
async function renewLease({ jobId, userId, deviceId, leaseToken, leaseRevision, leaseMs, workId, progress, continuation }) {
  const job = await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision });
  const now = new Date();
  const tokenHash = hashToken(leaseToken);
  const result = await prisma.jobInstance.updateMany({
    where: { id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: tokenHash, leaseRevision, leaseUntil: { gt: now } },
    data: {
      leaseUntil: new Date(now.getTime() + leaseDuration(leaseMs)), workId: clean(workId, 200) || job.workId,
      progress: safeProgress(progress) ?? job.progress, continuation: continuation === undefined ? job.continuation : continuation,
      lastProgressAt: progress === undefined && continuation === undefined ? job.lastProgressAt : now,
    },
  });
  if (!result.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before renewal");
  const updated = await prisma.jobInstance.findUnique({ where: { id: job.id } });
  return { id: updated.id, status: updated.status, leaseUntil: updated.leaseUntil, leaseRevision: updated.leaseRevision, progress: updated.progress, continuation: updated.continuation };
}
async function completeJob({ jobId, userId, deviceId, leaseToken, leaseRevision, workId, result, progress }) {
  const job = await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision });
  const sideEffect = await applyJobResult({ job, deviceId, userId, result: result || {} });
  const now = new Date();
  const updated = await prisma.jobInstance.updateMany({
    where: { id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: hashToken(leaseToken), leaseRevision, leaseUntil: { gt: now } },
    data: {
      status: "DONE", completedAt: now, leaseUntil: null, leaseTokenHash: null, workId: clean(workId, 200) || job.workId,
      continuation: null, progress: safeProgress(progress) || { percent: 100, message: "completed" }, lastProgressAt: now,
      result: result || null, lastError: null,
    },
  });
  if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before completion");
  return { job: { id: job.id, status: "DONE" }, sideEffect };
}
async function failJob({ jobId, userId, deviceId, leaseToken, leaseRevision, workId, error, result, retryable = true }) {
  const job = await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision, allowExpired: true });
  const errorText = clean(error, 2000) || "unknown error";
  const attempts = job.attempts + 1;
  const terminal = retryable === false || attempts >= MAX_ATTEMPTS;
  const now = new Date();
  const data = terminal ? {
    status: "FAILED", attempts, lastError: errorText, result: result || null, completedAt: now, claimedAt: null,
    claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: clean(workId, 200) || job.workId,
  } : {
    status: "SCHEDULED", attempts, lastError: errorText, result: result || null,
    nextRunAt: new Date(now.getTime() + RETRY_BACKOFF_MS * (2 ** Math.max(0, attempts - 1))), claimedAt: null,
    claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: null,
  };
  const updated = await prisma.jobInstance.updateMany({
    where: { id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: hashToken(leaseToken), leaseRevision },
    data,
  });
  if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before failure report");
  try { await recordJobFailure({ job, error: errorText }); } catch (_) {}
  return { id: job.id, status: terminal ? "FAILED" : "SCHEDULED", terminal, retryAt: terminal ? null : data.nextRunAt };
}

async function releaseJob({ jobId, userId, deviceId, leaseToken, leaseRevision, workId, reason, runAfterMs = 30_000 }) {
  const job = await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision, allowExpired: true });
  const now = new Date();
  const delay = Math.max(1_000, Math.min(15 * 60_000, Math.floor(Number(runAfterMs) || 30_000)));
  const updated = await prisma.jobInstance.updateMany({
    where: {
      id: job.id,
      status: "CLAIMED",
      claimedByDeviceId: deviceId,
      leaseTokenHash: hashToken(leaseToken),
      leaseRevision,
    },
    data: {
      status: "SCHEDULED",
      nextRunAt: new Date(now.getTime() + delay),
      lastError: clean(reason, 2000) || "worker released lease",
      claimedAt: null,
      claimedByDeviceId: null,
      leaseUntil: null,
      leaseTokenHash: null,
      workId: clean(workId, 200) || job.workId,
    },
  });
  if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before release");
  return { id: job.id, status: "SCHEDULED", retryAt: new Date(now.getTime() + delay), attempts: job.attempts };
}
module.exports = { JobLeaseError, claimJob, renewLease, completeJob, failJob, releaseJob, sweepExpiredLeases };
