"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const authority = require("./domain-work-authority-service");
const release = require("./phase2-release-compatibility-authority-service");

function claimAuthorizationRows(statement, params = []) {
  const text = String(statement);
  if (text.includes('FROM "DomainWorkClaimTopologyState"') && text.includes("FOR SHARE")) {
    return [{ generation: authority.DOMAIN_WORK_CLAIM_TOPOLOGY_ID, activationState: "ACTIVE" }];
  }
  if (text.includes('FROM "Phase2ReleaseCompatibilityAuthority"') && text.includes("FOR SHARE")) {
    return [{ requiredGeneration: release.DOMAIN_WORK_EXECUTOR_GENERATION, activationState: "ACTIVE" }];
  }
  if (text.includes("set_config")) return [{ value: params[1] }];
  return null;
}

function productionClaimDb(now) {
  const sql = [];
  let agencySelections = 0;
  let shardSelections = 0;
  const db = {
    phase2WorkGenerationAuthority: {
      async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; },
    },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy-lane" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { return work(db); },
    async $queryRawUnsafe(statement, ...params) {
      const text = String(statement);
      sql.push(text);
      const authorization = claimAuthorizationRows(text, params);
      if (authorization) return authorization;
      if (text.includes("clock_timestamp")) return [{ authorityNow: now }];
      if (text.includes('UPDATE "DomainWorkClaimAgencyState" a') && text.includes('RETURNING a."agencyId"')) {
        agencySelections += 1;
        return agencySelections === 1 ? [{ agencyId: "agency-1" }] : [];
      }
      if (text.includes('UPDATE "DomainWorkClaimShardState" s') && text.includes('RETURNING s."claimShard"')) {
        shardSelections += 1;
        return shardSelections === 1 ? [{ claimShard: 7 }] : [];
      }
      if (text.includes('SELECT f."partitionKey"') && text.includes('FROM "Phase2WorkBroadClaimPartitionState" f')) {
        return [{ partitionKey: "creator-1" }];
      }
      return [];
    },
  };
  return { db, sql };
}

test("A36 broad claim reserves bounded Agency/shard locators without FamilyState execution authority", async () => {
  const now = new Date("2026-09-10T18:00:00.000Z");
  const fx = productionClaimDb(now);
  const result = await authority.claimDomainWorkBatch({
    db: fx.db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
    ownerToken: "actual56-worker", limit: 25, perAgencyQuantum: 5, perPartitionQuantum: 2, fallbackNow: now,
  });
  assert.deepEqual(result.items, []);
  const agencyDiscovery = fx.sql.find((entry) => entry.includes('UPDATE "DomainWorkClaimAgencyState" a'));
  const shardDiscovery = fx.sql.find((entry) => entry.includes('UPDATE "DomainWorkClaimShardState" s'));
  const claimSql = fx.sql.find((entry) => entry.includes('WITH selected_partitions("partitionKey") AS MATERIALIZED'));
  assert.ok(agencyDiscovery, "production broad claim must reserve one Agency locator");
  assert.ok(shardDiscovery, "production broad claim must reserve one fixed shard locator");
  assert.ok(claimSql, "production SQL claim path must execute");
  assert.match(agencyDiscovery, /ORDER BY a\."nextDispatchAt",a\."revision",a\."agencyId"/);
  assert.match(shardDiscovery, /ORDER BY s\."nextDispatchAt",s\."revision",s\."claimShard"/);
  assert.match(claimSql, /VALUES \(\$9\)/);
  assert.match(claimSql, /FOR UPDATE OF d SKIP LOCKED[\s\S]*LIMIT \$5/);
  assert.doesNotMatch(agencyDiscovery, /EXISTS \([\s\S]*DomainWorkItem/);
  assert.doesNotMatch(fx.sql.join("\n"), /FROM "Phase2WorkFamilyState" s/);
  assert.doesNotMatch(fx.sql.join("\n"), /DomainWorkReadyAgency|DomainWorkReadyPartition/);
});

test("A36 broad member scope derives the only claim tenant from the fenced membership", async () => {
  const now = new Date("2026-09-10T18:00:00.000Z");
  const sql = [];
  let claimedAgency = null;
  const db = {
    phase2WorkGenerationAuthority: {
      async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; },
    },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy-lane" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    domainWorkClaimTopologyState: {
      async findUnique() {
        return { generation: authority.DOMAIN_WORK_CLAIM_TOPOLOGY_ID, activationState: "ACTIVE", revision: 1n };
      },
    },
    async $transaction(work) { return work(db); },
    async $queryRawUnsafe(statement, ...params) {
      const text = String(statement);
      sql.push(text);
      const authorization = claimAuthorizationRows(text, params);
      if (authorization) return authorization;
      if (text.includes("clock_timestamp")) return [{ authorityNow: now }];
      if (text.includes('FROM "AgencyMember" m') && text.includes("FOR SHARE OF m")) {
        assert.deepEqual(params.slice(0, 4), ["member-a", "user-a", "agency-member", 7]);
        return [{ id: "member-a", broad: true }];
      }
      if (text.includes('UPDATE "DomainWorkClaimShardState" s')) return [{ claimShard: 7 }];
      if (text.includes('SELECT f."partitionKey"') && text.includes('FROM "Phase2WorkBroadClaimPartitionState" f')) {
        assert.equal(params[3], "agency-member");
        return [{ partitionKey: "creator-1" }];
      }
      if (text.includes('WITH selected_partitions("partitionKey") AS MATERIALIZED')) {
        claimedAgency = params[3];
        return [{ id: "member-work", agencyId: claimedAgency, partitionKey: "creator-1" }];
      }
      return [];
    },
  };

  const result = await authority.claimDomainWorkBatch({
    db,
    workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
    memberScope: { memberId: "member-a", userId: "user-a", agencyId: "agency-member", accessEpoch: 7 },
    ownerToken: "member-worker",
    limit: 1,
    perAgencyQuantum: 1,
    perPartitionQuantum: 1,
    fallbackNow: now,
  });

  assert.equal(result.items.length, 1);
  assert.equal(claimedAgency, "agency-member");
  assert.equal(sql.some((entry) => entry.includes('UPDATE "DomainWorkClaimAgencyState" a')), false,
    "member-scoped execution must never enter global Agency dispatch");
});

