"use strict";

const { isDeepStrictEqual } = require("node:util");
const { observationStartForJob } = require("./analytics-observation-time");

const fairPages = require("./campaign-fair-pages-service");
const VERSION = 1;
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const { CampaignTraversalError } = require("./campaign-traversal-errors");
function fault(code) { return new CampaignTraversalError(code); }
function enabled(job) { return job?.jobKey === "fetch_campaigns" && Number(job.params?.campaignTraversalAuthorityVersion || 0) >= VERSION; }
function envelope(value) {
  let row = value ?? null;
  for (let depth = 0; depth < 10000; depth++) {
    if (object(row).driverPhase === "complete") return { driverPhase: "complete", result: row.result ?? null, progress: row.progress ?? null };
    if (object(row).driverPhase !== "execute") return { driverPhase: "execute", jobContinuation: row };
    const nested = row.jobContinuation ?? null;
    if (!["execute", "complete"].includes(object(nested).driverPhase)) return { driverPhase: "execute", jobContinuation: nested };
    row = nested;
  }
  throw fault("CAMPAIGN_CONTINUATION_TOO_DEEP");
}
function expectedMatches(job, expected) {
  if (expected === undefined) throw fault("CAMPAIGN_EXPECTED_CONTINUATION_REQUIRED");
  return isDeepStrictEqual(envelope(job.continuation), envelope(expected));
}
function integer(value, code = "CAMPAIGN_PAGE_POSITION_INVALID") {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw fault(code);
  return value;
}
const CURSOR_FIELDS = ["collectorVersion", "scanRunId", "scanStartedAt", "phase", "campaignMode", "offset", "page", "campaigns",
  "segmentCursor", "segmentRequestCursor", "segmentHasMore", "campaignIndex", "claimerOffset", "claimerPage", "claimerRejected",
  "directorySourceExhausted", "campaignPagesComplete", "truncated", "totalCampaignCount", "segmentTargetCount",
  "campaignBatchCount", "claimerBatchCount", "campaignScannerRejected", "claimerScannerRejected", "fairPagesVersion"];
