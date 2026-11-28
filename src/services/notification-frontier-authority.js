"use strict";
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const FULL_PHASES = Object.freeze(["subscriptions", "purchases", "tips", "comments", "likes", "all_reconciliation"]);
const fullEnabled = (job) => job.params?.notificationMode === "full" && job.params?.notificationFrontierVersion === 4;
const enabled = (job) => fullEnabled(job) || job.params?.notificationMode === "catchup" && [2, 3].includes(job.params?.notificationFrontierVersion);
class NotificationFrontierError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status = 409;
    this.retryable = false;
  }
}
const fail = (code) => {
  throw new NotificationFrontierError(code);
};
// Only persistence can decide whether a page changed the source. IDs alone do
// not reveal corrected facts, and a row inserted by this walk is never baseline
// evidence. A fixed episode bound survives machine handoff and delayed starts.
function assessPage(job, rows, previousByIdentity, outcomes = new Map()) {
  const knownBefore = new Date(job.params?.recoveryTargetAt || job.params?.notificationKnownBeforeAt || job.params?.collectionRequestedAt);
  const gapFrom = job.params?.recoveryGapFrom ? new Date(job.params.recoveryGapFrom) : null;
  const unchanged = rows.length > 0 && Number.isFinite(+knownBefore) && rows.every(row => {
    const prior = previousByIdentity.get(row.identityKey);
    const outcome = outcomes.get(row.identityKey);
    return prior && Number.isFinite(+new Date(prior.firstObservedAt)) && +new Date(prior.firstObservedAt) < +knownBefore
      && prior.sourceChecksum === row.sourceChecksum
      && prior.persistenceStatus !== "REJECTED" && row.disposition !== "REJECTED"
      && (!outcome || outcome.status === prior.persistenceStatus && (outcome.canonicalFactId || null) === (prior.canonicalFactId || null));
  });
  const pastGap = !gapFrom || Number.isFinite(+gapFrom) && rows.length > 0
    && rows.every(row => row.occurredAt && +new Date(row.occurredAt) <= +gapFrom);
  return { unchanged, pastGap };
}
async function commitPage(db, job, chunk, previous, assessment = null) {
  if (!enabled(job)) return previous || {};
  const generation = job.params.collectionGeneration;
  const full = fullEnabled(job);
  const p =
    previous?.generation === generation
      ? previous
      : { generation, page: 0, cursor: null, phase: "SEEK", boundaryPage: null, unchangedPages: 0 };
  const digest = hashCanonicalJson(chunk);
  const [receipt] = await db.$queryRawUnsafe(
    'SELECT digest FROM "CreatorNotificationFrontierPage" WHERE "creatorId"=$1 AND generation=$2 AND page=$3',
    job.creatorId,
    generation,
    chunk.page
  );
  if (receipt) {
    if (receipt.digest !== digest) fail("NOTIFICATION_FRONTIER_PAYLOAD_CONFLICT");
    return p;
  }
  if (
    p.phase === "DONE" ||
    chunk.page !== p.page + 1 ||
    (chunk.cursorStart || null) !== p.cursor ||
    (!full && chunk.sourcePhase !== "all")
  )
    fail("NOTIFICATION_FRONTIER_CURSOR_MISMATCH");
  if (full) {
    const phase = p.page === 0 ? FULL_PHASES[0]
      : p.phaseExhausted ? FULL_PHASES[FULL_PHASES.indexOf(p.sourcePhase) + 1] : p.sourcePhase;
    if (!phase || chunk.sourcePhase !== phase) fail("NOTIFICATION_FRONTIER_PHASE_MISMATCH");
  }
  if (typeof chunk.sourceHasMore !== "boolean" || !Array.isArray(chunk.observations))
    fail("NOTIFICATION_FRONTIER_PAGE_INVALID");
  const ids = chunk.observations.map((row) => row.notificationId).filter(Boolean);
  // A truncated wire prefix is not a whole provider page. It can persist data
  // and advance the cursor, but cannot count toward the three-page proof.
  const boundary = assessment?.unchanged === true && assessment?.pastGap === true
    && chunk.providerPageComplete === true && ids.length > 0 && ids.length === chunk.observations.length;
  const cursor = chunk.cursorEnd || null;
  if (chunk.sourceHasMore && (!ids.length || !cursor || cursor === p.cursor || ids.at(-1) !== cursor))
    fail("NOTIFICATION_FRONTIER_CURSOR_STALLED");
  if (chunk.sourceHasMore) {
    const [cycle] = await db.$queryRawUnsafe(
      'SELECT page FROM "CreatorNotificationFrontierPage" WHERE "creatorId"=$1 AND generation=$2 AND "cursorStart"=$3',
      job.creatorId,
      generation,
      full ? `${chunk.sourcePhase}:${cursor}` : cursor
    );
    if (cycle) fail("NOTIFICATION_FRONTIER_CURSOR_CYCLE");
  }
  const unchangedPages = boundary ? Number(p.unchangedPages || 0) + 1 : 0;
  const done = full ? chunk.sourcePhase === "all_reconciliation" && !chunk.sourceHasMore
    : !chunk.sourceHasMore || unchangedPages >= 3;
  const next = {
    generation,
    frontierVersion: full ? 4 : 3,
    page: chunk.page,
    cursor: done || !chunk.sourceHasMore ? null : cursor,
    phase: done ? "DONE" : boundary ? "OVERLAP" : "SEEK",
    unchangedPages,
    boundaryPage: boundary ? (p.unchangedPages ? p.boundaryPage : chunk.page) : null,
    overlapPage: done && unchangedPages >= 3 ? chunk.page : null,
    exhausted: full ? done : !chunk.sourceHasMore,
    ...(full ? { sourcePhase: chunk.sourcePhase, phaseExhausted: !chunk.sourceHasMore } : {}),
  };
  if (chunk.sourceExhausted && !done || (!full || done) && !chunk.sourceHasMore && chunk.stopReason !== "source_exhausted"
    || full && (chunk.phaseSourceExhausted !== !chunk.sourceHasMore || chunk.allSourceExhausted === true && !done))
    fail("NOTIFICATION_FRONTIER_COMPLETION_INVALID");
  await db.$executeRawUnsafe(
    'INSERT INTO "CreatorNotificationFrontierPage"("creatorId","agencyId",generation,page,"cursorStart","cursorEnd",digest) VALUES($1,$2,$3,$4,$5,$6,$7)',
    job.creatorId,
    job.agencyId,
    generation,
    chunk.page,
    full ? `${chunk.sourcePhase}:${p.cursor || ""}` : p.cursor || "",
    cursor,
    digest
  );
  return next;
}
function completed(job, receipt) {
  return (
    !enabled(job) ||
    (receipt?.generation === job.params.collectionGeneration &&
      receipt.phase === "DONE" &&
      (receipt.exhausted === true || receipt.frontierVersion === 3 && receipt.unchangedPages >= 3
        && receipt.overlapPage === receipt.boundaryPage + 2))
  );
}