test("A36 physical fallback claims one DWI then revision-CAS reconciles its locator chain", async () => {
  const now = new Date("2026-09-10T18:00:00.000Z");
  const sql = [];
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy-lane" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { return work(db); },
    async $queryRawUnsafe(statement, ...params) {
      const text = String(statement); sql.push(text);
      const authorization = claimAuthorizationRows(text, params);
      if (authorization) return authorization;
      if (text.includes("clock_timestamp")) return [{ authorityNow: now }];
      if (text.includes('SELECT d."agencyId"') && text.includes('FROM "DomainWorkItem" d')) return [{ agencyId: "agency-recovered" }];
      if (text.includes('AS "claimShard"') && text.includes('FROM "DomainWorkItem" d')) return [{ claimShard: 11 }];
      if (text.includes('SELECT f."partitionKey"') && text.includes('FROM "Phase2WorkBroadClaimPartitionState" f')) return [];
      if (text.includes('UPDATE "DomainWorkItem" d SET') && text.includes('LIMIT 1')) {
        return [{ id: "claimed-recovery-row", agencyId: "agency-recovered", partitionKey: "creator-recovered" }];
      }
      return [];
    },
  };
  const result = await authority.claimDomainWorkBatch({
    db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, ownerToken: "recovery-worker",
    limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1, fallbackNow: now,
  });
  assert.equal(result.items.length, 1);
  const fallback = sql.find((entry) => entry.includes('UPDATE "DomainWorkItem" d SET') && entry.includes('LIMIT 1'));
  assert.ok(fallback);
  assert.match(fallback, /FOR UPDATE OF d SKIP LOCKED[\s\S]*LIMIT 1/);
  assert.ok(sql.some((entry) => entry.includes("phase3_reconcile_domain_work_claim_partition")));
  assert.ok(sql.some((entry) => entry.includes("phase3_reconcile_domain_work_claim_shard")));
  assert.ok(sql.some((entry) => entry.includes("phase3_reconcile_domain_work_claim_agency")));
  assert.doesNotMatch(sql.join("\n"), /phase2_lock_domain_work_current_partition/);
  assert.doesNotMatch(sql.join("\n"), /INSERT INTO "Phase2WorkFamilyState"|UPDATE "Phase2WorkFamilyState"/);
});