function state(job) {
  const driver = envelope(job.continuation);
  if (driver.driverPhase !== "execute") throw fault("CAMPAIGN_TRAVERSAL_ALREADY_COMPLETE");
  const raw = object(driver.jobContinuation), params = object(job.params);
  const initial = { ...(fairPages.enabled(job) ? { fairPagesVersion: 1 } : {}), collectorVersion: "campaigns-v13", scanRunId: params.collectionGeneration,
    scanStartedAt: new Date(params.collectionRequestedAt).toISOString(), phase: "campaigns",
    campaignMode: params.collectionMode === "catchup" ? "catchup" : "full", offset: 0, page: 0, campaigns: [],
    segmentCursor: null, segmentRequestCursor: null, segmentHasMore: false, campaignIndex: 0, claimerOffset: 0, claimerPage: 0, claimerRejected: 0,
    directorySourceExhausted: false, campaignPagesComplete: false, truncated: false, totalCampaignCount: 0,
    campaignBatchCount: 0, claimerBatchCount: 0, campaignScannerRejected: 0, claimerScannerRejected: 0 };
  // Upgrading a leased legacy continuation is safe: existing pages retain the
  // older job observation bound until a genuinely new campaign begins.
  if (!raw.collectorVersion || raw.collectorVersion !== "campaigns-v13") return initial;
  if (raw.fairPagesVersion !== initial.fairPagesVersion) throw fault("CAMPAIGN_FAIR_PROTOCOL_MISMATCH");
  if (raw.collectorVersion !== initial.collectorVersion || raw.scanRunId !== initial.scanRunId
    || raw.scanStartedAt !== initial.scanStartedAt) throw fault("CAMPAIGN_TRAVERSAL_GENERATION_MISMATCH");
  return { ...initial, ...raw, claimerRejected: raw.claimerRejected ?? raw.claimerScannerRejected ?? 0,
    campaigns: Array.isArray(raw.campaigns) ? raw.campaigns.map(row => ({ ...row })) : [] };
}
function skipUnselected(current) {
  while (current.campaignIndex < current.campaigns.length && current.campaigns[current.campaignIndex]?.scanClaimers === false) {
    current.campaignIndex++; current.claimerPage = 0; current.claimerOffset = 0; current.claimerRejected = 0;
  }
  return current;
}
function currentPage(job) {
  const current = skipUnselected(state(job));
  const campaign = current.campaigns[integer(current.campaignIndex)];
  if (current.phase !== "claimers" || !campaign?.id || campaign.scanClaimers !== true) throw fault("CAMPAIGN_PAGE_NOT_SELECTED");
  return { externalCampaignId: String(campaign.id), pageNumber: integer(current.claimerPage) + 1,
    sourceOffset: integer(current.claimerOffset) };
}
function assertPage(job, page) {
  const expected = currentPage(job), input = object(page);
  if (!isDeepStrictEqual(expected, { externalCampaignId: input.externalCampaignId,
    pageNumber: input.pageNumber, sourceOffset: input.sourceOffset })) throw fault("CAMPAIGN_PAGE_POSITION_STALE");
  return expected;
}
function pageCount(payload, rowsKey) {
  const count = integer(payload.sourceRowCount), rejected = integer(payload.scannerRejected);
  if (!Array.isArray(payload[rowsKey]) || count > 50 || count !== payload[rowsKey].length + rejected
    || typeof payload.sourceHasMore !== "boolean") throw fault("CAMPAIGN_PAGE_SOURCE_PROOF_INVALID");
  return count;
}
function canCompletePage(job, payload) {
  return payload.sourceHasMore === false && payload.scannerRejected === 0
    && (!enabled(job) || skipUnselected(state(job)).claimerRejected === 0);
}
function compareState(expected, requested) {
  if (requested.driverPhase !== "execute") throw fault("CAMPAIGN_CONTINUATION_TRANSITION_INVALID");
  const actual = object(requested.jobContinuation);
  for (const key of CURSOR_FIELDS) if (!isDeepStrictEqual(expected[key], actual[key])) {
    throw fault("CAMPAIGN_CONTINUATION_TRANSITION_INVALID:" + key);
  }
}
function compareCompletion(expected, requested) {
  if (requested.driverPhase !== "complete") throw fault("CAMPAIGN_COMPLETION_TRANSITION_INVALID");
  const result = object(requested.result);
  const proof = { schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: expected.scanRunId,
    scanStartedAt: expected.scanStartedAt, campaignMode: expected.campaignMode,
    campaignPagesComplete: expected.directorySourceExhausted && expected.campaignPagesComplete && expected.campaignScannerRejected === 0,
    claimersComplete: expected.directorySourceExhausted && !expected.truncated && expected.claimerScannerRejected === 0,
    truncated: expected.truncated, campaignCount: expected.totalCampaignCount, campaignBatchCount: expected.campaignBatchCount,
    claimerBatchCount: expected.claimerBatchCount, campaignScannerRejected: expected.campaignScannerRejected,
    claimerScannerRejected: expected.claimerScannerRejected };
  for (const [key, value] of Object.entries(proof)) if (!isDeepStrictEqual(value, result[key])) throw fault("CAMPAIGN_COMPLETION_PROOF_INVALID:" + key);
}
function assertProgress(job, chunk, continuation) {
  if (!enabled(job)) return;
  const current = state(job), next = envelope(continuation), payload = object(chunk);
  if (payload.kind === "campaigns_page") {
    const count = pageCount(payload, "campaigns");
    if (current.phase !== "campaigns" || payload.pageNumber !== current.page + 1 || payload.sourceOffset !== current.offset) throw fault("CAMPAIGN_DIRECTORY_POSITION_STALE");
    current.page++; current.offset += count; current.campaignBatchCount++; current.campaignScannerRejected += payload.scannerRejected;
    current.truncated ||= payload.sourceHasMore && count === 0;
    current.directorySourceExhausted = !payload.sourceHasMore || count === 0;
    current.campaignPagesComplete = !payload.sourceHasMore && current.campaignScannerRejected === 0;
    if (current.directorySourceExhausted) {
      if (!current.campaignPagesComplete || current.truncated) return compareCompletion(current, next);
      Object.assign(current, { phase: "segment", campaigns: [], campaignIndex: 0, segmentCursor: null, segmentRequestCursor: null, segmentHasMore: false });
    }
    return compareState(current, next);
  }
  if (payload.kind === "campaign_directory_segment") return compareState(current, next);
  if (payload.kind === "campaign_claimers_page") {
    assertPage(job, payload);
    skipUnselected(current);
    const count = pageCount(payload, "claimers");
    if (payload.campaignComplete !== canCompletePage(job, payload)) throw fault("CAMPAIGN_PAGE_TERMINAL_PROOF_INVALID");
    current.claimerBatchCount++; current.claimerScannerRejected += payload.scannerRejected;
    current.claimerRejected += payload.scannerRejected;
    current.truncated ||= payload.sourceHasMore && count === 0;
    if (fairPages.enabled(job)) { current.campaignIndex++; fairPages.nextRef(current); }
    else if (payload.sourceHasMore && count > 0) { current.claimerOffset += count; current.claimerPage++; }
    else { current.campaignIndex++; current.claimerOffset = 0; current.claimerPage = 0; current.claimerRejected = 0; }
    if (current.campaignIndex >= current.campaigns.length) {
      if (!current.segmentHasMore) return compareCompletion(current, next);
      Object.assign(current, { phase: "segment", campaigns: [], campaignIndex: 0 });
    } else current.phase = "claimers";
    return compareState(current, next);
  }
  if (chunk != null) throw fault("CAMPAIGN_TRAVERSAL_CHUNK_INVALID");
  if (next.driverPhase === "execute" && CURSOR_FIELDS.every(key => isDeepStrictEqual(current[key], object(next.jobContinuation)[key]))) return;
  // Waiting for the read lease or yielding a quantum cannot advance a cursor.
  // Finishing an empty/unselected segment is the only provider-free advance.
  if (current.phase === "claimers") {
    skipUnselected(current);
    if (current.campaignIndex >= current.campaigns.length) {
      Object.assign(current, { campaigns: [], campaignIndex: 0, claimerOffset: 0, claimerPage: 0, claimerRejected: 0 });
      if (!current.segmentHasMore) {
        if (next.driverPhase === "complete") return compareCompletion(current, next);
      } else current.phase = "segment";
    }
  }
  return compareState(current, next);
}

