"use strict";

const prisma = require("../prisma");
const { publishDesktopControlEvent } = require("./desktop-control-events");
const { JOB_CATALOG } = require("./job-catalog");

const DEFAULT_PROTECTED_STATUSES = Object.freeze(["CLAIMED"]);

function asDate(value, fallback = new Date()) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(value || fallback);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function clean(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function normalizePriority(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertPlannableJobKey(value) {
  const normalizedJobKey = clean(value, 120);
  if (!normalizedJobKey) throw new Error("JOB_PLANNING_JOB_KEY_REQUIRED");
  if (!Object.prototype.hasOwnProperty.call(JOB_CATALOG, normalizedJobKey)) {
    const error = new Error("JOB_PLANNING_UNKNOWN_JOB_KEY");
    error.code = "JOB_PLANNING_UNKNOWN_JOB_KEY";
    error.jobKey = normalizedJobKey;
    throw error;
  }
  return normalizedJobKey;
}

function publishPlannedJobAvailable(job) {
  if (!job?.id || !job?.agencyId) return null;
  try {
    return publishDesktopControlEvent({
      type: "JOB_AVAILABLE",
      agencyId: job.agencyId,
      creatorId: job.creatorId || null,
      jobId: job.id,
      jobKind: job.jobKey || null,
    });
  } catch (error) {
    console.error("[job-planning/control-job-available] failed:", error);
    return null;
  }
}

function scheduledCreateData({
  jobKey,
  scope = "creator",
  creatorId = null,
  agencyId = null,
  idempotencyKey = null,
  params = {},
  priority = 0,
  scheduledAt = new Date(),
  nextRunAt = scheduledAt,
  continuation = null,
  progress = null,
} = {}) {
  const normalizedJobKey = assertPlannableJobKey(jobKey);
  return {
    jobKey: normalizedJobKey,
    scope: clean(scope, 80) || "creator",
    creatorId: clean(creatorId, 180),
    agencyId: clean(agencyId, 180),
    idempotencyKey: clean(idempotencyKey, 320),
    params: params && typeof params === "object" ? params : {},
    status: "SCHEDULED",
    priority: normalizePriority(priority, 0),
    scheduledAt: asDate(scheduledAt),
    nextRunAt: asDate(nextRunAt, asDate(scheduledAt)),
    continuation: continuation ?? null,
    progress: progress ?? null,
  };
}

function scheduledResetData({
  params = {},
  priority = 0,
  scheduledAt = new Date(),
  nextRunAt = scheduledAt,
  continuation = null,
  progress = null,
  lastProgressAt = null,
  startedAt = null,
  resetAttempts = true,
} = {}) {
  const data = {
    status: "SCHEDULED",
    params: params && typeof params === "object" ? params : {},
    priority: normalizePriority(priority, 0),
    scheduledAt: asDate(scheduledAt),
    nextRunAt: asDate(nextRunAt, asDate(scheduledAt)),
    claimedAt: null,
    claimedByDeviceId: null,
    leaseUntil: null,
    leaseTokenHash: null,
    leaseMemberId: null,
    leaseAccessEpoch: null,
    leaseRevision: { increment: 1 },
    workId: null,
    continuation: continuation ?? null,
    progress: progress ?? null,
    lastProgressAt: lastProgressAt ?? null,
    startedAt: startedAt ?? null,
    completedAt: null,
    lastError: null,
    result: null,
  };
  if (resetAttempts) data.attempts = 0;
  return data;
}

async function createPlannedJob({ db = prisma, publish = true, ...input } = {}) {
  const job = await db.jobInstance.create({ data: scheduledCreateData(input) });
  if (publish) publishPlannedJobAvailable(job);
  return job;
}

async function createPlannedJobIfAbsent({ db = prisma, publish = true, ...input } = {}) {
  const data = scheduledCreateData(input);
  if (!data.idempotencyKey) {
    const job = await db.jobInstance.create({ data });
    if (publish) publishPlannedJobAvailable(job);
    return { job, created: true, reason: "created" };
  }

  let inserted = false;
  if (typeof db.jobInstance.createMany === "function") {
    const result = await db.jobInstance.createMany({ data: [data], skipDuplicates: true });
    inserted = Number(result?.count || 0) > 0;
  } else {
    try {
      await db.jobInstance.create({ data });
      inserted = true;
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
  }

  const job = await db.jobInstance.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
  if (!job) throw new Error(`JOB_PLANNING_IDEMPOTENCY_READBACK_FAILED:${data.idempotencyKey}`);
  if (inserted && publish) publishPlannedJobAvailable(job);
  return { job, created: inserted, reason: inserted ? "created" : "idempotency_reused" };
}

async function reschedulePlannedJob({
  db = prisma,
  job,
  jobId = job?.id,
  params = job?.params || {},
  priority = job?.priority || 0,
  scheduledAt = new Date(),
  nextRunAt = scheduledAt,
  continuation = null,
  progress = null,
  lastProgressAt = null,
  startedAt = null,
  protectedStatuses = DEFAULT_PROTECTED_STATUSES,
  resetAttempts = true,
  publish = true,
} = {}) {
  if (job?.jobKey) assertPlannableJobKey(job.jobKey);
  const id = clean(jobId, 180);
  if (!id) throw new Error("JOB_PLANNING_JOB_ID_REQUIRED");
  const protectedSet = new Set((protectedStatuses || []).map((value) => String(value || "").trim()).filter(Boolean));
  if (job?.status && protectedSet.has(job.status)) {
    return { job, rescheduled: false, reason: `protected_${String(job.status).toLowerCase()}` };
  }

  const where = { id };
  if (protectedSet.size > 0) where.status = { notIn: [...protectedSet] };
  if (job && Number.isInteger(Number(job.leaseRevision))) where.leaseRevision = Number(job.leaseRevision);

  const updated = await db.jobInstance.updateMany({
    where,
    data: scheduledResetData({ params, priority, scheduledAt, nextRunAt, continuation, progress, lastProgressAt, startedAt, resetAttempts }),
  });
  if (!Number(updated?.count || 0)) {
    const current = await db.jobInstance.findUnique({ where: { id } });
    return { job: current, rescheduled: false, reason: current?.status ? `race_${String(current.status).toLowerCase()}` : "race_lost" };
  }
  const current = await db.jobInstance.findUnique({ where: { id } });
  if (!current) throw new Error(`JOB_PLANNING_RESET_READBACK_FAILED:${id}`);
  if (publish) publishPlannedJobAvailable(current);
  return { job: current, rescheduled: true, reason: "rescheduled" };
}

async function updatePlannedJobDemand({
  db = prisma,
  job,
  priority = job?.priority || 0,
  params = job?.params || {},
  nextRunAt = null,
  publish = true,
} = {}) {
  if (job?.jobKey) assertPlannableJobKey(job.jobKey);
  if (!job?.id) throw new Error("JOB_PLANNING_JOB_ID_REQUIRED");
  if (!["SCHEDULED", "CLAIMED"].includes(String(job.status || ""))) {
    return { job, updated: false, reason: `not_demand_mutable_${String(job.status || "unknown").toLowerCase()}` };
  }
  const where = { id: job.id, status: job.status };
  if (Number.isInteger(Number(job.leaseRevision))) where.leaseRevision = Number(job.leaseRevision);
  const data = {
    priority: Math.max(normalizePriority(job.priority, 0), normalizePriority(priority, 0)),
    params: params && typeof params === "object" ? params : {},
  };
  if (job.status === "SCHEDULED" && nextRunAt) data.nextRunAt = asDate(nextRunAt);
  const updated = await db.jobInstance.updateMany({ where, data });
  if (!Number(updated?.count || 0)) {
    const current = await db.jobInstance.findUnique({ where: { id: job.id } });
    return { job: current, updated: false, reason: "race_lost" };
  }
  const current = await db.jobInstance.findUnique({ where: { id: job.id } });
  if (!current) throw new Error(`JOB_PLANNING_DEMAND_READBACK_FAILED:${job.id}`);
  if (publish && current.status === "SCHEDULED") publishPlannedJobAvailable(current);
  return { job: current, updated: true, reason: "updated" };
}

async function ensurePlannedJob({
  db = prisma,
  publish = true,
  resetExisting = false,
  shouldResetExisting = null,
  protectedStatuses = DEFAULT_PROTECTED_STATUSES,
  ...input
} = {}) {
  assertPlannableJobKey(input.jobKey);
  const idempotencyKey = clean(input.idempotencyKey, 320);
  if (!idempotencyKey) {
    const job = await createPlannedJob({ db, publish, ...input });
    return { job, created: true, rescheduled: false, reason: "created" };
  }

  let existing = await db.jobInstance.findUnique({ where: { idempotencyKey } });
  if (!existing) {
    const created = await createPlannedJobIfAbsent({ db, publish, ...input, idempotencyKey });
    if (created.created) return { job: created.job, created: true, rescheduled: false, reason: created.reason };
    existing = created.job;
  }

  const wantsReset = typeof shouldResetExisting === "function"
    ? shouldResetExisting(existing) === true
    : resetExisting === true;
  if (!wantsReset) return { job: existing, created: false, rescheduled: false, reason: "reused" };

  const reset = await reschedulePlannedJob({
    db,
    job: existing,
    params: input.params,
    priority: input.priority,
    scheduledAt: input.scheduledAt,
    nextRunAt: input.nextRunAt,
    continuation: input.continuation,
    progress: input.progress,
    lastProgressAt: input.lastProgressAt,
    startedAt: input.startedAt,
    protectedStatuses,
    resetAttempts: input.resetAttempts !== false,
    publish,
  });
  return { job: reset.job, created: false, rescheduled: reset.rescheduled, reason: reset.reason };
}

module.exports = {
  DEFAULT_PROTECTED_STATUSES,
  assertPlannableJobKey,
  scheduledCreateData,
  scheduledResetData,
  publishPlannedJobAvailable,
  createPlannedJob,
  createPlannedJobIfAbsent,
  reschedulePlannedJob,
  updatePlannedJobDemand,
  ensurePlannedJob,
};
