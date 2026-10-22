"use strict";

const { trustedCollectionTimestamp } = require("./analytics-freshness-policy");

// An observation starts no earlier than its server-issued command. Keep this
// physical lower bound separate from logical generation ordering and from the
// time a durable result happens to be published. Client payload clocks never
// participate in this authority.
function date(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? value.replace(" ", "T") + "Z" : value;
  const result = new Date(normalized);
  return Number.isFinite(result.getTime()) ? result : null;
}

function stampObservationStart(params, authorityNow) {
  const at = date(authorityNow);
  if (!at) throw new Error("ANALYTICS_OBSERVATION_CLOCK_INVALID");
  return { ...params, analyticsObservationStartedAt: at.toISOString() };
}

function stampUnstartedCollectionObservation(job, authorityNow) {
  // A queue can outlive a laptop's offline period. Bind the first observation
  // window at claim, preserving the command's logical generation/order. A
  // takeover must retain its original window and every committed page receipt.
  if (job?.startedAt != null || job?.continuation != null) return null;
  const params = job?.params || {};
  const type = params.collectionType;
  if (params.collectionContractVersion !== 1
      || !((job.jobKey === 'catchup_notifications_scan' && type === 'NOTIFICATIONS')
        || (job.jobKey === 'financial_transactions_scan' && type === 'FINANCIAL'))) return null;
  if (type === 'FINANCIAL' && params.financialWindowGeneration) return null;
  const stamped = stampObservationStart(params, authorityNow), at = date(authorityNow);
  if (type === 'NOTIFICATIONS') {
    const target = date(params.recoveryTargetAt || params.to);
    stamped.to = new Date(target ? Math.min(+target, +at) : +at).toISOString();
  }
  // Resolution is a specific historical event window, not a rolling catch-up.
  // Advancing its end to claim time widens a valid hour into days and makes the
  // highest-priority scheduled job poison every subsequent worker claim. Keep
  // the command's immutable source interval; only the physical read starts now.
  else if (params.moneyResolutionVersion === 1) return stamped;
  else {
    // The recovery episode/initial pass already owns its fixed upper bound.
    // Claim changes the physical observation start, never the intended period.
    let through = date(params.endDate) || at;
    const target = params.collectionMode === 'catchup' ? date(params.recoveryTargetAt) : null;
    const representedTarget = target ? new Date(Math.ceil(+target / 1000) * 1000) : null;
    // Only unstarted commands without receipt bindings may acquire the provider
    // precision fix. Existing receipt windows and their proof stay immutable.
    if (representedTarget && representedTarget <= at) through = representedTarget;
    stamped.initialMarker = Math.floor(+through / 1000);
    stamped.endDate = new Date(stamped.initialMarker * 1000).toISOString().slice(0, 19).replace('T', ' ');
  }
  return stamped;
}

function observationStartForJob(job) {
  const params = job?.params || {};
  // A malformed explicit boundary is unknown, not permission to use a newer
  // receipt/publication clock. Older queued commands predate the new stamp:
  // their immutable creation time is a conservative lower bound for the read.
  if (Object.hasOwn(params, "analyticsObservationStartedAt")) return date(params.analyticsObservationStartedAt);
  return date(job?.createdAt)
    || date(params.authorityRequestedAt ?? params.collectionAuthorityRequestedAt
      ?? params.requestedAt ?? params.collectionRequestedAt);
}

function earlier(left, right) {
  const a = date(left), b = date(right);
  return a && b ? new Date(Math.min(+a, +b)) : null;
}

// Legacy earnings proofs retained their immutable request boundary even after
// Job/ingest retention. Existing amounts remain usable; a publication timestamp
// cannot renew their freshness. Nullable migrated fields use that old bound.
function earningsObservationAt(coverage) {
  const proof = coverage?.scanProof;
  if (!proof) return null;
  const start = proof.observationStartedAt ?? proof.requestedAt;
  return earlier(coverage.lastVerifiedAt, start);
}

function earningsObservationSql() {
  return '(CASE WHEN v."lastVerifiedAt" IS NOT NULL AND COALESCE(p."observationStartedAt",p."requestedAt") IS NOT NULL'
    + ' THEN LEAST(v."lastVerifiedAt",COALESCE(p."observationStartedAt",p."requestedAt")) ELSE NULL END)';
}

// Directory discovery has its own (72h by default) age policy; reusing a
// directory for a bounded claimer catch-up must not renew directory evidence.
function directoryObservationAt(state, now = null) {
  const at = earlier(state?.campaignDirectoryVerifiedAt, state?.campaignDirectoryRequestedAt);
  return now ? trustedCollectionTimestamp(at, now) : at;
}

function directoryDiscoveryDeadline(state, targetMs, now = null) {
  const observedAt = directoryObservationAt(state, now);
  if (!observedAt) return null;
  const sourceDeadline = new Date(+observedAt + targetMs);
  const scheduled = date(state?.campaignDirectoryDiscoveryDueAt);
  return scheduled ? new Date(Math.min(+scheduled, +sourceDeadline)) : sourceDeadline;
}

module.exports = { parseObservationTime: date, stampObservationStart, stampUnstartedCollectionObservation, observationStartForJob, earningsObservationAt,
  earningsObservationSql, directoryObservationAt, directoryDiscoveryDeadline };
