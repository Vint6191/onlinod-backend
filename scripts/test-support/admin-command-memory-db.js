"use strict";

// Transactional fault-injection model, not evidence of PostgreSQL lock/trigger
// behavior. Real PostgreSQL contention and rollout remain separate gates.
function createMemoryDb(options = {}) {
  let state = {
    admins: [{ id: "admin-a", email: "a@example.test", name: "A", role: "SUPER_ADMIN", active: true, accessEpoch: 1, passwordHash: "old-hash", createdAt: new Date("2026-01-01") }],
    sessions: [{ id: "session-a", adminUserId: "admin-a", tokenHash: "token-a", issuedAccessEpoch: 1, revokedAt: null, expiresAt: new Date("2027-01-01") }],
    creators: [{ id: "creator-a", agencyId: "agency-a", deletedAt: null }],
    agencies: [{ id: "agency-a", deletedAt: null, status: "ACTIVE", plan: "core", trialEndsAt: null, currentPeriodEnd: null, billingPolicyRevision: 1, billingSupportHold: false, billingSupportHoldReason: null }],
    subscriptions: [{ id: "sub-a", agencyId: "agency-a", createdAt: new Date("2026-01-01"), status: "ACTIVE", billingMode: "MANUAL", billingPeriod: "MONTHLY", corePricePerCreatorCents: 2000, trialEndsAt: null, currentPeriodEnd: null }],
    entitlements: [],
    profiles: [{ id: "profile-a", creatorId: "creator-a", agencyId: "agency-a", pricingRevision: 1, tier: "STARTER", tierMode: "AUTO", corePriceCents: 2000, aiChatterEnabled: false, aiChatterPriceCents: 10000, outreachEnabled: false, outreachPriceCents: 2900, billingExcluded: false, notes: null, revenue30dCents: 42 }],
    commands: [], audit: [], logs: [],
  };
  const clock = new Date("2026-09-23T12:00:00Z");
  const copy = value => structuredClone(value);
  const match = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  function client(read, write) {
    let savepoint;
    const table = name => read()[name];
    const find = (name, where) => copy(table(name).find(row => match(row, where)) || null);
    const create = (name, data) => { const row = { id: `${name}-${table(name).length}`, createdAt: copy(clock), ...copy(data) }; table(name).push(row);
      if (name === "subscriptions") table("agencies").find(item => item.id === row.agencyId).billingPolicyRevision++;
      return copy(row); };
    function update(name, where, data) {
      const row = table(name).find(item => match(item, where));
      if (!row) throw new Error(`Missing ${name}`);
      if (name === "admins" && ["active", "role", "passwordHash"].some(key => data[key] !== undefined && row[key] !== data[key])) row.accessEpoch++;
      if (name === "profiles" && Object.keys(data).some(key => !["revenue30dCents", "updatedAt"].includes(key) && row[key] !== data[key])) row.pricingRevision++;
      const different = keys => keys.some(key => data[key] !== undefined && JSON.stringify(row[key] ?? null) !== JSON.stringify(data[key]));
      if (name === "agencies" && different(["plan", "trialEndsAt", "billingSupportHold", "billingSupportHoldReason"])) row.billingPolicyRevision++;
      if (name === "subscriptions" && different(["billingMode", "billingPeriod", "corePricePerCreatorCents", "trialEndsAt", "notes"])) table("agencies").find(item => item.id === row.agencyId).billingPolicyRevision++;
      if (name === "entitlements" && different(Object.keys(data).filter(key => !["updatedAt", "lastRenewalAttemptAt", "lastRenewalErrorCode", "lastRevenue30dCents", "lastRevenueCapturedAt"].includes(key)))) row.entitlementRevision++;
      Object.assign(row, copy(data));
      if (name === "agencies" && (row.deletedAt || row.billingSupportHold)) row.status = "LOCKED";
      return copy(row);
    }
    return {
      async $queryRawUnsafe(sql, id) {
        if (sql.includes("clock_timestamp")) return [{ authorityNow: copy(clock) }];
        if (sql.includes('FROM "Agency"')) return table("agencies").filter(row => row.id === id).map(copy);
        if (/FROM "(?:AdminUser|AdminSession|CreatorAccount|CreatorBillingProfile|CreatorBillingEntitlement)"/.test(sql)) return [{ id }];
        throw new Error(`Unexpected SQL ${sql}`);
      },
      async $executeRawUnsafe(sql) {
        if (sql === "SAVEPOINT admin_domain_mutation") savepoint = copy(read());
        else if (sql === "ROLLBACK TO SAVEPOINT admin_domain_mutation") write(copy(savepoint));
        else if (sql === "RELEASE SAVEPOINT admin_domain_mutation") savepoint = undefined;
        else if (!sql.includes("pg_advisory")) throw new Error(`Unexpected SQL ${sql}`);
        return 1;
      },
      adminUser: {
        findUnique: async ({ where }) => find("admins", where),
        count: async ({ where }) => table("admins").filter(row => match(row, where)).length,
        create: async ({ data }) => create("admins", { accessEpoch: 1, ...data }),
        update: async ({ where, data }) => update("admins", where, data),
        upsert: async ({ where, create: data, update: patch }) => find("admins", where) ? update("admins", where, patch) : create("admins", { accessEpoch: 1, ...data }),
      },
      adminSession: {
        findUnique: async ({ where, include }) => { const row = find("sessions", where); return row && include?.adminUser ? { ...row, adminUser: find("admins", { id: row.adminUserId }) } : row; },
        create: async ({ data }) => create("sessions", data),
        update: async ({ where, data }) => update("sessions", where, data),
        updateMany: async ({ where, data }) => { const rows = table("sessions").filter(row => match(row, where)); rows.forEach(row => Object.assign(row, copy(data))); return { count: rows.length }; },
      },
      creatorAccount: { findUnique: async ({ where, include }) => { const row = find("creators", where); return row && include?.billingProfile ? { ...row, billingProfile: find("profiles", { creatorId: row.id }), billingEntitlement: find("entitlements", { creatorId: row.id }) } : row; } },
      creatorBillingProfile: { update: async ({ where, data }) => update("profiles", where, data), create: async ({ data }) => create("profiles", { pricingRevision: 1, revenue30dCents: 0, ...data }) },
      agency: { findUnique: async ({ where }) => find("agencies", where), update: async ({ where, data }) => update("agencies", where, data) },
      agencySubscription: {
        findFirst: async ({ where }) => copy(table("subscriptions").filter(row => match(row, where)).sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id))[0] || null),
        update: async ({ where, data }) => update("subscriptions", where, data),
        create: async ({ data }) => create("subscriptions", { status: "TRIAL", billingMode: "MANUAL", billingPeriod: "MONTHLY", corePricePerCreatorCents: 2000, ...data }),
      },
      creatorBillingEntitlement: {
        findUnique: async ({ where }) => find("entitlements", where),
        findFirst: async ({ where }) => copy(table("entitlements").filter(row => row.agencyId === where.agencyId && row.coreValidUntil && new Date(row.coreValidUntil) > where.coreValidUntil.gt && table("creators").some(c => c.id === row.creatorId && c.agencyId === where.creator.agencyId && !c.deletedAt)).sort((a,b) => new Date(b.coreValidUntil)-new Date(a.coreValidUntil))[0] || null),
        update: async ({ where, data }) => update("entitlements", where, data),
        create: async ({ data }) => create("entitlements", { entitlementRevision: 1, tier: "STARTER", coreSource: "LEGACY", corePriceCents: 0, aiChatterSource: "LEGACY", aiChatterPriceCents: 0, outreachSource: "LEGACY", outreachPriceCents: 0, ...data }),
      },
      adminCommand: {
        findUnique: async ({ where }) => find("commands", where.actorId_commandId || where),
        create: async ({ data }) => create("commands", data),
        update: async ({ where, data }) => update("commands", where, data),
      },
      adminCommandAudit: { create: async ({ data }) => { if (options.failAudit) throw new Error("audit unavailable"); return create("audit", data); } },
      adminActionLog: { create: async ({ data }) => { if (options.failLog) throw new Error("audit unavailable"); return create("logs", data); } },
    };
  }
  let serial = Promise.resolve();
  const db = client(() => state, next => { state = next; });
  db.$transaction = work => {
    const run = async () => {
      if (options.beforeTransaction) await options.beforeTransaction(state);
      let draft = copy(state);
      const result = await work(client(() => draft, next => { draft = next; }));
      state = draft; return result;
    };
    const result = serial.then(run, run);
    serial = result.catch(() => {});
    return result;
  };
  return { db, options, get state() { return state; }, clock };
}
module.exports = { createMemoryDb };
