"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");
const authority = require("./domain-work-authority-service");

function fixture({ fallback = false, contended = false, admissionDelayMs = 20000, failureReservation = 0, failure = null } = {}) {
  let clock = 0, agency = null, reservations = 0, physicalClaims = 0;
  const committed = [], budgets = [], now = new Date();
  const nextAgency = () => ["agency-a", "agency-b"].find(value => !committed.includes(value));
  const db = {
    phase2WorkGenerationAuthority: { findUnique: async () => ({ activeGeneration: authority.DOMAIN_WORK_GENERATION }) },
    async $transaction(work, options) { budgets.push(options); return work({ ...db, $transaction: undefined }); },
    async $executeRawUnsafe() { return 1; },
    async $queryRawUnsafe(sql, ...args) {
      if (sql.includes('FROM "DomainWorkClaimTopologyState"') && sql.includes("FOR SHARE"))
        return [{ generation: authority.DOMAIN_WORK_CLAIM_TOPOLOGY_ID, activationState: "ACTIVE" }];
      if (sql.includes("set_config")) return [];
      if (sql.trim() === 'SELECT clock_timestamp() AS "authorityNow"') return [{ authorityNow: now }];
      if (sql.includes('UPDATE "DomainWorkClaimAgencyState"')) {
        reservations++; clock += admissionDelayMs; agency = nextAgency();
        if (reservations === failureReservation) throw failure;
        return !fallback && !contended && agency ? [{ agencyId: agency }] : [];
      }
      if (sql.includes('SELECT a."id" FROM "DomainWorkClaimAgencyState"')) return contended ? [{ id: "held-locator" }] : [];
      if (sql.includes('SELECT d."agencyId"')) return agency ? [{ agencyId: agency }] : [];
      if (sql.includes('UPDATE "DomainWorkClaimShardState"')) return fallback ? [] : [{ claimShard: 1 }];
      if (sql.includes('AS "claimShard"') && sql.includes('FROM "DomainWorkItem"')) return [{ claimShard: 1 }];
      if (sql.includes('SELECT f."partitionKey"')) return fallback ? [] : [{ partitionKey: "creator-" + agency }];
      if (sql.includes('UPDATE "DomainWorkItem"')) {
        physicalClaims++; assert.equal(args[3], agency);
        committed.push(agency);
        return [{ id: "work-" + agency, agencyId: agency, creatorId: "creator-" + agency, ownerToken: "owner" }];
      }
      return [];
    },
  };
  return { db: commitDatabaseFixture(db), monotonicNow: () => clock, committed, budgets,
    get reservations() { return reservations; }, get physicalClaims() { return physicalClaims; } };
}
const claim = f => authority.claimDomainWorkBatch({ db: f.db, workClass: authority.WORK_CLASS.CREATOR_RECURRING_PLANNING,
  ownerToken: "owner", limit: 10, perAgencyQuantum: 1, perPartitionQuantum: 1, monotonicNow: f.monotonicNow });

for (const fallback of [false, true]) test(`slow ${fallback ? "physical fallback" : "locator"} admission returns its first owner before reserving another tenant`, async () => {
  const f = fixture({ fallback });
  const first = await claim(f);
  assert.deepEqual(first.items.map(row => row.agencyId), ["agency-a"]);
  assert.equal(f.reservations, 1); assert.equal(f.physicalClaims, 1);
  assert.deepEqual(f.committed, ["agency-a"], "the time slice must not discard the completed physical claim");
  const second = await claim(f);
  assert.deepEqual(second.items.map(row => row.agencyId), ["agency-b"]);
  assert.equal(f.reservations, 2); assert.equal(f.physicalClaims, 2);
  // The kernel subtracts time already spent admitting the root and rounds down.
  assert.ok(f.budgets[0].timeout > 14000 && f.budgets[0].timeout <= 15000);
  assert.ok(f.budgets[2].timeout > 19000 && f.budgets[2].timeout <= 20000);
});

test("slow contended admission stops without bypassing the fair locator or claiming a hidden tenant", async () => {
  const f = fixture({ contended: true });
  assert.deepEqual((await claim(f)).items, []);
  assert.equal(f.reservations, 1); assert.equal(f.physicalClaims, 0);
});

for (const failure of [
  Object.assign(new Error("pool unavailable for agency-b: internal diagnostic"), { code: "P2024" }),
  Object.assign(new Error("A query cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 16000 ms passed since the start of the transaction."), { code: "P2028" }),
]) test(`a later ${failure.code} admission failure returns earlier committed owners and only its classified code`, async () => {
  const f = fixture({ admissionDelayMs: 0, failureReservation: 2, failure });
  const result = await claim(f);
  assert.deepEqual(result.items.map(row => row.id), ["work-agency-a"]);
  assert.equal(result.ownerToken, "owner");
  assert.deepEqual(result.admissionError, { code: failure.code });
  assert.deepEqual(f.committed, ["agency-a"]);
  assert.equal(f.reservations, 2); assert.equal(f.physicalClaims, 1);
  const next = await claim(f);
  assert.deepEqual(next.items.map(row => row.id), ["work-agency-b"]);
  assert.equal(next.admissionError, undefined);
});

test("a transient failure before any committed owner still throws", async () => {
  const failure = Object.assign(new Error("pool unavailable"), { code: "P2024" });
  const f = fixture({ admissionDelayMs: 0, failureReservation: 1, failure });
  await assert.rejects(claim(f), error => error === failure);
  assert.deepEqual(f.committed, []);
});

test("a non-database rejection after an earlier owner remains fail-closed", async () => {
  const failure = Object.assign(new Error("membership revoked"), { code: "DOMAIN_WORK_MEMBER_SCOPE_STALE" });
  const f = fixture({ admissionDelayMs: 0, failureReservation: 2, failure });
  await assert.rejects(claim(f), error => error === failure);
  assert.deepEqual(f.committed, ["agency-a"]);
});
