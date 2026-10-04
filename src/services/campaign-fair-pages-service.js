"use strict";

const { CAMPAIGN_COLLECTION_FRESHNESS_MS } = require("./analytics-freshness-policy");
const enabled = job => Number(job?.params?.campaignFairPagesVersion || 0) === 1;
const { CampaignTraversalError } = require("./campaign-traversal-errors");
const fault = code => new CampaignTraversalError(code);

function initialCursor(runId) {
  return { claimersCursorRunId: runId, claimersCursorPage: 0, claimersCursorOffset: 0, claimersCursorPending: true };
}
function nextRef(state) {
  const ref = state.campaigns[state.campaignIndex];
  state.claimerPage = ref?.page ?? 0;
  state.claimerOffset = ref?.offset ?? 0;
  state.claimerRejected = ref?.rejected ?? 0;
}
function nextSegmentCursor(cursor) {
  if (cursor !== null && !/^[1-9][0-9]{0,14}$/.test(cursor)) throw fault("CAMPAIGN_FAIR_SEGMENT_CURSOR_INVALID");
  const next = Number(cursor || 0) + 1;
  if (!Number.isSafeInteger(next)) throw fault("CAMPAIGN_FAIR_SEGMENT_CURSOR_INVALID");
  return String(next);
}
async function segment(db, job, cursor) {
  const rows = await db.creatorCampaign.findMany({
    where: { creatorId: job.creatorId, claimersCursorRunId: job.params.collectionGeneration, claimersCursorPending: true },
    orderBy: [{ claimersCursorPage: "asc" }, { externalCampaignId: "asc" }], take: 50,
    select: { externalCampaignId: true, claimersCursorPage: true, claimersCursorOffset: true,
      claimersTraversalRunId: true, claimersTraversalRejectedRows: true },
  });
  return { requestCursor: cursor, cursor: nextSegmentCursor(cursor), hasMore: rows.length > 0,
    campaigns: rows.map(row => ({ id: row.externalCampaignId, scanClaimers: true,
      page: row.claimersCursorPage, offset: row.claimersCursorOffset,
      rejected: row.claimersTraversalRunId === job.params.collectionGeneration ? row.claimersTraversalRejectedRows : 0 })) };
}
async function commitPage(db, job, payload, noProgress) {
  if (!enabled(job)) return;
  const updated = await db.creatorCampaign.updateMany({ where: {
    agencyId: job.agencyId, creatorId: job.creatorId, externalCampaignId: payload.externalCampaignId,
    claimersCursorRunId: job.params.collectionGeneration, claimersCursorPending: true,
    claimersCursorPage: payload.pageNumber - 1, claimersCursorOffset: payload.sourceOffset,
  }, data: { claimersCursorPage: payload.pageNumber, claimersCursorOffset: payload.sourceOffset + payload.sourceRowCount,
    claimersCursorPending: payload.sourceHasMore && payload.sourceRowCount > 0 && !noProgress } });
  if (updated.count !== 1) throw fault("CAMPAIGN_FAIR_PAGE_CURSOR_STALE");
}
function eligibleAt(observedDueAt, completedAt) {
  // Scheduling never renews source age. A traversal older than its TTL gets
  // breathing room; other campaigns remain independently eligible.
  return new Date(Math.max(+observedDueAt, +completedAt + CAMPAIGN_COLLECTION_FRESHNESS_MS));
}
async function selectTargets(db, exactGeneration, now, budget) {
  const limit = Math.min(200, budget) + 1;
  // Unknown legacy schedules are admitted once, then use the indexed deadline.
  const unknown = await db.creatorCampaign.findMany({ where: { ...exactGeneration, claimersEligibleAt: null },
    orderBy: { externalCampaignId: "asc" }, take: limit,
    select: { id: true, externalCampaignId: true, claimersNextDueAt: true } });
  const due = unknown.length >= limit ? [] : await db.creatorCampaign.findMany({
    where: { ...exactGeneration, claimersEligibleAt: { lte: now } },
    orderBy: [{ claimersEligibleAt: "asc" }, { externalCampaignId: "asc" }], take: limit - unknown.length,
    select: { id: true, externalCampaignId: true, claimersNextDueAt: true } });
  const rows = [...unknown, ...due], countExact = rows.length < limit;
  return { targets: rows.slice(0, limit - 1), countExact, dueCount: Math.min(limit, rows.length),
    oldestDueAt: rows[0]?.claimersNextDueAt || (rows.length ? now : null) };
}
async function nextEligible(db, exactGeneration, now) {
  const unknown = await db.creatorCampaign.findFirst({ where: { ...exactGeneration, claimersEligibleAt: null }, select: { id: true } });
  if (unknown) return now;
  const first = await db.creatorCampaign.findFirst({ where: exactGeneration,
    orderBy: [{ claimersEligibleAt: "asc" }, { externalCampaignId: "asc" }], select: { claimersEligibleAt: true } });
  return first?.claimersEligibleAt || null;
}
module.exports = { enabled, initialCursor, nextRef, nextSegmentCursor, segment, commitPage, eligibleAt, selectTargets, nextEligible };