async function beginRead({ db, job, campaignPage, acquiredAt }) {
  if (!enabled(job)) return;
  const page = assertPage(job, campaignPage);
  const campaign = await db.creatorCampaign.findUnique({ where: { creatorId_externalCampaignId: {
    creatorId: job.creatorId, externalCampaignId: page.externalCampaignId } } });
  if (!campaign || campaign.agencyId !== job.agencyId) throw fault("CAMPAIGN_READ_SCOPE_INVALID");
  const generation = job.params.collectionGeneration;
  if (fairPages.enabled(job) && (campaign.claimersCursorRunId !== generation || campaign.claimersCursorPending !== true
      || campaign.claimersCursorPage !== page.pageNumber - 1 || campaign.claimersCursorOffset !== page.sourceOffset)) throw fault("CAMPAIGN_FAIR_PAGE_CURSOR_STALE");
  if (campaign.claimersTraversalRunId === generation && campaign.claimersTraversalStartedAt) return;
  const observedAt = page.pageNumber === 1 ? new Date(acquiredAt) : observationStartForJob(job);
  if (!observedAt || !Number.isFinite(+observedAt)) throw fault("CAMPAIGN_READ_OBSERVATION_MISSING");
  await db.creatorCampaign.update({ where: { id: campaign.id }, data: { claimersTraversalRunId: generation,
    claimersTraversalStartedAt: observedAt, claimersTraversalRevision: Math.max(1, Number(campaign.claimerRevision || 1)),
    claimersTraversalRejectedRows: 0 } });
}
function observation(job, campaign) {
  if (!enabled(job)) return { observedAt: observationStartForJob(job), revision: Math.max(1, Number(campaign.claimerRevision || 1)) };
  const observedAt = campaign.claimersTraversalStartedAt && new Date(campaign.claimersTraversalStartedAt);
  if (campaign.claimersTraversalRunId !== job.params.collectionGeneration || !observedAt || !Number.isFinite(+observedAt)
    || !Number.isInteger(campaign.claimersTraversalRevision) || campaign.claimersTraversalRevision < 1) throw fault("CAMPAIGN_READ_OBSERVATION_MISSING");
  return { observedAt, revision: campaign.claimersTraversalRevision };
}
function assertCompletion(job, result) {
  if (!enabled(job)) return;
  const current = envelope(job.continuation);
  if (current.driverPhase !== "complete" || !isDeepStrictEqual(current.result, result)) throw fault("CAMPAIGN_DURABLE_COMPLETION_REQUIRED");
}

module.exports = { CampaignTraversalError, VERSION, enabled, envelope, expectedMatches, currentPage, assertPage, assertProgress, canCompletePage, beginRead, observation, assertCompletion };
