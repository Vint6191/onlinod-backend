"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const cov = require("./phase2-work-coverage-authority-service");
function makeDb() {
  const rows = new Map();
  const workRows = new Map();
  const keyOf = (x) => { const v=x.agencyId_family_generation||x; return `${v.agencyId}|${v.family}|${v.generation}`; };
  const workKeyOf = (x) => { const v=x.agencyId_workClass_objectType_objectId||x; return `${v.agencyId}|${v.workClass}|${v.objectType}|${v.objectId}`; };
  const model = {
    async findUnique({where}) { return rows.get(keyOf(where)) || null; },
    async upsert({where,create,update}) { const k=keyOf(where), cur=rows.get(k); const next=cur?{...cur,...update}:{...create}; rows.set(k,next); return {...next}; },
    async update({where,data}) { const k=keyOf(where), cur=rows.get(k); if(!cur) throw new Error("missing"); const next={...cur,...data}; rows.set(k,next); return {...next}; },
  };
  const domainWorkItem = {
    async findUnique({where}) { const row=workRows.get(workKeyOf(where)); return row ? {...row} : null; },
    async upsert({where,create,update}) { const k=workKeyOf(where), cur=workRows.get(k); const next=cur?{...cur,...update}:{...create}; workRows.set(k,next); return {...next}; },
    async update({where,data}) {
      const entry=[...workRows.entries()].find(([,v])=>v.id===where.id); if(!entry) throw new Error("missing work");
      const [k,cur]=entry; const next={...cur};
      for(const [field,value] of Object.entries(data)){
        if(value && typeof value==='object' && 'increment' in value) next[field]=BigInt(next[field]||0)+BigInt(value.increment);
        else next[field]=value;
      }
      workRows.set(k,next); return {...next};
    },
  };
  const db={ phase2WorkCoverage:model, domainWorkItem, async $transaction(work){ return work(db); } };
  return {db,rows,workRows};
}
test("A11: Phase2 coverage readiness is isolated per agency", async () => {
  const fx=makeDb(); const family=cov.FAMILY.PROVIDER_OPERATIONAL, generation=cov.GENERATION.PROVIDER_OPERATIONAL;
  await cov.markPhase2CoverageFailed({db:fx.db,agencyId:"agency-a",family,generation,unresolvedCount:3});
  await cov.markPhase2CoverageComplete({db:fx.db,agencyId:"agency-b",family,generation,enumeratedThrough:"z",projectedThrough:"z"});
  assert.equal((await cov.phase2CoverageStatus({db:fx.db,agencyId:"agency-a",family,generation})).ready,false);
  assert.equal((await cov.phase2CoverageStatus({db:fx.db,agencyId:"agency-b",family,generation})).ready,true);
  await assert.rejects(() => cov.requirePhase2CoverageReady({db:fx.db,agencyId:"agency-a",family,generation}), /not complete/);
  assert.ok(await cov.requirePhase2CoverageReady({db:fx.db,agencyId:"agency-b",family,generation}));
});


test("manual coverage request is idempotent while historical work is already in flight", async () => {
  const fx=makeDb(); const family=cov.FAMILY.TEAM_MONEY_RECONCILIATION, generation=cov.GENERATION.TEAM_MONEY_RECONCILIATION;
  const first=await cov.requestPhase2CoverageEnumeration({db:fx.db,agencyId:"agency-a",family,generation,now:new Date("2026-09-10T00:00:00Z")});
  assert.equal(first.requested,true);
  assert.equal(fx.workRows.size,1);
  const work=[...fx.workRows.values()][0];
  assert.equal(work.workClass,"HISTORICAL_ENUMERATION");
  assert.equal(work.requestedRevision,1n);
  const second=await cov.requestPhase2CoverageEnumeration({db:fx.db,agencyId:"agency-a",family,generation,now:new Date("2026-09-10T00:00:01Z")});
  assert.equal(second.requested,false);
  assert.equal(second.inFlight,true);
  assert.equal([...fx.workRows.values()][0].requestedRevision,1n,"repeated admin sweep must not inflate revision while the same historical request is live");
});

test("complete coverage is not republished by manual maintenance request", async () => {
  const fx=makeDb(); const family=cov.FAMILY.TEAM_MONEY_RECONCILIATION, generation=cov.GENERATION.TEAM_MONEY_RECONCILIATION;
  await cov.markPhase2CoverageComplete({db:fx.db,agencyId:"agency-a",family,generation,enumeratedThrough:"done",projectedThrough:"done"});
  const result=await cov.requestPhase2CoverageEnumeration({db:fx.db,agencyId:"agency-a",family,generation});
  assert.equal(result.alreadyComplete,true);
  assert.equal(result.requested,false);
  assert.equal(fx.workRows.size,0);
});


test("INT6 current coverage guard rejects historical COMPLETE while live DomainWork is still outstanding", async () => {
  const generation = cov.GENERATION.CUSTOM_EXTERNAL_PROJECTION;
  const workGeneration = "phase2_domain_work_v3_actual55";
  let live = true;
  const coverage = {
    active: true, enumerationState: "COMPLETE", completedAt: new Date("2026-09-11T00:00:00Z"),
  };
  const db = {
    phase2WorkCoverage: { async findUnique() { return coverage; } },
    phase2WorkGenerationAuthority: { async findUnique() { return { activeGeneration: workGeneration }; } },
    phase2WorkFamilyState: { async findUnique() { return { activeGeneration: workGeneration, outstandingCount: 0, requestedSequence: 4n, convergedSequence: 4n }; } },
    domainWorkItem: { async findFirst() { return live ? { id: "live-custom-external" } : null; } },
  };

  let status = await cov.phase2CoverageStatus({ db, agencyId: "agency-a", family: cov.FAMILY.CUSTOM_EXTERNAL_PROJECTION, generation });
  assert.equal(status.ready, true, "historical compatibility bit remains COMPLETE");
  assert.equal(status.currentReady, false, "live outstanding work must keep current authority stale");
  await assert.rejects(
    () => cov.requirePhase2CoverageReady({ db, agencyId: "agency-a", family: cov.FAMILY.CUSTOM_EXTERNAL_PROJECTION, generation }),
    (error) => error?.code === "PHASE2_COVERAGE_INCOMPLETE",
  );

  live = false;
  status = await cov.phase2CoverageStatus({ db, agencyId: "agency-a", family: cov.FAMILY.CUSTOM_EXTERNAL_PROJECTION, generation });
  assert.equal(status.currentReady, true);
  assert.ok(await cov.requirePhase2CoverageReady({ db, agencyId: "agency-a", family: cov.FAMILY.CUSTOM_EXTERNAL_PROJECTION, generation }));
});