test("A36 current partition candidate is admitted after separate Agency/shard reservations", async () => {
  const now = new Date("2026-09-10T18:00:00.000Z");
  const sql = [];
  let claimedAgency = null;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy-lane" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { return work(db); },
    async $queryRawUnsafe(statement, ...params) {
      const text = String(statement); sql.push(text);
      const authorization = claimAuthorizationRows(text, params);
      if (authorization) return authorization;
      if (text.includes("clock_timestamp")) return [{ authorityNow: now }];
      if (text.includes('UPDATE "DomainWorkClaimAgencyState" a')) return [{ agencyId: "agency-current" }];
      if (text.includes('UPDATE "DomainWorkClaimShardState" s')) return [{ claimShard: 5 }];
      if (text.includes('SELECT f."partitionKey"') && text.includes('FROM "Phase2WorkBroadClaimPartitionState" f')) return [{ partitionKey: "creator-1" }];
      if (text.includes('WITH selected_partitions("partitionKey") AS MATERIALIZED')) {
        claimedAgency = params[3];
        return [{ id: "work-1", agencyId: claimedAgency, partitionKey: "creator-1" }];
      }
      return [];
    },
  };
  const result = await authority.claimDomainWorkBatch({
    db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, ownerToken: "cut-a",
    limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1, fallbackNow: now,
  });
  assert.equal(result.items.length, 1);
  assert.equal(claimedAgency, "agency-current");
  assert.doesNotMatch(sql.join("\n"), /Phase2WorkFamilyState/);
});

test("INT7 Root A partition catalog is populated by a non-authoritative DWI trigger and bootstrap seed", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911190000_phase2_actual55_int7_broad_partition_catalog", "migration.sql"), "utf8");
  assert.match(migration, /CREATE TRIGGER "trg_phase2_domain_work_partition_catalog"/);
  assert.match(migration, /AFTER INSERT OR UPDATE OF "agencyId","workClass","partitionKey","activeGeneration","isOutstanding"/);
  assert.ok(
    "trg_phase2_domain_work_family_state" < "trg_phase2_domain_work_partition_catalog",
    "PostgreSQL same-kind trigger name order must preserve FamilyState -> PartitionCatalog",
  );
  assert.doesNotMatch(migration, /CREATE TRIGGER "trg_phase2_domain_work_broad_partition_catalog"/);
  assert.match(migration, /INSERT INTO "Phase2WorkBroadClaimPartitionState"/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "Phase2WorkBroadClaimPartitionState_recovery_idx"[\s\S]*"workClass","activeGeneration","lastClaimedAt","agencyId","partitionKey"/);
  assert.match(migration, /FROM "DomainWorkItem" d[\s\S]*JOIN "Phase2WorkGenerationAuthority" g[\s\S]*g\."activeGeneration"=d\."activeGeneration"[\s\S]*WHERE d\."isOutstanding"=TRUE/);
  assert.ok(
    migration.indexOf('CREATE TRIGGER "trg_phase2_domain_work_partition_catalog"') <
      migration.lastIndexOf('INSERT INTO "Phase2WorkBroadClaimPartitionState"'),
    "catalog trigger must exist before bootstrap so concurrent new work cannot be missed during the seed",
  );
  assert.doesNotMatch(migration, /DomainWorkReadyAgency|DomainWorkReadyPartition/);
});

test("A36 catalog miss claims one physical DWI and repairs bounded locators with CAS", async () => {
  const now = new Date("2026-09-10T18:00:00.000Z");
  const sql = [];
  let normalCatalogClaim = 0;
  let physicalFallback = 0;
  let physicalShard = 0;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy-lane" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { return work(db); },
    async $queryRawUnsafe(statement, ...params) {
      const text = String(statement); sql.push(text);
      const authorization = claimAuthorizationRows(text, params);
      if (authorization) return authorization;
      if (text.includes("clock_timestamp")) return [{ authorityNow: now }];
      if (text.includes('AS "claimShard"') && text.includes('FROM "DomainWorkItem" d')) {
        physicalShard += 1; return physicalShard === 1 ? [{ claimShard: 13 }] : [];
      }
      if (text.includes('SELECT f."partitionKey"') && text.includes('FROM "Phase2WorkBroadClaimPartitionState" f')) {
        normalCatalogClaim += 1; return [];
      }
      if (text.includes('UPDATE "DomainWorkItem" d SET') && text.includes('LIMIT 1')) {
        physicalFallback += 1;
        return physicalFallback === 1
          ? [{ id: "fallback-row", agencyId: "agency-1", partitionKey: "creator-fallback" }]
          : [];
      }
      return [];
    },
  };
  const result = await authority.claimDomainWorkBatch({
    db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, agencyId: "agency-1", ownerToken: "int7-fallback",
    limit: 5, perAgencyQuantum: 5, perPartitionQuantum: 1, fallbackNow: now,
  });
  assert.equal(result.items.length, 1);
  assert.equal(normalCatalogClaim, 1);
  assert.equal(physicalFallback, 1);
  const normal = sql.find((entry) => entry.includes('SELECT f."partitionKey"') && entry.includes('FROM "Phase2WorkBroadClaimPartitionState" f'));
  const fallback = sql.find((entry) => entry.includes('UPDATE "DomainWorkItem" d SET') && entry.includes('LIMIT 1'));
  assert.ok(normal); assert.ok(fallback);
  assert.doesNotMatch(normal, /partition_heads|DISTINCT ON \(d\."partitionKey"\)/);
  assert.match(fallback, /FOR UPDATE OF d SKIP LOCKED[\s\S]*LIMIT 1/);
  assert.ok(sql.some((entry) => entry.includes("phase3_reconcile_domain_work_claim_partition")));
});

