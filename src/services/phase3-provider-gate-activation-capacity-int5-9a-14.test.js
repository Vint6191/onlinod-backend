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

test("A14 rolling activation stays legacy-compatible in DRAINING, blocks A14 starts in QUIESCING, then enforces ACTIVE", async () => {
  const db = activationDb();
  const draining = await credit.tryAcquireLegacyCompatibleProviderPermit({ db: commitDatabaseFixture(db), ...legacyScope });
  assert.equal(draining.granted, true);
  assert.equal(db.state.legacyPermitCount, 1n);
  await credit.cancelDurableProviderPermit({ db: commitDatabaseFixture(db), ...legacyScope });

  const drain = await credit.beginProviderGateFairnessDrain(db);
  assert.equal(drain.changed, true);
  assert.equal(db.state.fairnessActivationState, "QUIESCING");
  const quiescing = await credit.tryAcquireLegacyCompatibleProviderPermit({ db: commitDatabaseFixture(db), ...legacyScope, permitId: "legacy-permit-2" });
  assert.equal(quiescing.granted, false);
  assert.equal(quiescing.reason, "fairness_quiescing");

  let diagnostics = await credit.providerGateFairnessActivationDiagnostics(db);
  assert.equal(diagnostics.readyToActivate, false, "quiet window must be proven before activation");
  db.now = new Date(db.now.getTime() + credit.PROVIDER_GATE_LEGACY_QUIET_MS + 1);
  diagnostics = await credit.providerGateFairnessActivationDiagnostics(db);
  assert.equal(diagnostics.readyToActivate, true);
  const activated = await credit.activateProviderGateFairnessAfterDrain(db);
  assert.equal(activated.activated, true);
  assert.equal(db.state.fairnessActivationState, "ACTIVE");
  const active = await credit.tryAcquireLegacyCompatibleProviderPermit({ db: commitDatabaseFixture(db), ...legacyScope, permitId: "legacy-permit-3" });
  assert.equal(active.granted, false);
  assert.equal(active.reason, "fairness_active");
});

test("A14 migration gates waiter enforcement behind explicit ACTIVE and tracks legacy permit traffic", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260919023000_phase3_provider_gate_fairness_activation_v2/migration.sql"), "utf8");
  const historicalA13 = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260919010000_phase3_provider_gate_durable_waiter_fairness_v1/migration.sql"), "utf8");
  for (const field of ["fairnessGeneration", "fairnessActivationState", "fairnessDrainStartedAt", "fairnessActivatedAt", "legacyPermitLastSeenAt", "legacyPermitCount"]) {
    assert.match(schema, new RegExp(`${field}\\s+`));
    assert.match(migration, new RegExp(`"${field}"`));
  }
  assert.match(migration, /fairnessActivationState[\s\S]*ACTIVE[\s\S]*ONLINOD_PROVIDER_GATE_WAITER_REQUIRED/);
  assert.match(migration, /legacyPermitLastSeenAt/);
  assert.match(migration, /legacyPermitCount/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);

  // Historical migrations are immutable. A14 must layer activation in a new
  // migration so an environment that already applied A13 does not hit Prisma
  // checksum drift. This hash is the exact A13 artifact shipped in checkpoint A13.
  assert.equal(crypto.createHash("sha256").update(historicalA13).digest("hex"),
    "fd56bc1cf7a816aecc9e7a05ea9f2561656b2589206348a40f771ee1c6baaf89");
  assert.doesNotMatch(historicalA13, /fairnessActivationState|legacyPermitLastSeenAt|legacyPermitCount/);
  assert.match(historicalA13, /ONLINOD_PROVIDER_GATE_WAITER_REQUIRED/);
  assert.doesNotMatch(historicalA13, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});

test("A14 operator control plane requires explicit diagnostics/drain/activate and never auto-activates on startup", () => {
  const script = fs.readFileSync(path.join(__dirname, "../../scripts/phase3-provider-gate-fairness-activation.js"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.equal(pkg.scripts["phase3:provider-gate-fairness"], "node scripts/phase3-provider-gate-fairness-activation.js");
  assert.match(script, /diagnostics/);
  assert.match(script, /begin-drain/);
  assert.match(script, /activateProviderGateFairnessAfterDrain/);
  assert.doesNotMatch(script, /AUTO_ACTIVATE|activate.*process\.env/i);
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
