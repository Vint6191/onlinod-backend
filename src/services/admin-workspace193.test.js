"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { setAdminPricing } = require("./admin-pricing-command-service");
const { setAdminEntitlement } = require("./admin-billing-access-command-service");
const { pricingSchema } = require("./admin-command-contract");
const { accessFromRow } = require("./billing-execution-access-service");
const actor = { adminId: "admin-a", sessionId: "session-a", accessEpoch: 1 };
const window = {};
vm.runInNewContext(
  fs.readFileSync(require.resolve("../../public/admin/modules/admin-billing/admin-pricing.js"), "utf8"),
  { window }
);
const pricing = window.NodAdminPricing.command;
const draft = {
  reason: "Agreed model terms",
  tierMode: "MANUAL",
  tier: "STARTER",
  corePriceSource: "CATALOG",
  aiChatterPriceSource: "CATALOG",
  outreachPriceSource: "CATALOG",
};
for (const tier of ["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"])
  test(`UI to command: ${tier}, scoped model pricing, no entitlement mutation`, async () => {
    const m = createMemoryDb(),
      body = pricing(
        { agencyId: "agency-a", pricingRevision: 1 },
        { ...draft, tier, ...(tier === "CUSTOM" ? { corePriceSource: "OVERRIDE", corePrice: "73.50" } : {}) }
      );
    const result = await setAdminPricing({
      db: m.db,
      actor,
      commandId: randomUUID(),
      creatorId: "creator-a",
      payload: JSON.parse(JSON.stringify(body)),
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.billing.tier, tier);
    assert.equal(m.state.entitlements.length, 0);
    assert.equal(Object.hasOwn(m.state.profiles[0], "expectedAgencyId"), false);
    assert.equal(m.state.audit.length, 1);
  });
test("AUTO removes explicit core pricing; CUSTOM requires explicit cents", () => {
  const body = pricing(
    { agencyId: "agency-a" },
    { ...draft, tier: "CUSTOM", tierMode: "AUTO", corePriceSource: "OVERRIDE", corePrice: "99" }
  );
  assert.equal(body.corePriceSource, "CATALOG");
  assert.equal(Object.hasOwn(body, "tier"), false);
  assert.equal(Object.hasOwn(body, "corePriceCents"), false);
  assert.throws(() => pricing({}, { ...draft, tier: "CUSTOM" }), /Custom/);
  assert.throws(() => pricing({}, { ...draft, corePriceSource: "OVERRIDE", corePrice: "1.234" }), /Цена/);
  assert.equal(
    pricingSchema.safeParse({ expectedRevision: 1, expectedAgencyId: "agency-a", reason: "Only scope" }).success,
    false
  );
});
for (const kind of ["pricing", "access"])
  test(`Stale agency selection rejects ${kind} before changing another agency's model`, async () => {
    const m = createMemoryDb();
    const method = kind === "pricing" ? setAdminPricing : setAdminEntitlement;
    const payload = {
      expectedRevision: kind === "pricing" ? 1 : 0,
      expectedAgencyId: "another-agency",
      reason: "Stale form",
      ...(kind === "pricing" ? { tierMode: "MANUAL", tier: "PRO" } : { coreValidUntil: "2030-01-01T00:00:00.000Z" }),
    };
    const result = await method({ db: m.db, actor, commandId: randomUUID(), creatorId: "creator-a", payload });
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, "ADMIN_SELECTION_SCOPE_INVALID");
    assert.equal(m.state.profiles[0].pricingRevision, 1);
    assert.equal(m.state.entitlements.length, 0);
    assert.equal(m.state.audit[0].event, "REJECTED");
  });
