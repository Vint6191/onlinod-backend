"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { applyJobChunk, applyJobResult, recordJobFailure } = require("./job-result-service");
const { filterClaimableDesktopJobKeys } = require("./job-catalog");
const { completeDialogJobFenced } = require("./dialog-job-completion-fence");

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MIN_LEASE_MS = 30 * 1000;
const MAX_LEASE_MS = 15 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_NOTIFICATION_REPAIR_PASSES = 100;
const JOB_CHUNK_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 30_000 });
const JOB_COMPLETION_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 60_000 });
const DIALOG_INTELLIGENCE_JOB_KEY = "dialog_intelligence_scan";
const DIALOG_DISCOVERY_DIALOG_ID = "__dialog_discovery__";

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
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function waitKind(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("creator execution context unavailable")) return "creator_context";
  if (text.includes("worker stopped") || text.includes("worker disabled")) return "worker_shutdown";
  return "worker_release";
}
function clearWaitProgress(value) {
  const progress = { ...object(value) };
  delete progress.waitKind;
  delete progress.waitReason;
  delete progress.waitingSince;
  delete progress.retryAt;
  return Object.keys(progress).length ? progress : null;
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

async function maybeAdvanceCreatorAnalyticsInitialSync(job, sideEffect) {
  try {
    const { advanceCreatorAnalyticsInitialSyncAfterCompletion } = require("./creator-analytics-sync-orchestrator");
    return await advanceCreatorAnalyticsInitialSyncAfterCompletion({ job, sideEffect });
  } catch (error) {
    console.warn("[creator-analytics-sync] failed to advance initial pipeline:", job?.id || null, error?.message || error);
    return null;
  }
}

function dialogDiscoveryClaimConstraint(enabled) {
  if (enabled !== true) return null;
  return {
    OR: [
      // Every non-dialog job requested by this worker remains claimable.
      { jobKey: { not: DIALOG_INTELLIGENCE_JOB_KEY } },
      // The shared dialog job key is claimable only for creator-wide discovery.
      // Per-dialog history is owned exclusively by DialogHistoryBatchRunner.
      {
        jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
        params: { path: ["dialogId"], equals: DIALOG_DISCOVERY_DIALOG_ID },
      },
    ],
  };
}

function claimCandidateWhere({ allowedJobKeys, eligibleCreatorIds, now, dialogDiscoveryOnly }) {
  const discoveryConstraint = dialogDiscoveryClaimConstraint(dialogDiscoveryOnly);
  return {
    status: "SCHEDULED",
    nextRunAt: { lte: now },
    attempts: { lt: MAX_ATTEMPTS },
    jobKey: { in: allowedJobKeys },
    creatorId: { in: eligibleCreatorIds },
    ...(discoveryConstraint ? { AND: [discoveryConstraint] } : {}),
  };
}
function safeProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = object(value);
  const out = {};
  const numericFields = [
    "percent", "current", "total", "pages", "rawMessages", "messages",
    "skippedMessages", "media", "offset", "status", "pageStart", "pageEnd",
    "pagesInBatch", "messageCount", "mediaCount", "inserted", "updated",
    "unchanged", "localUncheckpointedMessages", "scanned", "knownStreak",
  ];
  for (const field of numericFields) {
    const parsed = Number(source[field]);
    if (!Number.isFinite(parsed)) continue;
    out[field] = field === "percent"
      ? Math.max(0, Math.min(100, parsed))
      : Math.max(0, parsed);
  }
  const stringLimits = {
    message: 500,
    stage: 80,
    mode: 40,
    dialogId: 200,
    cursorType: 40,
    cursorIn: 300,
    cursor: 300,
    endpointKey: 160,
    storage: 80,
    checkpointMode: 80,
  };
  for (const [field, max] of Object.entries(stringLimits)) {
    const normalized = clean(source[field], max);
    if (normalized) out[field] = normalized;
  }
  if (source.live === true) out.live = true;
  return Object.keys(out).length ? out : null;
}