function sourceTraversalComplete(job, result, receipt) {
  const full = job.params?.notificationMode !== "catchup";
  return result?.sourceExhausted === true && (!full || result?.allSourceExhausted === true)
    && completed(job, receipt);
}

function assertCompletionResult(job, result) {
  if (job.params?.notificationNormalizerVersion !== "notification-source-v3") return;
  // A terminal descriptor summarizes source receipts; it is never another
  // ingress for facts. Validate before accepting immutable completion and on
  // direct /complete, which can legitimately omit the preceding checkpoint.
  if (!Array.isArray(result?.events) || result.events.length !== 0)
    fail("NOTIFICATION_COMPLETION_EVENTS_FORBIDDEN");
  const params = job.params;
  if (result.scanRunId !== params.collectionGeneration)
    fail("ANALYTICS_COLLECTION_GENERATION_MISMATCH");
  if (result.notificationMode !== params.notificationMode)
    fail("ANALYTICS_COLLECTION_MODE_MISMATCH");
  if (result.schemaVersion !== 6 || result.normalizerVersion !== "notification-source-v3"
    || result.collectorVersion !== "notifications-history-v9-source-ledger" || result.finalizeCoverage !== true
    || result.batchKey !== `run:${params.collectionGeneration}:completion`
    || result.notificationType != null || result.sourceTimezone !== "UTC")
    fail("NOTIFICATION_COMPLETION_METADATA_INVALID");
  const { parseStrictIsoDateTime } = require("./strict-date-time");
  const from = parseStrictIsoDateTime(params.from), to = parseStrictIsoDateTime(params.to);
  const resultFrom = parseStrictIsoDateTime(result.from), resultTo = parseStrictIsoDateTime(result.to);
  if (!from || !to || to < from || !resultFrom || !resultTo || +from !== +resultFrom || +to !== +resultTo)
    fail("NOTIFICATION_COMPLETION_METADATA_INVALID");
  for (const field of ["totalAcceptedEvents", "totalObservedRows", "totalPages"])
    if (!Number.isSafeInteger(result[field]) || result[field] < 0) fail("NOTIFICATION_COMPLETION_METADATA_INVALID");
  for (const row of Object.values(result.coverage || {})) {
    for (const cursor of [row?.cursorStart, row?.cursorEnd])
      if (cursor != null && String(cursor).trim().length > 220) fail("NOTIFICATION_COMPLETION_METADATA_INVALID");
  }
  // Keep the same complete/partial rules as final ingestion. A SQL-proven walk
  // with rejected rows must still terminate with its truthful partial result.
  require("./notification-facts-service").validateFinalScannerCoverage(result, job, from, to);
}

