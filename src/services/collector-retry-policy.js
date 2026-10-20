"use strict";

// Only these reviewed provider READ collectors have a fresh-generation recovery
// path. This policy never replays an external write, resumes a corrupt cursor,
// or treats a client's generic retryable=true as evidence of a transient error.
const JOB_TYPES = Object.freeze({ catchup_notifications_scan: "NOTIFICATIONS", financial_transactions_scan: "FINANCIAL", fetch_campaigns: "CAMPAIGNS", subscriber_directory_scan: "SUBSCRIBERS" });
const MODELS = Object.freeze({ NOTIFICATIONS: "creatorNotificationSyncState", FINANCIAL: "creatorFinancialCollectionState", CAMPAIGNS: "creatorCampaignCollectionState" });
const MAX_RETRY_MS = 15 * 60_000;
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const date = value => { const at = value ? new Date(value) : null; return at && Number.isFinite(+at) ? at : null; };
const errorText = error => String(error?.message || error || "").trim();

function classifyCollectorReadFailure({ job, error, failure = null }) {
  if (!JOB_TYPES[job?.jobKey] || job?.params?.moneyResolutionVersion === 1) return null;
  const text = errorText(error);
  if (text === "lease expired") return { code: "LEASE_EXPIRED", waitingForSession: false };
  const details = object(failure);
  // failure is the structured GET response retained in this exact failed job.
  // Identity/schema/proof failures cannot acquire this classification merely
  // by containing words such as 'timeout' or 'network'.
  if (details.method !== "GET" || details.message !== text) return null;
  const status = details.status, code = String(details.code || "");
  if (!Number.isInteger(status)) return null;
  if (code === "OF_REQUEST_FAILED" && status === 401) return { code: "PROVIDER_AUTH_REQUIRED", waitingForSession: true };
  if (details.retryable !== true) return null;
  if (["SESSION_FETCH_TIMEOUT", "SESSION_FETCH_FAILED"].includes(code) && status === 0) return { code, waitingForSession: false };
  if (code === "OF_REQUEST_FAILED" && ([408, 425, 429].includes(status) || status >= 500 && status <= 599))
    return { code: `PROVIDER_HTTP_${status}`, waitingForSession: false };
  return null;
}

function retryDelay(job) {
  return Math.min(MAX_RETRY_MS, 30_000 * 2 ** Math.min(5, Math.max(0, Number(job?.attempts) || 0)));
}

function sameSourceJob(job, expected) {
  return job && job.id === expected.id && job.agencyId === expected.agencyId && job.creatorId === expected.creatorId && job.jobKey === expected.jobKey;
}

// Called inside the existing failure transaction, after JobInstance has stored
// its result. Do not consult a prior attempt's failure payload on a stale copy.
async function collectionFailureRetry({ db, job, error, terminal, now }) {
  if (!JOB_TYPES[job?.jobKey]) return null;
  let current = null;
  if (db?.jobInstance?.findUnique) current = await db.jobInstance.findUnique({ where: { id: job.id } });
  const text = errorText(error);
  const actual = sameSourceJob(current, job) && ["FAILED", "SCHEDULED"].includes(current.status) && current.lastError === text ? current : null;
  const classified = classifyCollectorReadFailure({ job, error, failure: actual?.result?.failure });
  if (!classified) return null;
  return { ...classified, retryAt: terminal && !classified.waitingForSession ? new Date(+now + retryDelay(actual || job)) : null };
}

async function signalCollectorRetry({ db, job, interruption, now }) {
  if (!interruption) return;
  // A failure can commit after the planner has yielded for an hour. Record the
  // next wake in the same transaction, without taking its DWI lock underneath
  // a collector lock. The shared outbox consumer only wakes creator planning.
  await require("./subscriber-directory-maintenance-signal-service").signalSubscriberDirectoryMaintenance({
    db, agencyId: job.agencyId, creatorId: job.creatorId, kind: "DERIVED_PLANNING",
    dueAt: interruption.retryAt || new Date(+now + 60_000), reason: "COLLECTOR_RETRY",
  });
}

