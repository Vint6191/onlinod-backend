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

module.exports = { parseObservationTime: date, stampObservationStart, observationStartForJob, earningsObservationAt,
  earningsObservationSql, directoryObservationAt, directoryDiscoveryDeadline };