test("Billing state distinguishes two models, agency hold, internal access and trial", () => {
  const base = { authorityNow: new Date("2026-11-03"), billingMode: "MANUAL", trialEndsAt: null };
  assert.equal(
    accessFromRow({ ...base, coreValidFrom: new Date("2026-10-01"), coreValidUntil: new Date("2026-12-01") }).reason,
    "PAID"
  );
  assert.equal(accessFromRow({ ...base, coreValidUntil: new Date("2026-10-01") }).allowed, false);
  assert.equal(accessFromRow({ ...base, billingMode: "FREE_INTERNAL" }).reason, "FREE_INTERNAL");
  assert.equal(
    accessFromRow({ ...base, billingMode: "FREE_INTERNAL", billingSupportHold: true }).reason,
    "BILLING_ACCESS_HELD"
  );
  assert.equal(accessFromRow({ ...base, trialEndsAt: new Date("2026-12-01") }).reason, "TRIAL");
});
test("Actual billing read projection uses server time, scoped entitlements and scoped OF session, bounded model page", async () => {
  const now = new Date("2026-11-03"),
    routes = {};
  let query;
  const creator = (id, entitlement, sessionState) => ({
    id,
    agencyId: "agency-a",
    displayName: id,
    status: "READY",
    remoteId: "123",
    billingProfile: null,
    billingEntitlement: entitlement,
    sessionState,
  });
  const ent = {
    agencyId: "agency-a",
    creatorId: "paid",
    tier: "PRO",
    coreValidFrom: new Date("2026-10-03"),
    coreValidUntil: new Date("2026-12-03"),
    corePriceCents: 7000,
  };
  const agency = {
    id: "agency-a",
    name: "A",
    deletedAt: null,
    billingSupportHold: false,
    trialEndsAt: null,
    subscriptions: [{ billingMode: "MANUAL" }],
    creators: [
      creator("paid", ent, { agencyId: "agency-a", status: "ACTIVE" }),
      creator("expired", null, { agencyId: "different-agency", status: "ACTIVE" }),
      creator("wrong-scope", { ...ent, creatorId: "wrong-scope", agencyId: "different-agency" }, null),
    ],
  };
  const policy = {
    settings: {
      starterPriceCents: 2000,
      growthPriceCents: 4000,
      proPriceCents: 7000,
      elitePriceCents: 10000,
      aiChatterPriceCents: 10000,
      outreachPriceCents: 2900,
    },
    revision: 1,
  };
  const fakeRequire = (name) => {
    if (name === "../prisma")
      return {
        agency: {
          findUnique: async (q) => {
            query = q;
            return agency;
          },
        },
      };
    if (name === "./admin-router")
      return { createAdminRouter: () => ({ use() {}, get: (p, fn) => (routes[p] = fn), patch() {}, post() {} }) };
    if (name === "./admin-command-handlers") return {};
    if (name.includes("/middleware/")) return {};
    if (name === "../services/db-time-authority-service") return { dbAuthorityNow: async () => now };
    if (name === "../services/admin-billing-read-service")
      return {
        billingPage: () => ({ limit: 100 }),
        readAgencyBillingTotals: async () =>
          new Map([
            [
              "agency-a",
              { activeUntil: ent.coreValidUntil, monthlyCents: 7000, configuredCents: 6000, modelsTotal: 3 },
            ],
          ]),
      };
    if (name === "../services/billing-commercial-policy-service") return { readCommercialPolicy: async () => policy };
    return require(require("node:path").resolve(__dirname, "../routes", name));
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../routes/admin-billing"), "utf8"), {
    require: fakeRequire,
    module: { exports: {} },
    Date,
    console,
  });
  let response;
  const res = { json: (b) => (response = b), status: () => res };
  await routes["/agency/:id"]({ params: { id: "agency-a" }, query: {} }, res);
  assert.equal(response.ok, true);
  assert.equal(query.include.creators.take, 101);
  assert.deepEqual(Object.keys(query.include.creators.include.sessionState.select).sort(), ["agencyId", "status"]);
  assert.equal(response.models[0].access.reason, "PAID");
  assert.equal(response.models[1].access.allowed, false);
  assert.equal(response.models[2].access.allowed, false);
  assert.equal(response.models[1].sessionStatus, null);
  assert.equal(response.models[0].sessionStatus, "ACTIVE");
  assert.equal(response.models[0].agencyId, "agency-a");
  assert.equal(response.models[0].remoteId, "123");
});
