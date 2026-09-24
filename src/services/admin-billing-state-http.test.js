"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), Module = require("node:module"), express = require("express");
const { policyModelFixture } = require("../../scripts/test-support/commercial-policy-fixture");

test("actual billing HTTP readers share effective expiry, paid boundaries, hold and internal-mode semantics", async t => {
  const now = new Date("2026-09-24T12:00:00Z"), future = new Date("2026-10-24"), past = new Date("2026-09-01");
  const creator = (id, agencyId, patch = {}) => ({ id, agencyId, deletedAt: null, displayName: id, billingProfile: null,
    billingEntitlement: { creatorId: id, agencyId, coreValidFrom: past, coreValidUntil: future, corePriceCents: 2000, ...patch } });
  const base = { name: "Test", status: "ACTIVE", deletedAt: null, billingSupportHold: false, trialEndsAt: past, subscriptions: [], creators: [] };
  const agencies = [
    { ...base, id: "expired", subscriptions: [{ status: "TRIAL", trialEndsAt: future, currentPeriodEnd: future }] },
    { ...base, id: "paid", creators: [creator("c-paid", "paid"), creator("c-future", "paid", { coreValidFrom: future, coreValidUntil: new Date("2027-01-01"), corePriceCents: 9000 })] },
    { ...base, id: "held", billingSupportHold: true, creators: [creator("c-held", "held")] },
    { ...base, id: "free", subscriptions: [{ billingMode: "FREE_INTERNAL", status: "PAST_DUE" }], creators: [creator("c-free", "free")] },
    { ...base, id: "trial", trialEndsAt: future },
    { ...base, id: "foreign", creators: [creator("c-foreign", "foreign", { agencyId: "paid" })] },
  ];
  const db = { systemSetting: policyModelFixture(), $queryRawUnsafe: async () => [{ authorityNow: now }],
    agency: { findMany: async () => agencies, findUnique: async ({ where }) => agencies.find(a => a.id === where.id) || null } };
  const original = Module._load, route = require.resolve("../routes/admin-billing");
  Module._load = function (request, parent, isMain) {
    if (request === "../services/admin-billing-read-service") {
      const { liveEntitlementEnd, effectiveBillingState, activeCore, scopedEntitlement } = require("./billing-state-service");
      const totals = a => {
        const activeUntil = liveEntitlementEnd(a.creators,a.id,now);
        const lines = a.creators.map(c => { const e=scopedEntitlement(c,a.id); return e && activeCore(e,now) ? e.corePriceCents : 0; });
        return { id:a.id,activeUntil,modelsTotal:a.creators.length,modelsBilled:lines.filter(n=>n>0).length,monthlyCents:lines.reduce((a,b)=>a+b,0),configuredCents:2000*a.creators.length,ai:0,outreach:0 };
      };
      return { billingPage: require("./admin-billing-read-service").billingPage,
        readAgencyBillingTotals: async ({agencyIds}) => new Map(agencies.filter(a=>agencyIds.includes(a.id)).map(a=>[a.id,totals(a)])),
        readGlobalBillingTotals: async () => {
          const eligible=agencies.filter(a=>effectiveBillingState({agency:a,subscription:a.subscriptions[0],activeUntil:totals(a).activeUntil,now}).status==='ACTIVE' && a.subscriptions[0]?.billingMode!=='FREE_INTERNAL');
          return { billedCents:eligible.reduce((sum,a)=>sum+totals(a).monthlyCents,0),billedModels:eligible.reduce((sum,a)=>sum+totals(a).modelsBilled,0),totalAgencies:agencies.length,billableAgencies:eligible.length,trialPotentialCents:0 };
        } };
    }
    if (request === "../prisma") return db;
    if (request === "../middleware/admin") return { adminRequired: (_req, _res, next) => next() };
    if (request === "../middleware/admin-read-boundary") return { adminReadBoundary: (_req, _res, next) => next() };
    if (request === "../middleware/admin-audit") return { adminHttpAuditMiddleware: (_req, _res, next) => next() };
    return original.call(this, request, parent, isMain);
  };
  let router;
  try { delete require.cache[route]; router = require(route); } finally { Module._load = original; }
  const app = express(); app.use("/billing", router);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = async suffix => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/billing${suffix}`);
    assert.equal(r.status, 200); return r.json();
  };
  const overview = await get("/overview"), byId = Object.fromEntries(overview.agencies.map(a => [a.agencyId, a]));
  assert.deepEqual(Object.fromEntries(Object.entries(byId).map(([id, a]) => [id, a.status])), { paid: "ACTIVE", held: "LOCKED", free: "ACTIVE", expired: "PAST_DUE", trial: "TRIAL", foreign: "PAST_DUE" });
  assert.equal(overview.mrr.billedCents, 2000); assert.equal(byId.paid.currentPeriodEnd, future.toISOString());
  assert.equal(byId.expired.currentPeriodEnd, null); assert.equal(byId.expired.trialEndsAt, past.toISOString());
  for (const id of ["expired", "paid", "held", "free", "trial", "foreign"]) {
    const detail = await get(`/agency/${id}`); assert.equal(detail.agency.status, byId[id].status); assert.equal(detail.billable, byId[id].billable);
    assert.equal(detail.agency.currentPeriodEnd, byId[id].currentPeriodEnd);
    if (detail.subscription) assert.equal(detail.subscription.status, byId[id].status);
  }
  const paid = await get("/agency/paid"); assert.equal(paid.models.find(c => c.creatorId === "c-future").entitlement.coreActive, false);
  const foreign = await get("/agency/foreign"); assert.equal(foreign.models[0].activeLineCents, 0); assert.equal(foreign.models[0].entitlement.coreActive, false);
});
