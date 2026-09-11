"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const authority = require("./domain-work-authority-service");

function productionClaimDb(now) {
  const sql = [];
  const db = {
    phase2WorkGenerationAuthority: {
      async findUnique() { return { activeGeneration: authority.DOMAIN_WORK_GENERATION }; },
    },
    phase2LegacyExecutorFence: { async findMany() { return [{ laneKey: "legacy-lane" }]; } },
    maintenanceLaneState: { async findMany() { return []; } },
    async $transaction(work) { return work(db); },
    async $queryRawUnsafe(statement) {
      const text = String(statement);
      sql.push(text);
      if (text.includes("clock_timestamp")) return [{ authorityNow: now }];
      if (text.includes('SELECT a."agencyId"') && text.includes('FROM "DomainWorkReadyAgency"')) {
        const alreadyExcluded = text.includes('NOT IN');
        return alreadyExcluded ? [] : [{ agencyId: "agency-1" }];
      }
      if (text.includes('SELECT 1 AS ok FROM "DomainWorkReadyAgency"')) return [{ ok: 1 }];
      return [];
    },
  };
  return { db, sql };
}

test("F53-02 production claim discovers bounded current agency/partition heads before DomainWork rows", async () => {
  const now = new Date("2026-09-10T18:00:00.000Z");
  const fx = productionClaimDb(now);
  const result = await authority.claimDomainWorkBatch({
    db: fx.db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
    ownerToken: "actual53-worker", limit: 25, perAgencyQuantum: 5, perPartitionQuantum: 2, fallbackNow: now,
  });
  assert.deepEqual(result.items, []);
  const agencyDiscovery = fx.sql.find((entry) => entry.includes('SELECT a."agencyId"') && entry.includes('FROM "DomainWorkReadyAgency"'));
  const agencyLock = fx.sql.find((entry) => entry.includes('phase2_lock_domain_work_agency_head'));
  const claimSql = fx.sql.find((entry) => entry.includes('UPDATE "DomainWorkItem"'));
  assert.ok(agencyDiscovery, "production broad claim must select one bounded agency tranche");
  assert.ok(agencyLock, "selected agency authority must be locked before DWI mutation");
  assert.ok(claimSql, "production SQL claim path must execute");
  assert.match(agencyDiscovery, /ORDER BY a\."nextDueAt",a\."agencyId"[\s\S]*LIMIT 1/);
  assert.match(claimSql, /FROM "DomainWorkReadyPartition"/);
  assert.match(claimSql, /d\."agencyId"=\$4/);
  assert.match(claimSql, /"isOutstanding"=TRUE/);
  assert.match(claimSql, /FOR UPDATE OF d SKIP LOCKED/);
  assert.doesNotMatch(claimSql, /DomainWorkReadyAgency/, "one DB transaction must mutate DWI for only the selected agency");
  assert.doesNotMatch(claimSql, /row_number\s*\(/i, "claim must not rank the whole eligible universe before LIMIT");
  assert.ok(fx.sql.indexOf(agencyDiscovery) < fx.sql.indexOf(agencyLock) && fx.sql.indexOf(agencyLock) < fx.sql.indexOf(claimSql),
    "broad claim lock order must be bounded agency discovery -> agency authority -> partition/DWI claim");
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

test("F53-16 hot outstanding-work truth is read from current family state, never lifetime DONE DWI history", async () => {
  let dwiTouched = false;
  const db = {
    phase2WorkFamilyState: {
      async findUnique() {
        return { outstandingCount: 0, requestedSequence: 1_000_000n, convergedSequence: 1_000_000n };
      },
    },
    domainWorkItem: {
      async count() { dwiTouched = true; throw new Error("lifetime DWI history must not be scanned"); },
      async findMany() { dwiTouched = true; throw new Error("lifetime DWI history must not be scanned"); },
    },
  };
  const state = await authority.domainWorkFamilyState({ db, agencyId: "agency-1", workClass: authority.WORK_CLASS.TEAM_READ_SUMMARY });
  assert.equal(state.fresh, true);
  assert.equal(state.outstandingCount, 0);
  assert.equal(await authority.hasOutstandingDomainWork({ db, agencyId: "agency-1", workClass: authority.WORK_CLASS.TEAM_READ_SUMMARY }), false);
  assert.equal(dwiTouched, false);
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