async function completionProof(db, job, result) {
  const state = enabled(job)
    ? await db.creatorNotificationSyncState.findUnique({ where: { creatorId: job.creatorId },
      select: { frontierReceipt: true } })
    : null;
  const verified = sourceTraversalComplete(job, result, state?.frontierReceipt);
  return { verified, reason: verified ? "verified" : "source_boundary_unproven" };
}

async function assertCompletionContinuation(db, job, result) {
  assertCompletionResult(job, result);
  const proof = await completionProof(db, job, result);
  if (!proof.verified) fail("NOTIFICATION_FRONTIER_COMPLETION_INVALID");
}

function attachContinuation(job, requestedContinuation, sideEffect) {
  if (!enabled(job) || !sideEffect?.notificationFrontier) return null;
  if (sideEffect.replayed) return job.continuation;
  const receipt = sideEffect.notificationFrontier;
  const envelope = requestedContinuation || {};
  if (envelope.driverPhase === "complete") {
    assertCompletionResult(job, envelope.result);
    if (!sourceTraversalComplete(job, envelope.result, receipt)) fail("NOTIFICATION_FRONTIER_COMPLETION_INVALID");
    return envelope;
  }
  const domain = envelope.driverPhase === "execute" ? envelope.jobContinuation : envelope;
  if (!domain || domain.scanRunId !== receipt.generation || domain.page !== receipt.page)
    fail("NOTIFICATION_FRONTIER_CONTINUATION_INVALID");
  if (fullEnabled(job)) {
    const next = { ...domain, fromId: receipt.cursor || undefined,
      sourceExhausted: receipt.phase === "DONE", allSourceExhausted: receipt.phase === "DONE",
      stopReason: receipt.phase === "DONE" ? "source_exhausted" : undefined };
    return envelope.driverPhase === "execute" ? { ...envelope, jobContinuation: next } : next;
  }
  const next = { ...domain, fromId: receipt.cursor || undefined, sourceExhausted: receipt.phase === "DONE",
    unchangedPages: receipt.unchangedPages, boundaryPage: receipt.boundaryPage || undefined,
    overlapPending: receipt.phase === "OVERLAP",
    stopReason: receipt.phase === "DONE" ? (receipt.exhausted ? "source_exhausted" : "known_boundary_reached") : undefined };
  return envelope.driverPhase === "execute" ? { ...envelope, jobContinuation: next } : next;
}
module.exports = { NotificationFrontierError, FULL_PHASES, enabled, fullEnabled, assessPage, commitPage, completed,
  sourceTraversalComplete, completionProof, assertCompletionResult, assertCompletionContinuation, attachContinuation };
