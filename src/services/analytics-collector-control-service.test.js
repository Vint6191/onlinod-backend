"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../prisma") return {};
  return originalLoad.call(this, request, parent, isMain);
};
let service;
try {
  service = require("./analytics-collector-control-service");
} finally {
  Module._load = originalLoad;
}
const {
  COLLECTOR_TYPES, buildCollectionPlanningDedupeParams, acceptFinancialGeneration, completeFinancialCollection, recordFinancialCollectionFailure,
  acceptCampaignGeneration, completeCampaignCollection, recordCampaignCollectionFailure,
} = service;

function job(type, generation, requestedAt, id = generation) {
  return {
    id,
    agencyId: "agency-1",
    creatorId: "creator-1",
    params: {
      collectionContractVersion: 1,
      collectionType: type,
      collectionMode: "full",
      collectionGeneration: generation,
      collectionRequestedAt: requestedAt,
      collectionReason: "test",
    },
  };
}

function stateDb(kind) {
  let state = null;
  const locks = [];
  const delegate = {
    findUnique: async () => state,
    upsert: async ({ create, update }) => {
      state = state ? { ...state, ...update } : { id: `${kind}-state`, ...create };
      return state;
    },
  };
  const tx = {
    $executeRawUnsafe: async (sql, key) => { locks.push([sql, key]); return 1; },
    creatorFinancialCollectionState: kind === "financial" ? delegate : undefined,
    creatorCampaignCollectionState: kind === "campaign" ? delegate : undefined,
  };
  const db = {
    $transaction: async (work) => work(tx),
    _state: () => state,
    _locks: locks,
  };
  return db;
}


test("collection planning identity excludes trigger provenance and random command generation", () => {
  const state = {
    activeGeneration: "accepted-generation",
    baselineVerifiedAt: new Date("2026-09-08T19:00:00.000Z"),
    lastCatchupCompletedAt: new Date("2026-09-08T20:00:00.000Z"),
  };
  assert.deepEqual(buildCollectionPlanningDedupeParams({
    collectorType: COLLECTOR_TYPES.FINANCIAL, collectionMode: "catchup", state,
  }), {
    planningEpoch: "accepted-generation:2026-09-08T20:00:00.000Z",
    collectionContractVersion: 1,
    collectionType: "FINANCIAL",
    collectionMode: "catchup",
  });
  assert.deepEqual(buildCollectionPlanningDedupeParams({
    collectorType: COLLECTOR_TYPES.NOTIFICATIONS, collectionMode: "full", state: null,
  }), {
    planningEpoch: "none:none",
    collectionContractVersion: 1,
    collectionType: "NOTIFICATIONS",
    collectionMode: "full",
  });
});

test("financial collection state serializes exact server generations and rejects same-time competing commands", async () => {
  const db = stateDb("financial");
  const at = "2026-09-08T20:00:00.123Z";
  const first = job(COLLECTOR_TYPES.FINANCIAL, "generation-A", at, "job-A");
  const competing = job(COLLECTOR_TYPES.FINANCIAL, "generation-B", at, "job-B");

  assert.equal((await acceptFinancialGeneration({ db, job: first })).accepted, true);
  assert.equal((await acceptFinancialGeneration({ db, job: competing })).stale, true);
  assert.equal((await completeFinancialCollection({ db, job: competing, complete: true, scanRunId: "generation-B" })).stale, true);
  assert.equal(db._state().activeGeneration, "generation-A");
  assert.equal(db._state().status, "SCANNING");

  const completed = await completeFinancialCollection({ db, job: first, complete: true, scanRunId: "generation-A", rangeFrom: "2016-01-01T00:00:00Z", rangeTo: at });
  assert.equal(completed.applied, true);
  assert.equal(db._state().status, "COMPLETE");
  assert.equal(db._state().baselineGeneration, "generation-A");
  const verifiedAt = db._state().baselineVerifiedAt;
  const replay = await acceptFinancialGeneration({ db, job: first });
  assert.equal(replay.replay, true);
  assert.equal(db._state().status, "COMPLETE");
  const completionReplay = await completeFinancialCollection({ db, job: first, complete: true, scanRunId: "generation-A", rangeFrom: "2016-01-01T00:00:00Z", rangeTo: at });
  assert.equal(completionReplay.replay, true);
  assert.equal(db._state().baselineVerifiedAt, verifiedAt);
  await recordFinancialCollectionFailure({ db, job: first, error: new Error("late same-generation failure") });
  assert.equal(db._state().status, "COMPLETE");

  await recordFinancialCollectionFailure({ db, job: competing, error: new Error("late failure") });
  assert.equal(db._state().status, "COMPLETE");
  assert.equal(db._state().activeGeneration, "generation-A");
  assert.ok(db._locks.length >= 5);
  assert.ok(db._locks.every(([, key]) => key === "analytics-collector:financial:creator-1"));
});