// Runtime adoption of old terminal interruptions is bounded to the exact
// creator+collector state/source job. It joins the same lock used by START,
// planning, accept and completion. It does not scan terminal job history.
async function recoverTerminalCollector({ db, type, state, agencyId, creatorId, now }) {
  if (state?.status !== "FAILED" || state.retryAfterAt || !state.sourceJobId || !state.activeGeneration)
    return { state, waitingForSession: false };
  const model = MODELS[type];
  if (!model || !db?.[model]?.updateMany || !db?.jobInstance?.findUnique) return { state, waitingForSession: false };
  const { withCollectorStateLock, collectionCommand } = require("./analytics-collector-control-service");
  return withCollectorStateLock({ db, type, creatorId, work: async tx => {
    const current = await tx[model].findUnique({ where: { creatorId } });
    if (!current || current.agencyId !== agencyId || current.creatorId !== creatorId || current.status !== "FAILED"
      || current.retryAfterAt || current.sourceJobId !== state.sourceJobId || current.activeGeneration !== state.activeGeneration)
      return { state: current || state, waitingForSession: false };
    const job = await tx.jobInstance.findUnique({ where: { id: current.sourceJobId } });
    if (!job || job.agencyId !== agencyId || job.creatorId !== creatorId || JOB_TYPES[job.jobKey] !== type || job.status !== "FAILED")
      return { state: current, waitingForSession: false };
    let command;
    try { command = collectionCommand(job, type); } catch { return { state: current, waitingForSession: false }; }
    if (command.generation !== current.activeGeneration || +command.requestedAt !== +date(current.activeRequestedAt))
      return { state: current, waitingForSession: false };
    // An existing queued/paused/publishing traversal remains its owner's work.
    // In particular a manual PAUSE must not be bypassed by automatic repair.
    const active = await tx.jobInstance.findFirst({ where: { agencyId, creatorId, jobKey: job.jobKey,
      status: { in: ["SCHEDULED", "CLAIMED", "PUBLISHING", "PAUSED"] } }, select: { id: true } });
    if (active) return { state: current, waitingForSession: false, active: true };
    const classified = classifyCollectorReadFailure({ job, error: job.lastError, failure: job.result?.failure });
    if (!classified) return { state: current, waitingForSession: false };
    if (classified.waitingForSession) {
      const failedAt = date(job.completedAt) || date(job.updatedAt);
      const fresh = { gte: new Date(+now - 2 * 60_000), lte: new Date(+now + 30_000) };
      const binding = failedAt && await tx.deviceCreatorBinding?.findFirst?.({ where: { agencyId, creatorId, status: "ACTIVE",
        sessionReadReady: true, lastSeenAt: fresh, lastCapabilityAt: { gt: failedAt, lte: new Date(+now + 30_000) },
        device: { agencyId, lastSeenAt: fresh } }, select: { id: true } });
      if (!binding) return { state: current, waitingForSession: true };
    }
    const failedAt = date(job.completedAt) || date(job.updatedAt) || now;
    const retryAt = new Date(Math.min(+failedAt, +now) + retryDelay(job));
    const changed = await tx[model].updateMany({ where: { creatorId, agencyId, status: "FAILED", retryAfterAt: null,
      sourceJobId: job.id, activeGeneration: command.generation, activeRequestedAt: current.activeRequestedAt },
      data: { retryAfterAt: retryAt } });
    return { state: changed.count ? { ...current, retryAfterAt: retryAt } : await tx[model].findUnique({ where: { creatorId } }),
      waitingForSession: false, recovered: changed.count === 1, code: classified.code };
  } });
}

module.exports = { JOB_TYPES, MAX_RETRY_MS, retryDelay, classifyCollectorReadFailure, collectionFailureRetry, signalCollectorRetry, recoverTerminalCollector };
