"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const { parseObservationTime, stampObservationStart, observationStartForJob, earningsObservationAt, directoryDiscoveryDeadline } = require("./analytics-observation-time");
const { selectDurableCollectionProof } = require("./analytics-freshness-policy");
const { evaluateDurableCollectorState } = require("./analytics-state-evaluator");
const { stampCollectionAuthorityParams, collectorPlanningProofAt,
  completeFinancialCollection, completeCampaignCollection } = require("./analytics-collector-control-service");
const { completeNotificationSync } = require("./notification-sync-state-service");
const { reconcileCampaignFanValueCoverage } = require("./campaign-fan-refresh-queue-service");
const { contributionFor } = require("./provider-capacity-projection-service");
const { campaignDirectoryDiscoveryCapacityState } = require("./provider-capacity-sla-service");
const now = new Date("2026-10-01T12:00:00Z"), old = new Date("2026-09-28T12:00:00Z");
const hour = 3600000;
const iso = value => value?.toISOString() || null;
function job(type, mode = "full", at = old) {
  return { id: "job", agencyId: "agency", creatorId: "creator", createdAt: at,
    params: stampCollectionAuthorityParams({ collectionContractVersion: 1, collectionType: type,
      collectionGeneration: "generation", collectionRequestedAt: at.toISOString(), collectionMode: mode }, at) };
}
function stateDb(kind, initial = null) {
  let state = initial;
  return require("../../scripts/test-support/commit-database-fixture").commitDatabaseFixture({ [kind]: {
    findUnique: async () => state,
    upsert: async ({ create, update }) => (state = { ...(state || create), ...(state ? update : {}) }),
    update: async ({ data }) => (state = { ...state, ...data }),
  }, creatorNotificationScanItem: { findMany: async () => [] }, read: () => state,
  $executeRawUnsafe: async sql => { assert.match(sql, /onlinod\.financial_receipts_v1|pg_advisory_xact_lock|onlinod\.campaign_projection_writer/); return 1; },
  $queryRawUnsafe: async sql => {
    assert.equal(sql, 'SELECT clock_timestamp() AS "authorityNow"');
    return [{ authorityNow: now }];
  } });
}
function evaluate(state, at = now) {
  return evaluateDurableCollectorState({ status: state.status, baselineVerifiedAt: state.baselineVerifiedAt,
    lastVerifiedAt: state.lastCatchupCompletedAt, baselineObservedAt: state.baselineObservedAt,
    lastObservedAt: state.lastCatchupObservedAt, now: at, freshnessMs: hour });
}

test("physical observation does not follow logical ordering or client payload time", () => {
  const params = stampCollectionAuthorityParams({ collectionType: "CAMPAIGNS" }, old, now);
  assert.equal(params.collectionAuthorityRequestedAt, new Date(+now + 1).toISOString());
  assert.equal(params.analyticsObservationStartedAt, old.toISOString());
  assert.equal(iso(observationStartForJob({ params, result: { observedAt: now } })), old.toISOString());
  assert.equal(iso(observationStartForJob({ createdAt: old, params: { collectionRequestedAt: now } })), old.toISOString());
  assert.equal(observationStartForJob({ createdAt: old, params: { analyticsObservationStartedAt: "invalid" } }), null);
});

test("replay/restart keeps the command bound; only a new command gets a new bound", () => {
  const first = { params: stampObservationStart({}, old) };
  assert.equal(iso(observationStartForJob(JSON.parse(JSON.stringify(first)))), old.toISOString());
  assert.equal(iso(observationStartForJob({ params: stampObservationStart({}, now) })), now.toISOString());
});

test("provider SQL-style range boundaries are UTC independently of process timezone", () => {
  assert.equal(iso(parseObservationTime("2026-09-28 12:00:00")), old.toISOString());
});

test("legacy earnings proof bounds freshness after operational retention", () => {
  assert.equal(iso(earningsObservationAt({ lastVerifiedAt: now, scanProof: { requestedAt: old } })), old.toISOString());
  assert.equal(iso(earningsObservationAt({ lastVerifiedAt: old, scanProof: { requestedAt: now, observationStartedAt: old } })), old.toISOString());
  assert.equal(earningsObservationAt({ lastVerifiedAt: now }), null);
});

test("completed legacy baseline remains usable and schedules catch-up without fresh source evidence", () => {
  const state = evaluate({ status: "COMPLETE", baselineVerifiedAt: now });
  assert.equal(state.proven, true); assert.equal(state.usable, true);
  assert.equal(state.fresh, false); assert.equal(state.stale, true); assert.equal(state.due, true);
  assert.equal(collectorPlanningProofAt("FINANCIAL", "catchup", { baselineVerifiedAt: now }, now), null);
  assert.equal(iso(collectorPlanningProofAt("FINANCIAL", "full", { baselineVerifiedAt: now }, now)), now.toISOString());
});