test("a later campaign server command supersedes the old generation and stale completion cannot roll it back", async () => {
  const db = stateDb("campaign");
  const oldJob = job(COLLECTOR_TYPES.CAMPAIGNS, "campaign-old", "2026-09-08T20:00:00.123Z", "job-old");
  const newJob = job(COLLECTOR_TYPES.CAMPAIGNS, "campaign-new", "2026-09-08T20:00:00.124Z", "job-new");

  assert.equal((await acceptCampaignGeneration({ db, job: oldJob })).accepted, true);
  assert.equal((await acceptCampaignGeneration({ db, job: newJob })).accepted, true);
  assert.equal(db._state().activeGeneration, "campaign-new");

  const stale = await completeCampaignCollection({ db, job: oldJob, complete: true, scanRunId: "campaign-old" });
  assert.equal(stale.stale, true);
  assert.equal(db._state().activeGeneration, "campaign-new");
  assert.equal(db._state().status, "SCANNING");

  const current = await completeCampaignCollection({ db, job: newJob, complete: true, scanRunId: "campaign-new" });
  assert.equal(current.applied, true);
  assert.equal(db._state().status, "COMPLETE");
  assert.equal(db._state().baselineGeneration, "campaign-new");
  const verifiedAt = db._state().baselineVerifiedAt;
  const pageReplay = await acceptCampaignGeneration({ db, job: newJob });
  assert.equal(pageReplay.replay, true);
  assert.equal(db._state().status, "COMPLETE");
  const completionReplay = await completeCampaignCollection({ db, job: newJob, complete: true, scanRunId: "campaign-new" });
  assert.equal(completionReplay.replay, true);
  assert.equal(db._state().baselineVerifiedAt, verifiedAt);
  assert.ok(db._locks.every(([, key]) => key === "analytics-collector:campaigns:creator-1"));
});

test("collector failure state preserves the Job retry boundary and terminal failure has no automatic retryAt", async () => {
  const retryAt = new Date("2026-09-08T20:04:00.000Z");

  const financialDb = stateDb("financial");
  const financialJob = job(COLLECTOR_TYPES.FINANCIAL, "financial-retry", "2026-09-08T20:00:00.000Z", "financial-job");
  await acceptFinancialGeneration({ db: financialDb, job: financialJob });
  await recordFinancialCollectionFailure({ db: financialDb, job: financialJob, error: new Error("provider timeout"), terminal: false, retryAfterAt: retryAt });
  assert.equal(financialDb._state().status, "FAILED");
  assert.equal(financialDb._state().retryAfterAt.toISOString(), retryAt.toISOString());

  const campaignDb = stateDb("campaign");
  const campaignJob = job(COLLECTOR_TYPES.CAMPAIGNS, "campaign-terminal", "2026-09-08T20:00:00.000Z", "campaign-job");
  await acceptCampaignGeneration({ db: campaignDb, job: campaignJob });
  await recordCampaignCollectionFailure({ db: campaignDb, job: campaignJob, error: new Error("contract rejected"), terminal: true, retryAfterAt: retryAt });
  assert.equal(campaignDb._state().status, "FAILED");
  assert.equal(campaignDb._state().retryAfterAt, null, "terminal execution failure is quarantined from automatic scheduling");
});
