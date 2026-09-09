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
  COLLECTOR_TYPES, buildCollectionPlanningDedupeParams, stampCollectionAuthorityParams, collectionCommand, commandAuthority, sameGeneration,
  acceptFinancialGeneration, completeFinancialCollection, recordFinancialCollectionFailure,
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
    activeRequestedAt: new Date("2026-09-08T20:01:00.123Z"),
  };
  assert.deepEqual(buildCollectionPlanningDedupeParams({
    collectorType: COLLECTOR_TYPES.FINANCIAL, collectionMode: "catchup", state,
  }), {
    planningEpoch: "accepted-generation:2026-09-08T20:00:00.000Z",
    collectionOrderingAfter: "2026-09-08T20:01:00.123Z",
    collectionContractVersion: 1,
    collectionType: "FINANCIAL",
    collectionMode: "catchup",
  });
  assert.deepEqual(buildCollectionPlanningDedupeParams({
    collectorType: COLLECTOR_TYPES.NOTIFICATIONS, collectionMode: "full", state: null,
  }), {
    planningEpoch: "none:none",
    collectionOrderingAfter: "none",
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


test("DB authority timestamp outranks process-clock provenance and same generation survives adoption timestamp rewrite", () => {
  const queued = job(COLLECTOR_TYPES.FINANCIAL, "generation-db-clock", "2099-01-01T00:00:00.000Z", "job-db-clock");
  queued.params.collectionAuthorityRequestedAt = "2026-09-09T03:00:00.000Z";
  const command = collectionCommand(queued, COLLECTOR_TYPES.FINANCIAL);
  assert.equal(command.requestedAt.toISOString(), "2026-09-09T03:00:00.000Z");

  const adoptedState = {
    activeGeneration: "generation-db-clock",
    activeRequestedAt: new Date("2099-01-01T00:00:00.000Z"),
  };
  assert.equal(commandAuthority(adoptedState, command), "CURRENT");
  assert.equal(sameGeneration(adoptedState, command), true);
});


test("DB collection authority stamps provider time boundaries, not replica wall-clock boundaries", () => {
  const authorityAt = new Date("2026-09-09T03:10:11.987Z");
  const financial = stampCollectionAuthorityParams({
    collectionType: COLLECTOR_TYPES.FINANCIAL,
    collectionRequestedAt: "2099-01-01T00:00:00.000Z",
    initialMarker: 9999999999,
    endDate: "2099-01-01 00:00:00",
  }, authorityAt);
  assert.equal(financial.collectionAuthorityRequestedAt, authorityAt.toISOString());
  assert.equal(financial.initialMarker, Math.floor(authorityAt.getTime() / 1000));
  assert.equal(financial.endDate, "2026-09-09 03:10:11");

  const notification = stampCollectionAuthorityParams({
    collectionType: COLLECTOR_TYPES.NOTIFICATIONS,
    to: "2099-01-01T00:00:00.000Z",
  }, authorityAt);
  assert.equal(notification.to, new Date(authorityAt.getTime() + 5 * 60 * 1000).toISOString());
});


test("collection ordering advances monotonically past the durable command while source boundary stays on physical DB time", () => {
  const physicalDbNow = new Date("2026-09-09T03:10:11.999Z");
  const previousOrdering = new Date("2026-09-09T03:10:11.999Z");
  const financial = stampCollectionAuthorityParams({
    collectionType: COLLECTOR_TYPES.FINANCIAL,
    collectionRequestedAt: "2099-01-01T00:00:00.000Z",
  }, physicalDbNow, previousOrdering);
  assert.equal(financial.collectionAuthorityRequestedAt, "2026-09-09T03:10:12.000Z");
  assert.equal(financial.initialMarker, Math.floor(physicalDbNow.getTime() / 1000));
  assert.equal(financial.endDate, "2026-09-09 03:10:11");

  const notification = stampCollectionAuthorityParams({
    collectionType: COLLECTOR_TYPES.NOTIFICATIONS,
  }, physicalDbNow, new Date("2026-09-09T03:10:12.500Z"));
  assert.equal(notification.collectionAuthorityRequestedAt, "2026-09-09T03:10:12.501Z");
  assert.equal(notification.to, "2026-09-09T03:15:11.999Z", "provider boundary must stay anchored to physical PostgreSQL time");
});
