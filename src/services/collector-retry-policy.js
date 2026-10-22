"use strict";

// Provider read failures may retry inside their existing bounded job episode.
// Exhaustion is durable; heartbeat, a new worker or a fresh session cannot
// replenish its budget by creating another collection generation.
const JOB_TYPES = Object.freeze({ catchup_notifications_scan: "NOTIFICATIONS", financial_transactions_scan: "FINANCIAL", fetch_campaigns: "CAMPAIGNS", subscriber_directory_scan: "SUBSCRIBERS" });
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
async function collectionFailureRetry({ db, job, error, terminal }) {
  if (!JOB_TYPES[job?.jobKey]) return null;
  let current = null;
  if (db?.jobInstance?.findUnique) current = await db.jobInstance.findUnique({ where: { id: job.id } });
  const text = errorText(error);
  const actual = sameSourceJob(current, job) && ["FAILED", "SCHEDULED"].includes(current.status) && current.lastError === text ? current : null;
  const classified = classifyCollectorReadFailure({ job, error, failure: actual?.result?.failure });
  if (!classified) return null;
  return { ...classified, terminal: terminal === true, retryAt: terminal ? null : date(actual?.nextRunAt) };
}

async function signalCollectorRetry({ db, job, interruption, now }) {
  if (!interruption || interruption.terminal) return;
  // A failure can commit after the planner has yielded for an hour. Record the
  // next wake in the same transaction, without taking its DWI lock underneath
  // a collector lock. The shared outbox consumer only wakes creator planning.
  await require("./subscriber-directory-maintenance-signal-service").signalSubscriberDirectoryMaintenance({
    db, agencyId: job.agencyId, creatorId: job.creatorId, kind: "DERIVED_PLANNING",
    dueAt: interruption.retryAt || new Date(+now + 60_000), reason: "COLLECTOR_RETRY",
  });
}

// A terminal source is an observable stopped episode. Automatic planning reads
// that result but must never turn FAILED into a fresh-generation retry. Explicit
// retry/new collection causes are admitted by their owning command authority.
async function recoverTerminalCollector({ db, type, state, agencyId, creatorId }) {
  const result = { state, waitingForSession: false, recovered: false };
  if (String(state?.status || "").toUpperCase() !== "FAILED") return result;
  // Older releases left retryAfterAt on exhausted collectors. Its deadline is
  // a scheduling hint, never authority to create another generation. Only an
  // exact still-active source job can retain the existing episode's budget.
  if (state.retryAfterAt && state.sourceJobId && db?.jobInstance?.findUnique) {
    const source = await db.jobInstance.findUnique({ where: { id: state.sourceJobId },
      select: { id: true, agencyId: true, creatorId: true, jobKey: true, status: true, params: true } });
    if (source?.id === state.sourceJobId && source.agencyId === agencyId && source.creatorId === creatorId
      && JOB_TYPES[source.jobKey] === type && typeof state.activeGeneration === "string" && state.activeGeneration
      && source.params?.collectionGeneration === state.activeGeneration
      && ["SCHEDULED", "CLAIMED", "PUBLISHING", "PAUSED"].includes(source.status)) return { ...result, active: true };
  }
  return { ...result, terminal: true };
}

module.exports = { JOB_TYPES, MAX_RETRY_MS, retryDelay, classifyCollectorReadFailure, collectionFailureRetry, signalCollectorRetry, recoverTerminalCollector };