test("F53-06 expired legacy owner does not block the new generation", async () => {
  const now = new Date("2026-09-10T18:00:00.000Z");
  const expiredAt = new Date(now.getTime() - 1);
  let observedWhere = null;
  const db = {
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy-lane" }]; } },
    maintenanceLaneState: {
      async findMany({ where }) {
        observedWhere = where;
        const cutoff = where?.leaseUntil?.gt;
        return expiredAt > cutoff ? [{ key: "legacy-lane", ownerToken: "dead", leaseUntil: expiredAt }] : [];
      },
    },
  };
  const result = await authority.legacyExecutorDrainStatus({ db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, fallbackNow: now });
  assert.equal(result.ready, true);
  assert.equal(result.lanes.length, 0);
  assert.equal(new Date(observedWhere.leaseUntil.gt).getTime(), now.getTime());
});

test("F53-14 unsupported binary generation is fenced by durable active-generation authority", async () => {
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: "new-generation" }; } },
  };
  const result = await authority.claimDomainWorkBatch({
    db, workClass: authority.WORK_CLASS.CUSTOM_REMINDER, generation: "old-generation", ownerToken: "old-binary",
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "unsupported_domain_work_generation");
  assert.equal(result.activeGeneration, "new-generation");
});

test("F53-16/INT6 family zero proof uses one bounded current-DWI probe, never lifetime DONE history", async () => {
  let currentProbes = 0;
  let lifetimeScans = 0;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; } },
    phase2WorkFamilyState: {
      async findUnique() {
        return { activeGeneration: authority.DOMAIN_WORK_GENERATION, outstandingCount: 0, requestedSequence: 1_000_000n, convergedSequence: 1_000_000n };
      },
    },
    domainWorkItem: {
      async findFirst({ where, select }) {
        currentProbes += 1;
        assert.equal(where.agencyId, "agency-1");
        assert.equal(where.workClass, authority.WORK_CLASS.TEAM_READ_SUMMARY);
        assert.equal(where.activeGeneration, authority.DOMAIN_WORK_GENERATION);
        assert.equal(where.isOutstanding, true);
        assert.deepEqual(select, { id: true });
        return null;
      },
      async count() { lifetimeScans += 1; throw new Error("lifetime DWI history must not be scanned"); },
      async findMany() { lifetimeScans += 1; throw new Error("lifetime DWI history must not be scanned"); },
    },
  };
  const state = await authority.domainWorkFamilyState({ db, agencyId: "agency-1", workClass: authority.WORK_CLASS.TEAM_READ_SUMMARY });
  assert.equal(state.fresh, true);
  assert.equal(state.outstandingCount, 0);
  assert.equal(await authority.hasOutstandingDomainWork({ db, agencyId: "agency-1", workClass: authority.WORK_CLASS.TEAM_READ_SUMMARY }), false);
  assert.equal(currentProbes, 2);
  assert.equal(lifetimeScans, 0);
});




