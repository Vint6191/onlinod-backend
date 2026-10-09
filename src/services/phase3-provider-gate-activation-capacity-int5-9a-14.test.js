"use strict";
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const credit = require("./provider-request-credit-authority-service");
const capacity = require("./provider-capacity-sla-service");

function activationDb(start = new Date("2038-02-03T04:05:06.000Z")) {
  const db = {
    now: new Date(start),
    state: {
      id: "of-global",
      activePermitId: null, activeOwnerInstanceId: null, activeAgencyId: null, activeCreatorId: null,
      activeDeviceId: null, activeCapability: null, activeIntervalMs: null, activeGrantedAt: null, activeExpiresAt: null,
      nextAllowedAt: null, revision: 0n, lastStartedAt: null, lastStartedCreatorId: null, lastStartedDeviceId: null,
      priorityCursor: 0, backgroundCategoryCursor: 0,
      fairnessGeneration: credit.PROVIDER_GATE_FAIRNESS_GENERATION,
      fairnessActivationState: "DRAINING",
      fairnessDrainStartedAt: new Date(start),
      fairnessActivatedAt: null, fairnessActivationConfirmedAt: null,
      legacyPermitLastSeenAt: null, legacyPermitCount: 0n,
    },
    waiters: [],
    $transaction: async (work) => work({ ...(db), $transaction: undefined }),
    $queryRawUnsafe: async (sql, ...args) => {
      const text = String(sql);
      if (/INSERT INTO "OfProviderRequestGateState"/.test(text)) return [];
      if (/FROM "OfProviderRequestGateState" s[\s\S]*FOR UPDATE/.test(text)) return [{ ...db.state, authorityNow: new Date(db.now) }];
      if (/SELECT[\s\S]*s\."fairnessGeneration"[\s\S]*FROM "OfProviderRequestGateState" s/.test(text)) return [{ ...db.state, authorityNow: new Date(db.now) }];
      if (/FROM pg_trigger t/.test(text)) return [{
        triggerName: "onlinod_provider_gate_waiter_registration", enabled: "O",
        functionName: "onlinod_enforce_provider_gate_waiter_registration",
        functionDefinition: "fairnessActivationState 'ACTIVE' ONLINOD_PROVIDER_GATE_WAITER_REQUIRED legacyPermitLastSeenAt",
        triggerDefinition: "BEFORE UPDATE OF activePermitId",
      }];
      if (/SELECT "activePermitId","activeExpiresAt"/.test(text)) return [{
        activePermitId: db.state.activePermitId,
        activeExpiresAt: db.state.activeExpiresAt,
        liveWaiters: db.waiters.length,
        authorityNow: new Date(db.now),
      }];
      if (/SELECT COUNT\(\*\)::int AS count FROM "OfProviderRequestGateWaiter"/.test(text)) return [{ count: db.waiters.length }];
      if (/SET "fairnessActivationState"='QUIESCING'/.test(text)) {
        if (db.state.fairnessActivationState !== "DRAINING") return [];
        db.state.fairnessActivationState = "QUIESCING";
        db.state.fairnessDrainStartedAt = new Date(db.now);
        db.state.fairnessActivatedAt = null;
        db.state.fairnessActivationConfirmedAt = null;
        return [{ ...db.state, authorityNow: new Date(db.now) }];
      }
      if (/SET "fairnessActivationState"='ACTIVE'/.test(text)) {
        if (db.state.fairnessActivationState !== "QUIESCING") return [];
        db.state.fairnessActivationState = "ACTIVE";
        db.state.fairnessActivatedAt = new Date(db.now);
        db.state.fairnessActivationConfirmedAt = new Date(db.now);
        return [{ ...db.state, authorityNow: new Date(db.now) }];
      }
      if (/UPDATE "OfProviderRequestGateState"/.test(text) && /"activePermitId"\s*=\s*\$2/.test(text)) {
        db.state.activePermitId = args[1];
        db.state.activeOwnerInstanceId = args[2];
        db.state.activeAgencyId = args[3];
        db.state.activeCreatorId = args[4];
        db.state.activeDeviceId = args[5];
        db.state.activeCapability = args[6];
        db.state.activeIntervalMs = args[7];
        db.state.activeGrantedAt = args[8];
        db.state.activeExpiresAt = args[9];
        db.state.legacyPermitLastSeenAt = new Date(db.now);
        db.state.legacyPermitCount += 1n;
        db.state.revision += 1n;
        return [{ revision: db.state.revision, legacyPermitLastSeenAt: db.state.legacyPermitLastSeenAt, legacyPermitCount: db.state.legacyPermitCount }];
      }
      if (/UPDATE "OfProviderRequestGateState"/.test(text)) {
        db.state.activePermitId = null; db.state.activeOwnerInstanceId = null; db.state.activeAgencyId = null;
        db.state.activeCreatorId = null; db.state.activeDeviceId = null; db.state.activeCapability = null;
        db.state.activeIntervalMs = null; db.state.activeGrantedAt = null; db.state.activeExpiresAt = null;
        db.state.revision += 1n;
        return [{ revision: db.state.revision, nextAllowedAt: db.state.nextAllowedAt }];
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
  return db;
}

const legacyScope = {
  permitId: "legacy-permit-1", ownerInstanceId: "backend-old", agencyId: "agency-1",
  creatorId: "creator-1", deviceId: "device-1", capability: "read", intervalMs: 700,
};

test("provider fairness requires the current active generation", async () => {
 const db=activationDb();db.state.fairnessActivationState='ACTIVE';
 assert.equal((await credit.readProviderGateFairnessAuthority({db})).activationState,'ACTIVE');
 db.state.fairnessActivationState='DRAINING';
 assert.equal((await credit.readProviderGateFairnessAuthority({db})).activationState,'UNAVAILABLE');
});





test("A14 physical capacity math proves 72h is a deadline signal, not a universal 4k-creator promise", () => {
  const starts = capacity.providerPhysicalStartsPerHour(700);
  assert.ok(starts > 5142 && starts < 5143);
  assert.equal(capacity.providerPriorityShare("background"), 1 / 8);
  assert.equal(capacity.providerBackgroundCategoryShare("campaign_directory"), 1 / 6);
  assert.equal(capacity.estimatedCampaignDirectoryCalls(2_000), 41);

  const full500 = capacity.campaignDirectoryFleetFeasibility({ creatorCount: 500, campaignCount: 2_000 });
  const full4000 = capacity.campaignDirectoryFleetFeasibility({ creatorCount: 4_000, campaignCount: 2_000 });
  const background500 = capacity.campaignDirectoryFleetFeasibility({ creatorCount: 500, campaignCount: 2_000, mode: "background_only" });
  assert.equal(full500.feasibleWithinTarget, false);
  assert.equal(full4000.feasibleWithinTarget, false);
  assert.equal(background500.feasibleWithinTarget, true);
  assert.ok(full500.requiredHours > 190 && full500.requiredHours < 193);
  assert.ok(full4000.requiredHours > 1530 && full4000.requiredHours < 1532);
});

test("A14 directory read status becomes explicitly OVERDUE without pretending source freshness", () => {
  const state = capacity.campaignDirectoryDiscoveryCapacityState({
    campaignDirectoryRequestedAt: new Date("2026-09-15T00:00:00Z"),
    campaignDirectoryVerifiedAt: new Date("2026-09-15T00:00:00Z"),
    campaignDirectoryDiscoveryDueAt: new Date("2026-09-18T00:00:00Z"),
    campaignDirectoryDiscoveryRequestedRevision: 3,
    campaignDirectoryDiscoveryCompletedRevision: 3,
    campaignDirectoryCampaignCount: 2_000,
  }, new Date("2026-09-19T00:00:00Z"));
  assert.equal(state.status, "OVERDUE");
  assert.equal(state.overdueByMs, 24 * 60 * 60 * 1000);
  assert.equal(state.estimatedProviderCalls, 41);
});