test("new verified catch-up refreshes a legacy baseline without re-reading full history", () => {
  const state = { receiptCoverageVersion: 1, status: "COMPLETE", baselineVerifiedAt: old, lastCatchupCompletedAt: now, lastCatchupObservedAt: now };
  assert.equal(evaluate(state).fresh, true);
  assert.equal(iso(collectorPlanningProofAt("FINANCIAL", "catchup", state, now)), now.toISOString());
  assert.equal(evaluate({ ...state, baselineVerifiedAt: null }).proven, false);
});

test("publication and future observation cannot fabricate a fresh proof", () => {
  const state = { status: "COMPLETE", baselineVerifiedAt: now, baselineObservedAt: old };
  assert.equal(evaluate(state).fresh, false); assert.equal(evaluate(state).due, true);
  assert.equal(evaluate({ ...state, baselineObservedAt: new Date(+now + hour) }).fresh, false);
  const proof = selectDurableCollectionProof({ baselineVerifiedAt: now, baselineObservedAt: old,
    catchupVerifiedAt: old, catchupObservedAt: now, now });
  assert.equal(iso(proof.latestAt), old.toISOString(), "observation cannot postdate its completion receipt");
});

for (const mode of ["full", "catchup"]) test(`financial ${mode} completion and replay preserve source age`, async () => {
  const db = stateDb("creatorFinancialCollectionState", { baselineVerifiedAt: old, baselineObservedAt: old });
  const input = { db, job: job("FINANCIAL", mode), complete: true, scanRunId: "generation", receiptRun: { proof: { complete: true }, windows: [{ kind: mode === "full" ? "FULL" : "HEAD", from: new Date(+old - hour).toISOString(), to: old.toISOString() }] }, rangeTo: old };
  await completeFinancialCollection(input);
  const timestamp = db.read()[mode === "full" ? "baselineObservedAt" : "lastCatchupObservedAt"];
  assert.equal(iso(timestamp), old.toISOString());
  assert.equal(evaluate(db.read()).proven, true);
  assert.equal(evaluate(db.read()).fresh, false);
  await completeFinancialCollection(input);
  assert.equal(iso(db.read()[mode === "full" ? "baselineObservedAt" : "lastCatchupObservedAt"]), old.toISOString());
});

for (const mode of ["full", "catchup"]) test(`campaign ${mode} FanData queue settlement cannot renew membership age`, async () => {
  const db = stateDb("creatorCampaignCollectionState", { baselineVerifiedAt: old, baselineObservedAt: old,
    fanValueCoverageScanRunId: "generation", campaignFrontierFreshnessStatus: "COMPLETE", fanValueOutstanding: 0, fanValueFailed: 0 });
  await completeCampaignCollection({ db, job: job("CAMPAIGNS", mode), complete: false, membershipComplete: true, scanRunId: "generation" });
  assert.equal(iso(db.read().membershipObservedAt), old.toISOString());
  await reconcileCampaignFanValueCoverage({ db, creatorId: "creator", scanRunId: "generation", now });
  assert.equal(db.read().status, "COMPLETE");
  assert.equal(evaluate(db.read()).proven, true);
  assert.equal(evaluate(db.read()).fresh, false);
  assert.equal(evaluate(db.read()).due, true);
  await reconcileCampaignFanValueCoverage({ db, creatorId: "creator", scanRunId: "generation", now: new Date(+now + hour) });
  assert.equal(iso(db.read()[mode === "full" ? "baselineObservedAt" : "lastCatchupObservedAt"]), old.toISOString());
});

test("notification proof keeps traversal age independent of delayed completion", async () => {
  const db = stateDb("creatorNotificationSyncState");
  await completeNotificationSync({ db, job: job("NOTIFICATIONS"), successful: true,
    result: { notificationMode: "full", scanRunId: "generation", sourceExhausted: true, allSourceExhausted: true } });
  assert.equal(iso(db.read().fullBackfillObservedAt), old.toISOString());
  assert.equal(iso(collectorPlanningProofAt("NOTIFICATIONS", "catchup", db.read(), now)), old.toISOString());
});

test("old directory publication time cannot postpone discovery or capacity debt", () => {
  const targetMs = 72 * hour;
  const row = { id: "s", baselineVerifiedAt: old, campaignDirectoryVerifiedAt: now,
    campaignDirectoryRequestedAt: old, campaignDirectoryDiscoveryDueAt: new Date(+now + targetMs), campaignDirectoryCampaignCount: 4000 };
  assert.equal(iso(directoryDiscoveryDeadline(row, targetMs)), now.toISOString());
  assert.equal(campaignDirectoryDiscoveryCapacityState(row, now).status, "DUE");
  assert.equal(contributionFor("directory", row, now).itemCount, 1n);
});

test("future directory evidence remains due in both scheduling and the debt projection", () => {
  const future = new Date(+now + 24 * hour);
  const row = { id: "s", baselineVerifiedAt: old, campaignDirectoryVerifiedAt: future,
    campaignDirectoryRequestedAt: future, campaignDirectoryDiscoveryDueAt: new Date(+future + 72 * hour) };
  assert.equal(directoryDiscoveryDeadline(row, 72 * hour, now), null);
  assert.equal(campaignDirectoryDiscoveryCapacityState(row, now).status, "DUE");
  assert.equal(contributionFor("directory", row, now).itemCount, 1n);
});
