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
    commands: [], audit: [], logs: [], workItems: [], deliveries: [], aggregates: [], candidates: [],
  };
  if(options.extendState) Object.assign(state, structuredClone(options.extendState));
  const clock = new Date("2026-09-23T12:00:00Z");
  const copy = value => structuredClone(value);
  const match = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  function client(read, write) {
    const savepoints = new Map();
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
      if (name === "commands" && data.status && options.commandStatuses && !options.commandStatuses.has(data.status)) throw Error("AdminCommand_status_check");
      Object.assign(row, copy(data));
      if (name === "agencies" && (row.deletedAt || row.billingSupportHold)) row.status = "LOCKED";
      return copy(row);
    }
    const api = {
      async $queryRawUnsafe(sql, ...args) {
        const id = args[0];
        if (sql.includes('FROM "SfsTargetCandidate"')) return table("candidates").filter(row => id.includes(row.id)).map(copy);
        if (sql.includes('FROM "CreatorAccount"') && Array.isArray(id)) return table("creators").filter(row => id.includes(row.id)).map(copy);
        if (sql.includes('SELECT d.* FROM "AutomationDelivery"')) {
          const manifest = JSON.parse(id);
          return table("deliveries").filter(row => manifest.some(m => m.id === row.id && m.agencyId === row.agencyId && m.creatorId === row.creatorId && new Date(m.expectedUpdatedAt).getTime() === row.updatedAt.getTime())).map(copy);
        }
        if (sql.includes('DELETE FROM "AutomationDelivery"')) {
          if (options.beforeArchiveDelete) options.beforeArchiveDelete(table("deliveries"));
          const rows = table("deliveries").filter(row => id.includes(row.id) && row.originKind === "AUTOMATION" && ["COMPLETED","FAILED","SKIPPED","CANCELED"].includes(row.status) && row.finishedAt && row.finishedAt < args[1] && row.failureCode !== "outcome_unresolved_do_not_retry" && (!row.remoteLifecycleState || row.remoteLifecycleState === "SETTLED") && (row.actionType !== "MASS_QUEUE_CREATE" || row.intentAcknowledgedAt));
          read().deliveries = table("deliveries").filter(row => !rows.includes(row));
          return rows.map(copy);
        }
        if (sql.includes('INSERT INTO "AutomationMonthlyAggregate"')) {
          if (options.failAggregate) throw Error("archive unavailable");
          return JSON.parse(id).map(group => {
            let row = table("aggregates").find(row => ["creatorId","moduleKey","actionType","periodStart"].every(k => String(row[k]) === String(group[k])));
            if (row && row.agencyId !== group.agencyId) return null;
            if (!row) { table("aggregates").push(copy(group)); row = group; }
            else { for (const [k,v] of Object.entries(group)) if (typeof v === "number") row[k] += v; row.firstAt = row.firstAt < group.firstAt ? row.firstAt : group.firstAt; row.lastAt = row.lastAt > group.lastAt ? row.lastAt : group.lastAt; }
            return {id:row.id};
          }).filter(Boolean);
        }
        if (sql.includes('INSERT INTO "DomainWorkItem"')) {
          if (options.failPublish) throw new Error("work publish unavailable");
          const [id,agencyId,workClass,objectType,objectId,parentObjectId,partitionKey,creatorId,accountId,activeGeneration,projectionVersion] = args;
          return [create("workItems", { id,agencyId,workClass,objectType,objectId,parentObjectId,partitionKey,creatorId,accountId,activeGeneration,projectionVersion,state:"READY",requestedRevision:1n,completedRevision:0n,claimedRevision:0n,claimFence:0n,isOutstanding:true,availableAt:copy(clock),ownerToken:null })];
        }
        if (sql.includes('FROM "DomainWorkItem"')) return table("workItems").filter(row => row.id === id).map(copy);
        if (sql.includes('UPDATE "DomainWorkItem"')) {
          const [revision,now,id,owner,fence,generation,terminalCause] = args;
          const row=table("workItems").find(row=>row.id===id);
          if (!row || options.loseSettlement || row.ownerToken!==owner || row.claimFence!==fence || row.claimedRevision!==revision || row.activeGeneration!==generation || row.state!=="CLAIMED" || row.leaseUntil<=now) return [];
          Object.assign(row,{completedRevision:revision,state:"DONE",isOutstanding:false,ownerToken:null,leaseUntil:now,terminalCause});
          return [copy(row)];
        }
        if (sql.includes("clock_timestamp")) return [{ authorityNow: copy(clock) }];
        if (sql.includes('FROM "Agency"')) return table("agencies").filter(row => row.id === id).map(copy);
        if (/FROM "(?:AdminUser|AdminSession|CreatorAccount|CreatorBillingProfile|CreatorBillingEntitlement)"/.test(sql)) return [{ id }];
        throw new Error(`Unexpected SQL ${sql}`);
      },
      async $executeRawUnsafe(sql) {
        if (sql.startsWith("SAVEPOINT ")) savepoints.set(sql.slice(10),copy(read()));
        else if (sql.startsWith("ROLLBACK TO SAVEPOINT ")) write(copy(savepoints.get(sql.slice(22))));
        else if (sql.startsWith("RELEASE SAVEPOINT ")) savepoints.delete(sql.slice(18));
        else if (!sql.includes("pg_advisory")) throw new Error(`Unexpected SQL ${sql}`);
        return 1;
      },
      automationDelivery: { findMany: async ({ where = {}, take = 500 }) => {
        if (take > 500) throw Error("Unbounded archive selection");
        return table("deliveries").filter(row => (!where.id?.in || where.id.in.includes(row.id)) && (!where.agencyId || row.agencyId === where.agencyId) && (!where.creatorId || row.creatorId === where.creatorId)).slice(0,take).map(copy);
      } },
      sfsTargetCandidate: { findMany: async ({where}) => table("candidates").filter(row => where.id.in.includes(row.id)).map(copy) },
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
      creatorAccount: { findMany: async ({where,take}) => {
        if (!Number.isInteger(take) || take>100) throw Error("Unbounded creator selection");
        return table("creators").filter(row=>row.agencyId===where.agencyId && row.deletedAt===where.deletedAt && where.id.in.includes(row.id)).slice(0,take).map(copy);
      }, findUnique: async ({ where, include }) => { const row = find("creators", where); return row && include?.billingProfile ? { ...row, billingProfile: find("profiles", { creatorId: row.id }), billingEntitlement: find("entitlements", { creatorId: row.id }) } : row; } },
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
      domainWorkItem: {
        findUnique: async ({where}) => find("workItems",where),
        findFirst: async ({where}) => find("workItems",where),
        updateMany: async ({where,data}) => {
          if (options.loseSettlement) return {count:0};
          const rows=table("workItems").filter(row=>Object.entries(where).every(([k,v])=>v && typeof v==="object" && !(v instanceof Date) ? (v.gt!==undefined ? row[k]>v.gt : false) : row[k]===v));
          rows.forEach(row=>Object.assign(row,copy(data)));return {count:rows.length};
        },
      },
      adminCommand: {
        findUnique: async ({ where }) => find("commands", where.actorId_commandId || where),
        create: async ({ data }) => create("commands", data),
        update: async ({ where, data }) => update("commands", where, data),
      },
      adminCommandAudit: { create: async ({ data }) => { if (options.failAudit) throw new Error("audit unavailable"); return create("audit", data); } },
      adminActionLog: { create: async ({ data }) => { if (options.failLog) throw new Error("audit unavailable"); return create("logs", data); } },
    };
    return options.extendClient ? options.extendClient(api, {read,write,clock,copy}) : api;
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