/**
 * JobInstance.continuation historically existed in two shapes: a plain
 * domain continuation and the Desktop driver envelope. Older Desktop builds
 * could repeatedly wrap an already-enveloped value after a restart:
 * execute -> execute -> execute -> domain state. Prisma/PostgreSQL eventually
 * rejects that deeply nested JSON with "recursion limit exceeded".
 *
 * Normalize iteratively (never recursively) so an existing poisoned job is
 * healed by its next progress/renewal request. The domain payload itself stays
 * transport-neutral; this boundary is also the future server-worker handoff.
 */
function normalizeLeaseContinuation(value) {
  let current = value;
  for (let depth = 0; depth < 10000; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return current ?? null;
    const phase = current.driverPhase;
    if (phase === "complete") {
      return {
        driverPhase: "complete",
        result: current.result ?? null,
        progress: safeProgress(current.progress) ?? current.progress ?? null,
      };
    }
    if (phase !== "execute") return current;
    const nested = current.jobContinuation ?? null;
    if (nested && typeof nested === "object" && !Array.isArray(nested)
      && (nested.driverPhase === "execute" || nested.driverPhase === "complete")) {
      current = nested;
      continue;
    }
    return { driverPhase: "execute", jobContinuation: nested };
  }
  throw new JobLeaseError("JOB_CONTINUATION_TOO_DEEP", "Job continuation nesting is invalid", 409);
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
async function claimJob({ userId, deviceId, leaseMs, jobKeys, excludedCreatorIds = [], dialogDiscoveryOnly = false }) {
  const device = await requireOwnedDevice({ userId, deviceId });
  await sweepExpiredLeases();
  if (!device.lastSeenAt || device.lastSeenAt < new Date(Date.now() - 5 * 60 * 1000)) return { job: null, reason: "device-stale" };
  const creatorIds = await scopedCreatorIds({ userId, device });
  if (!creatorIds.length) return { job: null, reason: "no-creators-visible" };
  const allowedJobKeys = filterClaimableDesktopJobKeys(jobKeys);
  if (!allowedJobKeys.length) return { job: null, reason: "no-capabilities" };
  const now = new Date();
  const explicitlyExcluded = new Set(
    (Array.isArray(excludedCreatorIds) ? excludedCreatorIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  // Do not globally lock a creator at the durable-job layer. Different devices
  // may prepare independent workflows (for example dialog history and the
  // Messages catalog), while writes use their own delivery worker. Physical OF
  // request starts are globally serialized by the shared request-gate service at 700ms.
  // A Desktop still sends excludedCreatorIds for lanes it cannot execute locally,
  // preventing parked leases without blocking useful work on another device.
  const eligibleCreatorIds = creatorIds.filter((creatorId) => !explicitlyExcluded.has(creatorId));
  if (!eligibleCreatorIds.length) return { job: null, reason: "creators-busy" };
  for (let race = 0; race < 5; race += 1) {
    const candidateWhere = claimCandidateWhere({
      allowedJobKeys,
      eligibleCreatorIds,
      now,
      dialogDiscoveryOnly,
    });
    const candidate = await prisma.jobInstance.findFirst({
      where: candidateWhere,
      orderBy: [{ priority: "desc" }, { nextRunAt: "asc" }],
    });
    if (!candidate) return { job: null, reason: "no-work" };
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const until = new Date(now.getTime() + leaseDuration(leaseMs));
    const updated = await prisma.jobInstance.updateMany({
      where: {
        id: candidate.id,
        ...claimCandidateWhere({
          allowedJobKeys,
          eligibleCreatorIds,
          now,
          dialogDiscoveryOnly,
        }),
      },
      data: {
        status: "CLAIMED", claimedAt: now, claimedByDeviceId: device.id, leaseUntil: until,
        leaseTokenHash: hashToken(leaseToken), leaseRevision: { increment: 1 }, startedAt: candidate.startedAt || now, lastError: null,
        progress: clearWaitProgress(candidate.progress),
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
        workId: claimed.workId, continuation: normalizeLeaseContinuation(claimed.continuation), progress: claimed.progress,
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
  // Normalize in memory before any lease/result service consumes this job. This
  // protects side effects from legacy execute->execute nesting even before the
  // next durable checkpoint rewrites the database row in canonical form.
  job.continuation = normalizeLeaseContinuation(job.continuation);
  return job;
}
async function renewLease({ jobId, userId, deviceId, leaseToken, leaseRevision, leaseMs, workId, progress, continuation }) {
  const job = await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision });
  const now = new Date();
  const tokenHash = hashToken(leaseToken);
  const data = {
    leaseUntil: new Date(now.getTime() + leaseDuration(leaseMs)),
  };
  if (workId !== undefined) data.workId = clean(workId, 200) || job.workId;
  const normalizedProgress = safeProgress(progress);
  if (normalizedProgress) data.progress = normalizedProgress;
  if (continuation !== undefined) data.continuation = normalizeLeaseContinuation(continuation);
  if (normalizedProgress || continuation !== undefined) data.lastProgressAt = now;
  // A pure keepalive must update only leaseUntil. Rewriting an unchanged JSON
  // continuation made one poisoned legacy value break every heartbeat forever.
  const result = await prisma.jobInstance.updateMany({
    where: { id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: tokenHash, leaseRevision, leaseUntil: { gt: now } },
    data,
  });
  if (!result.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before renewal");
  const updated = await prisma.jobInstance.findUnique({ where: { id: job.id } });
  return {
    id: updated.id,
    status: updated.status,
    leaseUntil: updated.leaseUntil,
    leaseRevision: updated.leaseRevision,
    progress: updated.progress,
    continuation: normalizeLeaseContinuation(updated.continuation),
  };
}
async function progressJob({ jobId, userId, deviceId, leaseToken, leaseRevision, leaseMs, workId, progress, continuation, chunkResult }) {
  const job = await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision });
  const now = new Date();
  const tokenHash = hashToken(leaseToken);
  const nextLeaseUntil = new Date(now.getTime() + leaseDuration(leaseMs));
  const normalizedProgress = safeProgress(progress) ?? job.progress;
  const requestedContinuation = continuation === undefined
    ? job.continuation
    : normalizeLeaseContinuation(continuation);

  return prisma.$transaction(async (tx) => {
    const updatedFence = await tx.jobInstance.updateMany({
      where: {
        id: job.id,
        status: "CLAIMED",
        claimedByDeviceId: deviceId,
        leaseTokenHash: tokenHash,
        leaseRevision,
        leaseUntil: { gt: now },
      },
      data: {
        leaseUntil: nextLeaseUntil,
        workId: clean(workId, 200) || job.workId,
        progress: normalizedProgress,
        continuation: requestedContinuation,
        lastProgressAt: now,
      },
    });
    if (!updatedFence.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before progress");

    const sideEffect = await applyJobChunk({ db: tx, job, deviceId, userId, chunkResult });
    let updated = null;
    if (sideEffect?.completeAfterCommit === true) {
      updated = await tx.jobInstance.update({
        where: { id: job.id },
        data: {
          continuation: {
            driverPhase: "complete",
            result: sideEffect.completionResult || {},
            progress: normalizedProgress,
          },
        },
      });
    } else if (sideEffect?.jobContinuationOverride) {
      updated = await tx.jobInstance.update({
        where: { id: job.id },
        data: {
          continuation: {
            driverPhase: "execute",
            jobContinuation: sideEffect.jobContinuationOverride,
          },
        },
      });
    }

    // update() already returns the row. Avoid a final findUnique round-trip on
    // every checkpoint; hosted Postgres latency made that redundant read part
    // of the 5-second Prisma transaction timeout failure.
    if (!updated) {
      updated = {
        id: job.id,
        status: job.status,
        leaseUntil: nextLeaseUntil,
        leaseRevision: job.leaseRevision,
        progress: normalizedProgress,
        continuation: requestedContinuation,
      };
    }
    return {
      id: updated.id,
      status: updated.status,
      leaseUntil: updated.leaseUntil,
      leaseRevision: updated.leaseRevision,
      progress: updated.progress,
      continuation: updated.continuation,
      sideEffect,
    };
  }, JOB_CHUNK_TRANSACTION_OPTIONS);
}

async function completeJob({ jobId, userId, deviceId, leaseToken, leaseRevision, workId, result, progress }) {
  const job = await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision });
  const now = new Date();
  const fenceWhere = {
    id: job.id,
    status: "CLAIMED",
    claimedByDeviceId: deviceId,
    leaseTokenHash: hashToken(leaseToken),
    leaseRevision,
    leaseUntil: { gt: now },
  };
  const completionData = {
    status: "DONE",
    completedAt: now,
    leaseUntil: null,
    leaseTokenHash: null,
    workId: clean(workId, 200) || job.workId,
    continuation: null,
    progress: safeProgress(progress) || { percent: 100, message: "completed" },
    lastProgressAt: now,
    result: result || null,
    lastError: null,
  };

  // Jobs whose completion mutates durable projections must fence the lease
  // before applying those mutations. Otherwise a reclaimed worker could write
  // a stale snapshot after another device has already taken ownership.
  if (job.jobKey === "dialog_intelligence_scan") {
    return prisma.$transaction(async (tx) => {
      const { sideEffect } = await completeDialogJobFenced({
        tx,
        fenceWhere,
        completionData,
        staleError: () => new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before completion"),
        applySideEffect: (db) => applyJobResult({ db, job, deviceId, userId, result: result || {} }),
      });
      return { job: { id: job.id, status: "DONE" }, sideEffect };
    }, JOB_COMPLETION_TRANSACTION_OPTIONS);
  }

  if (["fetch_earnings", "fetch_campaigns"].includes(job.jobKey)) {
    // These jobs write durable relational projections. Reserve completion
    // ownership before any side effect so a reclaimed worker cannot publish a
    // stale earnings/campaign snapshot after another device takes the lease.
    const completionLeaseRevision = leaseRevision + 1;
    const reserved = await prisma.jobInstance.updateMany({
      where: fenceWhere,
      data: {
        leaseRevision: { increment: 1 },
        leaseUntil: new Date(now.getTime() + MAX_LEASE_MS),
        lastProgressAt: now,
      },
    });
    if (!reserved.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before analytics completion");

    const sideEffect = await applyJobResult({ job, deviceId, userId, result: result || {} });
    const completionFence = {
      id: job.id,
      status: "CLAIMED",
      claimedByDeviceId: deviceId,
      leaseTokenHash: hashToken(leaseToken),
      leaseRevision: completionLeaseRevision,
    };
    if (sideEffect?.ok !== true) {
      const attempts = Number(job.attempts || 0) + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const retryAt = terminal ? null : new Date(Date.now() + RETRY_BACKOFF_MS * (2 ** Math.max(0, attempts - 1)));
      const partial = await prisma.jobInstance.updateMany({
        where: completionFence,
        data: terminal ? {
          status: "FAILED",
          attempts,
          completedAt: new Date(),
          claimedAt: null,
          claimedByDeviceId: null,
          leaseUntil: null,
          leaseTokenHash: null,
          continuation: null,
          workId: null,
          result: { ...(result || {}), completionSideEffect: sideEffect || null },
          lastError: `${job.jobKey}_partial`,
        } : {
          status: "SCHEDULED",
          attempts,
          nextRunAt: retryAt,
          completedAt: null,
          claimedAt: null,
          claimedByDeviceId: null,
          leaseUntil: null,
          leaseTokenHash: null,
          continuation: null,
          workId: null,
          result: { ...(result || {}), completionSideEffect: sideEffect || null },
          lastError: `${job.jobKey}_partial`,
          progress: { percent: 0, message: `${job.jobKey} scheduled for repair` },
        },
      });
      if (!partial.count) throw new JobLeaseError("JOB_LEASE_STALE", "Analytics partial-completion fence was lost");
      return { job: { id: job.id, status: terminal ? "FAILED" : "SCHEDULED", retryAt }, sideEffect };
    }
    const completed = await prisma.jobInstance.updateMany({ where: completionFence, data: completionData });
    if (!completed.count) throw new JobLeaseError("JOB_LEASE_STALE", "Analytics completion fence was lost");
    await maybeAdvanceCreatorAnalyticsInitialSync(job, sideEffect);
    return { job: { id: job.id, status: "DONE" }, sideEffect };
  }

  if (job.jobKey === "catchup_notifications_scan") {
    // Reserve completion ownership before any ledger/compatibility side effect.
    // The compatibility projection can touch legacy tip/subscription ledgers,
    // so keep the fenced completion lease at the maximum supported duration.
    // Incrementing leaseRevision is the fence: only one concurrent completion
    // request can cross it. If the process dies after writing facts, the job is
    // safely reclaimed later and the notification ingest is idempotent by jobId.
    const completionLeaseRevision = leaseRevision + 1;
    const reserved = await prisma.jobInstance.updateMany({
      where: fenceWhere,
      data: {
        leaseRevision: { increment: 1 },
        leaseUntil: new Date(now.getTime() + MAX_LEASE_MS),
        lastProgressAt: now,
      },
    });
    if (!reserved.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before notification completion");

    const sideEffect = await applyJobResult({ job, deviceId, userId, result: result || {} });
    const completionFence = {
      id: job.id,
      status: "CLAIMED",
      claimedByDeviceId: deviceId,
      leaseTokenHash: hashToken(leaseToken),
      leaseRevision: completionLeaseRevision,
    };
    if (sideEffect?.ok !== true) {
      const existingParams = object(job.params);
      // Creator Analytics notification scans are manual during development.
      // Reaching hasMore=false with rejected/ignored facts must stop and expose
      // the PARTIAL result to the inspector; never silently schedule another
      // full repair pass behind the operator's back.
      if (existingParams.manualNotificationScan === true) {
        const partial = await prisma.jobInstance.updateMany({
          where: completionFence,
          data: {
            status: "DONE",
            completedAt: new Date(),
            claimedAt: null,
            claimedByDeviceId: null,
            leaseUntil: null,
            leaseTokenHash: null,
            continuation: null,
            workId: null,
            result: { ...(result || {}), completionSideEffect: sideEffect || null },
            lastError: "notification_scan_partial",
            progress: { percent: 100, message: "notification scan completed with rejected facts" },
          },
        });
        if (!partial.count) throw new JobLeaseError("JOB_LEASE_STALE", "Notification manual completion fence was lost");
        return { job: { id: job.id, status: "DONE" }, sideEffect };
      }
      const requestedTypes = Array.isArray(sideEffect?.summary?.requestedTypes)
        ? sideEffect.summary.requestedTypes.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
        : Array.isArray(existingParams.types) ? existingParams.types : [];
      const persistedCoverage = object(sideEffect?.summary?.analyticsCoverageByType);
      const partialTypes = requestedTypes.filter((type) => persistedCoverage[type] !== "complete");
      const scannerCoverage = object(result?.coverage);
      const resumeCursors = {};
      for (const type of partialTypes) {
        const typeCoverage = object(scannerCoverage[type]);
        const reason = String(typeCoverage.reason || "").toLowerCase();
        const rejected = Number(typeCoverage.rejected || 0);
        const cursor = clean(typeCoverage.cursorEnd, 220);
        if (cursor && rejected === 0 && ["page_limit", "event_limit"].includes(reason)) resumeCursors[type] = cursor;
      }
      const resumable = partialTypes.length > 0 && Object.keys(resumeCursors).length === partialTypes.length;
      const repairPass = resumable ? Number(existingParams.notificationRepairPass || 0) + 1 : 0;
      const attempts = Number(job.attempts || 0) + (resumable ? 0 : 1);
      const terminal = resumable ? repairPass >= MAX_NOTIFICATION_REPAIR_PASSES : attempts >= MAX_ATTEMPTS;
      const backoffExponent = resumable ? Math.min(6, Math.max(0, repairPass - 1)) : Math.max(0, attempts - 1);
      const retryAt = terminal ? null : new Date(Date.now() + RETRY_BACKOFF_MS * (2 ** backoffExponent));
      const repairParams = {
        ...existingParams,
        ...(partialTypes.length ? { types: partialTypes } : {}),
        ...(Object.keys(resumeCursors).length ? { resumeCursors } : { resumeCursors: null }),
        notificationRepairPass: repairPass,
      };
      const partial = await prisma.jobInstance.updateMany({
        where: completionFence,
        data: terminal ? {
          status: "FAILED",
          attempts,
          completedAt: new Date(),
          claimedAt: null,
          claimedByDeviceId: null,
          leaseUntil: null,
          leaseTokenHash: null,
          continuation: null,
          workId: null,
          result: { ...(result || {}), completionSideEffect: sideEffect || null },
          params: repairParams,
          lastError: "notification_scan_partial",
        } : {
          status: "SCHEDULED",
          attempts,
          nextRunAt: retryAt,
          completedAt: null,
          claimedAt: null,
          claimedByDeviceId: null,
          leaseUntil: null,
          leaseTokenHash: null,
          continuation: null,
          workId: null,
          result: { ...(result || {}), completionSideEffect: sideEffect || null },
          params: repairParams,
          lastError: "notification_scan_partial",
          progress: { percent: 0, message: "notification scan scheduled for repair" },
        },
      });
      if (!partial.count) throw new JobLeaseError("JOB_LEASE_STALE", "Notification partial-completion fence was lost");
      return { job: { id: job.id, status: terminal ? "FAILED" : "SCHEDULED", retryAt }, sideEffect };
    }
    const completed = await prisma.jobInstance.updateMany({ where: completionFence, data: completionData });
    if (!completed.count) throw new JobLeaseError("JOB_LEASE_STALE", "Notification completion fence was lost");
    await maybeAdvanceCreatorAnalyticsInitialSync(job, sideEffect);
    return { job: { id: job.id, status: "DONE" }, sideEffect };
  }

  if (job.jobKey === "vault_unsorted_scan") {
    const completed = await prisma.$transaction(async (tx) => {
      const updated = await tx.jobInstance.updateMany({ where: fenceWhere, data: completionData });
      if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before completion");
      const sideEffect = await applyJobResult({ db: tx, job, deviceId, userId, result: result || {} });
      return { job: { id: job.id, status: "DONE" }, sideEffect };
    }, JOB_COMPLETION_TRANSACTION_OPTIONS);
    // Dialog history is realtime-first. Completing the daily media catalog must
    // not automatically start a creator-wide dialog discovery anymore. A dialog
    // recovery plan is scheduled only by the long-offline coverage detector or
    // by an explicit operator action.
    return completed;
  }

  const sideEffect = await applyJobResult({ job, deviceId, userId, result: result || {} });
  const updated = await prisma.jobInstance.updateMany({ where: fenceWhere, data: completionData });
  if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before completion");
  await maybeAdvanceCreatorAnalyticsInitialSync(job, sideEffect);
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
  try {
    await recordJobFailure({ job, error: errorText, terminal });
  } catch {
    // Failure projection is best-effort after the fenced job transition succeeds.
  }
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
      // A cooperative lease release is not a failed attempt. Keep the reason in
      // bounded progress diagnostics so the UI can say what it is waiting for,
      // but never poison the whole pipeline with a fake RETRYING state.
      lastError: null,
      progress: {
        ...object(job.progress),
        waitKind: waitKind(reason),
        waitReason: clean(reason, 500) || "worker released lease",
        waitingSince: now.toISOString(),
        retryAt: new Date(now.getTime() + delay).toISOString(),
      },
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
module.exports = {
  JobLeaseError,
  claimJob,
  renewLease,
  progressJob,
  completeJob,
  failJob,
  releaseJob,
  sweepExpiredLeases,
  normalizeLeaseContinuation,
  dialogDiscoveryClaimConstraint,
  claimCandidateWhere,
};