test("INT6 Root A projected family zero cannot false-green while current DWI still exists", async () => {
  const workClass = authority.WORK_CLASS.TEAM_READ_SUMMARY;
  const generation = authority.DOMAIN_WORK_GENERATION;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: generation }; } },
    phase2WorkFamilyState: { async findUnique() { return { activeGeneration: generation, outstandingCount: 0, requestedSequence: 9n, convergedSequence: 9n }; } },
    domainWorkItem: { async findFirst() { return { id: "still-live" }; } },
  };
  const state = await authority.domainWorkFamilyState({ db, agencyId: "agency-1", workClass });
  assert.equal(state.fresh, false);
  assert.equal(state.state, "CURRENT_WORK_PRESENT");
  assert.equal(state.hasOutstanding, true);
  assert.equal(await authority.hasOutstandingDomainWork({ db, agencyId: "agency-1", workClass }), true);
});

test("INT6 Root A stale family projection defers to physical current-generation truth without permanent liveness debt", async () => {
  const workClass = authority.WORK_CLASS.TEAM_READ_SUMMARY;
  const generation = authority.DOMAIN_WORK_GENERATION;
  let live = false;
  const db = {
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: generation }; } },
    phase2WorkFamilyState: { async findUnique() { return { activeGeneration: "retired-generation", outstandingCount: 0, requestedSequence: 7n, convergedSequence: 7n }; } },
    domainWorkItem: { async findFirst() { return live ? { id: "current-generation-work" } : null; } },
  };
  let state = await authority.domainWorkFamilyState({ db, agencyId: "agency-1", workClass });
  assert.equal(state.fresh, true);
  assert.equal(state.state, "NO_LIVE_WORK");
  assert.equal(state.hasOutstanding, false);
  assert.equal(state.outstandingCount, 0);
  assert.equal(state.activeGeneration, generation);
  
  live = true;
  state = await authority.domainWorkFamilyState({ db, agencyId: "agency-1", workClass });
  assert.equal(state.fresh, false);
  assert.equal(state.state, "CURRENT_WORK_PRESENT");
  assert.equal(state.hasOutstanding, true);
});

test("INT5 Root A missing family-state never false-greens while current DWI is outstanding", async () => {
  const workClass = authority.WORK_CLASS.TEAM_READ_SUMMARY;
  const generation = authority.DOMAIN_WORK_GENERATION;
  const db = {
    phase2WorkFamilyState: { async findUnique() { return null; } },
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: generation }; } },
    domainWorkItem: { async findFirst() { return { id: "live-dwi" }; } },
  };
  const state = await authority.domainWorkFamilyState({ db, agencyId: "agency-1", workClass });
  assert.equal(state.fresh, false);
  assert.equal(state.state, "CURRENT_WORK_PRESENT");
  assert.equal(state.hasOutstanding, true);
  assert.equal(await authority.hasOutstandingDomainWork({ db, agencyId: "agency-1", workClass }), true);
});

test("INT5 Root A absent family-state is fresh only after a bounded current-DWI zero probe", async () => {
  const workClass = authority.WORK_CLASS.TEAM_READ_SUMMARY;
  const generation = authority.DOMAIN_WORK_GENERATION;
  const db = {
    phase2WorkFamilyState: { async findUnique() { return null; } },
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: generation }; } },
    domainWorkItem: { async findFirst() { return null; } },
  };
  const state = await authority.domainWorkFamilyState({ db, agencyId: "agency-1", workClass });
  assert.equal(state.fresh, true);
  assert.equal(state.state, "NO_LIVE_WORK");
  assert.equal(state.hasOutstanding, false);
});

test("INT5 Root A coverage convergence treats UNKNOWN outstanding state as not-zero", () => {
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const outstandingCalls = (scheduler.match(/const outstanding = await hasOutstandingDomainWork\(/g) || []).length;
  const failClosedChecks = (scheduler.match(/outstanding !== false/g) || []).length;
  assert.ok(outstandingCalls >= 3, "expected the current-work convergence gates to be inventoried");
  assert.equal(failClosedChecks, outstandingCalls, "every current-work convergence gate must fail closed on UNKNOWN");
});

test("F53-07 every scheduler coverage COMPLETE commit carries the claimed DomainWork fence", () => {
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const calls = [...scheduler.matchAll(/markPhase2CoverageComplete\(\{([\s\S]*?)\}\)/g)];
  assert.ok(calls.length >= 10, "expected all historical coverage completion families to be inventoried");
  for (const match of calls) {
    assert.match(match[1], /\bworkItem\s*:\s*item\b/, "coverage COMPLETE must carry the exact claimed work item");
    assert.match(match[1], /\bownerToken\b/, "coverage COMPLETE must carry the current claim owner token");
  }
});
