"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..", "..");
const walletPath = path.join(__dirname, "billing-wallet-service.js");
const nowPaymentsPath = path.join(__dirname, "billing-nowpayments-service.js");
const catalogPath = path.join(__dirname, "billing-catalog-service.js");
const migrationPath = path.join(root, "prisma", "migrations", "20260814104000_billing_wallet_auto_pricing_v14", "migration.sql");
const repairMigrationPath = path.join(root, "prisma", "migrations", "20260814113000_billing_wallet_v14_0_1_repair", "migration.sql");
const routePath = path.join(root, "src", "routes", "billing.js");
const schemaPath = path.join(root, "prisma", "schema.prisma");
const adminPath = path.join(root, "src", "routes", "admin.js");

function addMonthsUtc(value, months) {
  const d = new Date(value);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target;
}

function loadWalletService(prismaMock = {}) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return prismaMock;
    if (request === "./audit-service") return { audit: async () => null };
    if (request === "./billing-entitlement-service") return {
      addMonthsUtc,
      isFuture: (value, now = new Date()) => !!value && new Date(value).getTime() > new Date(now).getTime(),
      lockAgencyBillingMutation: async () => null,
      syncAgencyBillingAggregate: async () => ({ status: "ACTIVE" }),
    };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(walletPath)];
    return require(walletPath);
  } finally {
    Module._load = original;
  }
}

function loadNowPaymentsService(prismaMock = {}) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return prismaMock;
    if (request === "./audit-service") return { audit: async () => null };
    if (request === "./billing-entitlement-service") return { activatePaidOrderEntitlements: async () => null, refundOrderEntitlements: async () => null };
    if (request === "./billing-wallet-service") return { creditPaidTopUp: async () => null, refundTopUp: async () => null };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(nowPaymentsPath)];
    return require(nowPaymentsPath);
  } finally {
    Module._load = original;
  }
}

function makeDb({ balanceCents = 0n, revenue30dCents = 0, capturedAt = new Date("2026-08-14T12:00:00Z"), testMode = false } = {}) {
  const wallets = new Map();
  const txs = new Map();
  const periods = new Map();
  const entitlements = new Map();
  const profiles = new Map();
  const orders = new Map();
  let snapshot = null;
  let dailyRows = [];
  let coverageRows = [];
  function setRevenueEvidence(amount, at) {
    if (amount === null) {
      snapshot = null;
      dailyRows = [];
      coverageRows = [];
      return;
    }
    const captured = new Date(at);
    snapshot = { creatorId: "creator-1", rangeKey: "30d", totalCents: BigInt(amount), capturedAt: captured };
    const end = new Date(Date.UTC(captured.getUTCFullYear(), captured.getUTCMonth(), captured.getUTCDate()));
    end.setUTCDate(end.getUTCDate() - 1);
    const base = Math.floor(Number(amount) / 30);
    let remainder = Number(amount) - base * 30;
    dailyRows = [];
    coverageRows = [];
    for (let i = 0; i < 30; i += 1) {
      const date = new Date(end); date.setUTCDate(date.getUTCDate() - i);
      const value = base + (remainder > 0 ? 1 : 0); if (remainder > 0) remainder -= 1;
      dailyRows.push({ creatorId: "creator-1", date, totalCents: value, collectedAt: captured, updatedAt: captured });
      coverageRows.push({ creatorId: "creator-1", coverageDate: date, status: "COMPLETE" });
    }
  }
  setRevenueEvidence(revenue30dCents, capturedAt);
  let seq = 0;
  const walletKey = (agencyId, mode) => `${agencyId}:${mode === true}`;
  wallets.set(walletKey("agency-1", testMode), { id: `wallet-${testMode ? "test" : "live"}`, agencyId: "agency-1", testMode, balanceCents: BigInt(balanceCents), currency: "USD", createdAt: new Date(), updatedAt: new Date() });
  const baseProfile = { id: "profile-1", agencyId: "agency-1", creatorId: "creator-1", tier: "STARTER", tierMode: "AUTO", corePriceCents: 2000, revenue30dCents: 0, aiChatterEnabled: false, aiChatterPriceCents: 10000, outreachEnabled: false, outreachPriceCents: 2900, billingExcluded: false };
  profiles.set("creator-1", baseProfile);

  const db = {
    $transaction: async (fn) => fn(db),
    creatorEarningsSnapshot: {
      findUnique: async () => snapshot ? { ...snapshot } : null,
      findMany: async () => snapshot ? [{ ...snapshot }] : [],
    },
    analyticsCoverage: {
      count: async ({ where } = {}) => coverageRows.filter((row) => {
        const date = new Date(row.coverageDate).getTime();
        const gte = where?.coverageDate?.gte ? new Date(where.coverageDate.gte).getTime() : -Infinity;
        const lte = where?.coverageDate?.lte ? new Date(where.coverageDate.lte).getTime() : Infinity;
        return date >= gte && date <= lte && (!where?.status || row.status === where.status);
      }).length,
      findMany: async ({ where } = {}) => coverageRows.filter((row) => {
        const date = new Date(row.coverageDate).getTime();
        const gte = where?.coverageDate?.gte ? new Date(where.coverageDate.gte).getTime() : -Infinity;
        const lte = where?.coverageDate?.lte ? new Date(where.coverageDate.lte).getTime() : Infinity;
        return date >= gte && date <= lte;
      }).map((row) => ({ ...row })),
    },
    creatorEarningsDaily: {
      findMany: async ({ where } = {}) => dailyRows.filter((row) => {
        const date = new Date(row.date).getTime();
        const dateWhere = where?.date;
        if (dateWhere instanceof Date) return date === dateWhere.getTime();
        const gte = dateWhere?.gte ? new Date(dateWhere.gte).getTime() : -Infinity;
        const lte = dateWhere?.lte ? new Date(dateWhere.lte).getTime() : Infinity;
        return date >= gte && date <= lte;
      }).map((row) => ({ ...row })),
    },
    agencyBillingWallet: {
      upsert: async ({ where, create }) => {
        const key = walletKey(where.agencyId_testMode.agencyId, where.agencyId_testMode.testMode);
        if (!wallets.has(key)) wallets.set(key, { id: `wallet-${++seq}`, ...create, createdAt: new Date(), updatedAt: new Date() });
        return { ...wallets.get(key) };
      },
      findUnique: async ({ where }) => {
        if (where.id) return [...wallets.values()].find((w) => w.id === where.id) || null;
        const key = walletKey(where.agencyId_testMode.agencyId, where.agencyId_testMode.testMode);
        return wallets.has(key) ? { ...wallets.get(key) } : null;
      },
      update: async ({ where, data }) => {
        const entry = [...wallets.entries()].find(([, w]) => w.id === where.id);
        assert.ok(entry, "wallet exists");
        const next = { ...entry[1], ...data, updatedAt: new Date() };
        wallets.set(entry[0], next);
        return { ...next };
      },
    },
    billingWalletTransaction: {
      findUnique: async ({ where }) => {
        const row = [...txs.values()].find((t) => t.idempotencyKey === where.idempotencyKey || t.id === where.id) || null;
        return row ? { ...row } : null;
      },
      create: async ({ data }) => {
        if ([...txs.values()].some((t) => t.idempotencyKey === data.idempotencyKey)) { const e = new Error("unique"); e.code = "P2002"; throw e; }
        const row = { id: `tx-${++seq}`, createdAt: new Date(), ...data };
        txs.set(row.id, row); return { ...row };
      },
      findMany: async ({ where, take }) => [...txs.values()].filter((t) => t.agencyId === where.agencyId && t.testMode === where.testMode).sort((a,b) => b.createdAt-a.createdAt).slice(0,take).map((t) => ({ ...t })),
    },
    creatorBillingPeriod: {
      create: async ({ data }) => { const row = { id: `period-${++seq}`, createdAt: new Date(), updatedAt: new Date(), walletTransactionId: null, ...data }; periods.set(row.id, row); return { ...row }; },
      update: async ({ where, data }) => { const row = periods.get(where.id); assert.ok(row); const next = { ...row, ...data, updatedAt: new Date() }; periods.set(where.id, next); return { ...next }; },
      updateMany: async ({ where, data }) => { let count=0; for (const [id,row] of periods) { const agencyOk=!where.agencyId || row.agencyId===where.agencyId; const creatorOk=!where.creatorId || row.creatorId===where.creatorId; const statusOk=!where.status || row.status===where.status; const endsOk=!where.endsAt?.lte || new Date(row.endsAt)<=new Date(where.endsAt.lte); if (agencyOk && creatorOk && statusOk && endsOk) { periods.set(id,{...row,...data}); count++; } } return {count}; },
    },
    creatorBillingEntitlement: {
      findUnique: async ({ where }) => entitlements.has(where.creatorId) ? { ...entitlements.get(where.creatorId) } : null,
      upsert: async ({ where, create, update }) => { const old=entitlements.get(where.creatorId); const row=old ? {...old,...update,updatedAt:new Date()} : {id:`ent-${++seq}`,createdAt:new Date(),updatedAt:new Date(),...create}; entitlements.set(where.creatorId,row); return {...row}; },
      update: async ({ where, data }) => { const old=entitlements.get(where.creatorId); assert.ok(old); const row={...old,...data,updatedAt:new Date()}; entitlements.set(where.creatorId,row); return {...row}; },
      updateMany: async ({ where, data }) => { const old=entitlements.get(where.creatorId); if (!old || (where.agencyId && old.agencyId!==where.agencyId) || (where.autoRenewEnabled!==undefined && old.autoRenewEnabled!==where.autoRenewEnabled) || (where.coreValidUntil?.lte && new Date(old.coreValidUntil).getTime() > new Date(where.coreValidUntil.lte).getTime())) return {count:0}; entitlements.set(where.creatorId,{...old,...data}); return {count:1}; },
      findMany: async () => [...entitlements.values()].map((x)=>({...x})),
    },
    creatorBillingProfile: {
      upsert: async ({ where, create, update }) => { const old=profiles.get(where.creatorId); const row=old ? {...old,...update} : {id:`profile-${++seq}`,...create}; profiles.set(where.creatorId,row); return {...row}; },
      update: async ({ where, data }) => { const old=profiles.get(where.creatorId); assert.ok(old); const row={...old,...data}; profiles.set(where.creatorId,row); return {...row}; },
    },
    creatorAccount: {
      findFirst: async ({ where }) => {
        if (where.id !== "creator-1" || where.agencyId !== "agency-1") return null;
        return { id:"creator-1", agencyId:"agency-1", displayName:"Creator One", username:"creator_one", deletedAt:null, billingProfile:{...profiles.get("creator-1")}, billingEntitlement: entitlements.has("creator-1") ? {...entitlements.get("creator-1")} : null };
      },
    },
    billingOrder: {
      findUnique: async ({ where }) => orders.has(where.id) ? { ...orders.get(where.id) } : null,
      updateMany: async ({ where, data }) => { const old=orders.get(where.id); if (!old || (where.status && old.status!==where.status) || (where.activatedAt===null && old.activatedAt)) return {count:0}; orders.set(where.id,{...old,...data}); return {count:1}; },
    },
    _setSnapshot: (amount, at) => { setRevenueEvidence(amount, at); },
    _wallet: (mode = testMode) => wallets.get(walletKey("agency-1", mode)),
    _wallets: wallets,
    _transactions: txs,
    _periods: periods,
    _entitlements: entitlements,
    _profiles: profiles,
    _orders: orders,
  };
  return db;
}

test("automatic tier boundaries are server-defined and customer catalog is monthly-only", () => {
  const { automaticTierForRevenue, catalogForClient } = require(catalogPath);
  assert.equal(automaticTierForRevenue(0), "STARTER");
  assert.equal(automaticTierForRevenue(99_999), "STARTER");
  assert.equal(automaticTierForRevenue(100_000), "GROWTH");
  assert.equal(automaticTierForRevenue(499_999), "GROWTH");
  assert.equal(automaticTierForRevenue(500_000), "PRO");
  assert.equal(automaticTierForRevenue(1_499_999), "PRO");
  assert.equal(automaticTierForRevenue(1_500_000), "ELITE");
  const catalog = catalogForClient();
  assert.deepEqual(catalog.periods.map((p) => p.key), ["MONTHLY"]);
  assert.ok(catalog.tiers.every((t) => t.customerSelectable === false));
});

test("billable earnings provenance requires a DONE fetch_earnings job and COMMITTED ingest batch", () => {
  const source = fs.readFileSync(walletPath, "utf8");
  assert.match(source, /sourceJob: \{ is: \{ jobKey: "fetch_earnings", status: "DONE", completedAt: \{ not: null \} \} \}/);
  assert.match(source, /ingestBatch: \{ is: \{ status: "COMMITTED", sourceJobId: \{ not: null \}, completedAt: \{ not: null \} \} \}/);
});

test("billing requires relational earnings proof; a fresh legacy snapshot alone can only be an estimate", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const db = makeDb({ revenue30dCents: 120_000, capturedAt: now });
  const svc = loadWalletService(db);
  const verified = await svc.readRolling30dRevenue({ db, creatorId:"creator-1", now });
  assert.equal(verified.fresh, true);
  assert.equal(verified.source, "EARNINGS_DAILY_COMPLETE_30D");
  assert.equal(verified.revenue30dCents, 120_000);

  db.creatorEarningsDaily.findMany = async () => [];
  db.analyticsCoverage.count = async () => 0;
  const snapshotOnly = await svc.readRolling30dRevenue({ db, creatorId:"creator-1", now });
  assert.equal(snapshotOnly.fresh, false);
  assert.equal(snapshotOnly.source, "EARNINGS_SNAPSHOT_30D_UNVERIFIED");
  assert.equal(snapshotOnly.revenue30dCents, 120_000);
  assert.throws(() => svc.pricingFromRevenue({ profile: db._profiles.get("creator-1"), revenue: snapshotOnly }), (e) => e.code === "BILLING_EARNINGS_30D_UNAVAILABLE");

  db._setSnapshot(120_000, "2026-08-10T00:00:00Z");
  const stale = await svc.readRolling30dRevenue({ db, creatorId:"creator-1", now });
  assert.equal(stale.fresh, false);
  assert.equal(stale.source, "EARNINGS_SNAPSHOT_30D_STALE");
});

test("exported snapshot preview and quote helpers stay fail-closed for monetary pricing", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const db = makeDb({ revenue30dCents: 120_000, capturedAt: now });
  const svc = loadWalletService(db);
  const profile = db._profiles.get("creator-1");
  const snapshot = await db.creatorEarningsSnapshot.findUnique();
  const snapshotPreview = svc.pricingPreviewFromSnapshot({ profile, snapshot, now });
  assert.equal(snapshotPreview.available, false);
  assert.equal(snapshotPreview.revenueSource, "EARNINGS_SNAPSHOT_30D_UNVERIFIED");
  assert.equal(snapshotPreview.tier, "GROWTH");

  db.creatorEarningsDaily.findMany = async () => [];
  db.analyticsCoverage.count = async () => 0;
  const quoted = await svc.quoteCreatorMonthlyPrice({
    db,
    creator: { id: "creator-1", deletedAt: null, billingProfile: profile },
    now,
  });
  assert.equal(quoted.available, false);
  assert.equal(quoted.revenueSource, "EARNINGS_SNAPSHOT_30D_UNVERIFIED");
  assert.equal(quoted.tier, "GROWTH");
});

test("complete relational fallback uses the last 30 fully closed UTC days and requires complete coverage", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const db = makeDb(); db._setSnapshot(null);
  const rows=[]; for (let i=0;i<30;i++){ const d=new Date(Date.UTC(2026,7,13-i)); rows.push({date:d,totalCents:1000,collectedAt:now}); }
  let dailyWhere = null;
  let coverageWhere = null;
  db.creatorEarningsDaily.findMany=async({where})=>{ dailyWhere=where; return rows; };
  db.analyticsCoverage.count=async({where})=>{ coverageWhere=where; return 30; };
  const svc=loadWalletService(db);
  const ok=await svc.readRolling30dRevenue({db,creatorId:"creator-1",now});
  assert.equal(ok.fresh,true); assert.equal(ok.revenue30dCents,30_000); assert.equal(ok.source,"EARNINGS_DAILY_COMPLETE_30D");
  assert.equal(dailyWhere.date.gte.toISOString(), "2026-07-15T00:00:00.000Z");
  assert.equal(dailyWhere.date.lte.toISOString(), "2026-08-13T00:00:00.000Z");
  assert.deepEqual(dailyWhere.sourceJobId, { not: null });
  assert.deepEqual(dailyWhere.sourceScanRunId, { not: null });
  assert.equal(coverageWhere.coverageDate.gte.toISOString(), "2026-07-15T00:00:00.000Z");
  assert.equal(coverageWhere.coverageDate.lte.toISOString(), "2026-08-13T00:00:00.000Z");
  assert.deepEqual(coverageWhere.ingestBatchId, { not: null });
  assert.deepEqual(coverageWhere.lastVerifiedAt, { not: null });
  db.analyticsCoverage.count=async()=>29;
  const no=await svc.readRolling30dRevenue({db,creatorId:"creator-1",now});
  assert.equal(no.fresh,false); assert.equal(no.revenue30dCents,null);
});

test("batched Settings evidence uses the same complete 30-day fallback instead of disagreeing with renewal", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const db = makeDb({ revenue30dCents: 120_000, capturedAt: new Date("2026-08-10T00:00:00Z") });
  const dailyRows = [];
  const coverageRows = [];
  for (let i = 0; i < 30; i += 1) {
    const day = new Date(Date.UTC(2026, 7, 13 - i));
    dailyRows.push({ creatorId: "creator-1", date: day, totalCents: 4_000, collectedAt: now });
    coverageRows.push({ creatorId: "creator-1", coverageDate: day });
  }
  db.creatorEarningsDaily.findMany = async () => dailyRows;
  db.analyticsCoverage.findMany = async () => coverageRows;
  db.analyticsCoverage.count = async () => 30;
  const svc = loadWalletService(db);
  const result = await svc.readRolling30dRevenueBatch({ db, creatorIds: ["creator-1"], now });
  const revenue = result.get("creator-1");
  assert.equal(revenue.fresh, true);
  assert.equal(revenue.source, "EARNINGS_DAILY_COMPLETE_30D");
  assert.equal(revenue.revenue30dCents, 120_000);
  const preview = svc.pricingPreviewFromRevenue({ profile: db._profiles.get("creator-1"), revenue });
  assert.equal(preview.available, true);
  assert.equal(preview.tier, "GROWTH");
  assert.equal(preview.totalCents, 3000);
});

test("batched Settings evidence uses only two grouped queries over the same 30 closed days", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const db = makeDb({ revenue30dCents: 120_000, capturedAt: new Date("2026-08-10T00:00:00Z") });
  db.creatorEarningsDaily.findMany = async () => { throw new Error("batch aggregation must not materialize daily rows"); };
  db.creatorEarningsDaily.groupBy = async ({ where, by }) => {
    assert.deepEqual(by, ["creatorId"]);
    assert.equal(where.date.gte.toISOString(), "2026-07-15T00:00:00.000Z");
    assert.equal(where.date.lte.toISOString(), "2026-08-13T00:00:00.000Z");
    return [{ creatorId: "creator-1", _count: { _all: 30 }, _sum: { totalCents: 120_000 }, _max: { collectedAt: now } }];
  };
  db.analyticsCoverage.groupBy = async ({ where, by }) => {
    assert.deepEqual(by, ["creatorId"]);
    assert.equal(where.coverageDate.gte.toISOString(), "2026-07-15T00:00:00.000Z");
    assert.equal(where.coverageDate.lte.toISOString(), "2026-08-13T00:00:00.000Z");
    return [{ creatorId: "creator-1", _count: { _all: 30 } }];
  };
  const svc = loadWalletService(db);
  const revenue = (await svc.readRolling30dRevenueBatch({ db, creatorIds: ["creator-1"], now })).get("creator-1");
  assert.equal(revenue.fresh, true);
  assert.equal(revenue.source, "EARNINGS_DAILY_COMPLETE_30D");
  assert.equal(revenue.revenue30dCents, 120_000);
});

test("batched Settings evidence fails closed when even one coverage day is missing", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const db = makeDb({ revenue30dCents: 120_000, capturedAt: new Date("2026-08-10T00:00:00Z") });
  const dailyRows = [];
  const coverageRows = [];
  for (let i = 0; i < 30; i += 1) {
    const day = new Date(Date.UTC(2026, 7, 13 - i));
    dailyRows.push({ creatorId: "creator-1", date: day, totalCents: 4_000, collectedAt: now });
    if (i < 29) coverageRows.push({ creatorId: "creator-1", coverageDate: day });
  }
  db.creatorEarningsDaily.findMany = async () => dailyRows;
  db.analyticsCoverage.findMany = async () => coverageRows;
  db.analyticsCoverage.count = async () => 29;
  const svc = loadWalletService(db);
  const revenue = (await svc.readRolling30dRevenueBatch({ db, creatorIds: ["creator-1"], now })).get("creator-1");
  assert.equal(revenue.fresh, false);
  assert.equal(revenue.source, "EARNINGS_SNAPSHOT_30D_STALE");
  assert.equal(svc.pricingPreviewFromRevenue({ profile: db._profiles.get("creator-1"), revenue }).available, false);
});

test("one paid month can move STARTER -> GROWTH next renewal without rewriting history", async () => {
  const db=makeDb({balanceCents:10_000n,revenue30dCents:99_999,capturedAt:new Date("2026-08-14T12:00:00Z")});
  const svc=loadWalletService(db);
  const first=await svc.startCreatorSubscription({agencyId:"agency-1",creatorId:"creator-1",db,now:new Date("2026-08-14T12:00:00Z")});
  assert.equal(first.period.tier,"STARTER"); assert.equal(first.pricing.totalCents,2000); assert.equal(db._wallet().balanceCents,8000n);
  const firstPeriod={...first.period};
  db._setSnapshot(100_000,"2026-09-14T11:55:00Z");
  const current={...db._entitlements.get("creator-1")};
  const second=await svc.renewCreatorSubscription({entitlement:current,db,now:new Date("2026-09-14T12:30:00Z")});
  assert.equal(second.renewed,true); assert.equal(second.period.tier,"GROWTH"); assert.equal(second.pricing.totalCents,3000); assert.equal(db._wallet().balanceCents,5000n);
  assert.equal(db._periods.get(firstPeriod.id).tier,"STARTER");
  assert.equal(db._periods.get(firstPeriod.id).totalCents,2000);
  assert.equal(db._periods.get(firstPeriod.id).status,"COMPLETED");
  assert.equal(new Date(second.period.startedAt).toISOString(),"2026-09-14T12:00:00.000Z");
  assert.equal(db._entitlements.get("creator-1").subscriptionStartedAt.toISOString(),"2026-08-14T12:00:00.000Z");
  assert.equal(db._entitlements.get("creator-1").lastPaidAt.toISOString(),"2026-09-14T12:30:00.000Z");
  assert.equal(db._entitlements.get("creator-1").lastRenewalAttemptAt.toISOString(),"2026-09-14T12:30:00.000Z");
});

test("insufficient wallet never partially debits or creates a paid period", async () => {
  const db=makeDb({balanceCents:1_999n,revenue30dCents:50_000,capturedAt:new Date("2026-08-14T12:00:00Z")});
  const svc=loadWalletService(db);
  await assert.rejects(() => svc.startCreatorSubscription({agencyId:"agency-1",creatorId:"creator-1",db,now:new Date("2026-08-14T12:00:00Z")}), (e)=>e.code==="BILLING_WALLET_INSUFFICIENT_BALANCE");
  assert.equal(db._wallet().balanceCents,1_999n); assert.equal(db._transactions.size,0); assert.equal(db._periods.size,0);
});

test("stale earnings never debit wallet", async () => {
  const db=makeDb({balanceCents:10_000n,revenue30dCents:50_000,capturedAt:new Date("2026-08-10T00:00:00Z")});
  const svc=loadWalletService(db);
  await assert.rejects(() => svc.startCreatorSubscription({agencyId:"agency-1",creatorId:"creator-1",db,now:new Date("2026-08-14T12:00:00Z")}), (e)=>e.code==="BILLING_EARNINGS_30D_UNAVAILABLE");
  assert.equal(db._wallet().balanceCents,10_000n); assert.equal(db._transactions.size,0);
});

test("top-up credit and refund are idempotent; spent refunded funds can produce negative balance", async () => {
  const db=makeDb({balanceCents:0n});
  db._orders.set("order-top",{id:"order-top",agencyId:"agency-1",purpose:"WALLET_TOP_UP",status:"PAID",testMode:false,amountCents:6000,provider:"NOWPAYMENTS",providerInvoiceId:"inv",activatedAt:null,paidAt:new Date()});
  const svc=loadWalletService(db);
  const one=await svc.creditPaidTopUp({orderId:"order-top",sandboxActivationEnabled:true,db});
  assert.equal(one.credited,true); assert.equal(db._wallet().balanceCents,6000n);
  const two=await svc.creditPaidTopUp({orderId:"order-top",sandboxActivationEnabled:true,db});
  assert.equal(two.credited,false); assert.equal(db._wallet().balanceCents,6000n);
  db._wallet().balanceCents=1000n; // model already consumed $50 of the top-up
  db._orders.set("order-top",{...db._orders.get("order-top"),status:"REFUNDED"});
  const refunded=await svc.refundTopUp({order:db._orders.get("order-top"),db});
  assert.equal(refunded.reversed,true); assert.equal(db._wallet().balanceCents,-5000n);
  const again=await svc.refundTopUp({order:db._orders.get("order-top"),db});
  assert.equal(again.reversed,false); assert.equal(db._wallet().balanceCents,-5000n);
});

test("sandbox and live balances are isolated", async () => {
  const db=makeDb({balanceCents:7000n,testMode:false});
  db._wallets.set("agency-1:true",{id:"wallet-test",agencyId:"agency-1",testMode:true,balanceCents:1234n,currency:"USD",createdAt:new Date(),updatedAt:new Date()});
  const svc=loadWalletService(db);
  const live=await svc.getWalletState({agencyId:"agency-1",testMode:false,db});
  const sandbox=await svc.getWalletState({agencyId:"agency-1",testMode:true,db});
  assert.equal(live.wallet.balanceCents,7000); assert.equal(sandbox.wallet.balanceCents,1234);
});

test("live automatic pricing is opt-in while sandbox remains available", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const previous = process.env.BILLING_LIVE_AUTO_PRICING_ENABLED;
  delete process.env.BILLING_LIVE_AUTO_PRICING_ENABLED;
  try {
    const liveDb = makeDb({ balanceCents: 10_000n, revenue30dCents: 50_000, capturedAt: now, testMode: false });
    liveDb.agencySubscription = { findFirst: async () => ({ billingMode: "MANUAL" }) };
    const liveSvc = loadWalletService(liveDb);
    await assert.rejects(
      () => liveSvc.startCreatorSubscription({ agencyId: "agency-1", creatorId: "creator-1", testMode: false, db: liveDb, now }),
      (e) => e.code === "BILLING_LIVE_AUTO_PRICING_DISABLED",
    );
    assert.equal(liveDb._wallet().balanceCents, 10_000n);
    assert.equal(liveDb._transactions.size, 0);

    process.env.BILLING_LIVE_AUTO_PRICING_ENABLED = "1";
    const started = await liveSvc.startCreatorSubscription({ agencyId: "agency-1", creatorId: "creator-1", testMode: false, db: liveDb, now });
    assert.equal(started.alreadyActive, false);
    assert.equal(liveDb._wallet().balanceCents, 8_000n);
  } finally {
    if (previous === undefined) delete process.env.BILLING_LIVE_AUTO_PRICING_ENABLED;
    else process.env.BILLING_LIVE_AUTO_PRICING_ENABLED = previous;
  }
});

test("FREE_INTERNAL can exercise sandbox billing but can never debit or auto-renew the live wallet", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const liveDb = makeDb({ balanceCents: 10_000n, revenue30dCents: 50_000, capturedAt: now, testMode: false });
  liveDb.agencySubscription = { findFirst: async () => ({ billingMode: "FREE_INTERNAL" }) };
  const liveSvc = loadWalletService(liveDb);
  await assert.rejects(
    () => liveSvc.startCreatorSubscription({ agencyId: "agency-1", creatorId: "creator-1", testMode: false, db: liveDb, now }),
    (e) => e.code === "BILLING_FREE_INTERNAL_LIVE_DEBIT_DISABLED",
  );
  assert.equal(liveDb._wallet().balanceCents, 10_000n);
  assert.equal(liveDb._transactions.size, 0);

  const expired = { id: "ent-live", agencyId: "agency-1", creatorId: "creator-1", coreValidUntil: new Date("2026-08-14T11:00:00Z"), currentPeriodEndsAt: new Date("2026-08-14T11:00:00Z"), autoRenewEnabled: true, walletTestMode: false, lastRenewalErrorCode: null };
  liveDb._entitlements.set("creator-1", expired);
  const renewal = await liveSvc.renewCreatorSubscription({ entitlement: { ...expired }, db: liveDb, now });
  assert.equal(renewal.renewed, false);
  assert.equal(renewal.reason, "BILLING_FREE_INTERNAL_LIVE_DEBIT_DISABLED");
  assert.equal(liveDb._entitlements.get("creator-1").autoRenewEnabled, false);
  assert.equal(liveDb._wallet().balanceCents, 10_000n);

  const sandboxDb = makeDb({ balanceCents: 0n, revenue30dCents: 50_000, capturedAt: now, testMode: true });
  sandboxDb._wallets.set("agency-1:true", { id: "wallet-test", agencyId: "agency-1", testMode: true, balanceCents: 10_000n, currency: "USD", createdAt: now, updatedAt: now });
  sandboxDb.agencySubscription = { findFirst: async () => ({ billingMode: "FREE_INTERNAL" }) };
  const sandboxSvc = loadWalletService(sandboxDb);
  const started = await sandboxSvc.startCreatorSubscription({ agencyId: "agency-1", creatorId: "creator-1", testMode: true, db: sandboxDb, now });
  assert.equal(started.alreadyActive, false);
  assert.equal(sandboxDb._wallet(true).balanceCents, 8000n);
});

test("late retry does not back-bill a long expired period, normal scheduler delay preserves boundary", () => {
  const svc=loadWalletService({});
  const exact=svc.renewalStartAt({coreValidUntil:new Date("2026-09-14T12:00:00Z"),lastRenewalErrorCode:null},new Date("2026-09-14T12:30:00Z"));
  assert.equal(exact.toISOString(),"2026-09-14T12:00:00.000Z");
  const retry=svc.renewalStartAt({coreValidUntil:new Date("2026-09-14T12:00:00Z"),lastRenewalErrorCode:"BILLING_WALLET_INSUFFICIENT_BALANCE"},new Date("2026-09-17T12:00:00Z"));
  assert.equal(retry.toISOString(),"2026-09-17T12:00:00.000Z");
});

test("monthly billing preserves the anniversary day across short months and resets it after a real lapse", async () => {
  const jan31 = new Date("2027-01-31T12:00:00Z");
  const db = makeDb({ balanceCents: 20_000n, revenue30dCents: 50_000, capturedAt: jan31 });
  const svc = loadWalletService(db);
  const first = await svc.startCreatorSubscription({ agencyId: "agency-1", creatorId: "creator-1", db, now: jan31 });
  assert.equal(new Date(first.period.endsAt).toISOString(), "2027-02-28T12:00:00.000Z");
  assert.equal(db._entitlements.get("creator-1").billingAnchorDay, 31);

  db._setSnapshot(50_000, "2027-02-28T11:55:00Z");
  const second = await svc.renewCreatorSubscription({
    entitlement: { ...db._entitlements.get("creator-1") },
    db,
    now: new Date("2027-02-28T12:30:00Z"),
  });
  assert.equal(second.renewed, true);
  assert.equal(new Date(second.period.startedAt).toISOString(), "2027-02-28T12:00:00.000Z");
  assert.equal(new Date(second.period.endsAt).toISOString(), "2027-03-31T12:00:00.000Z");
  assert.equal(db._entitlements.get("creator-1").billingAnchorDay, 31);

  const lapsed = { ...db._entitlements.get("creator-1"), coreValidUntil: new Date("2027-03-31T12:00:00Z"), currentPeriodEndsAt: new Date("2027-03-31T12:00:00Z"), lastRenewalErrorCode: "BILLING_WALLET_INSUFFICIENT_BALANCE", autoRenewEnabled: true };
  db._entitlements.set("creator-1", lapsed);
  db._setSnapshot(50_000, "2027-04-03T11:55:00Z");
  const resumed = await svc.renewCreatorSubscription({ entitlement: { ...lapsed }, db, now: new Date("2027-04-03T12:00:00Z") });
  assert.equal(resumed.renewed, true);
  assert.equal(new Date(resumed.period.startedAt).toISOString(), "2027-04-03T12:00:00.000Z");
  assert.equal(new Date(resumed.period.endsAt).toISOString(), "2027-05-03T12:00:00.000Z");
  assert.equal(db._entitlements.get("creator-1").billingAnchorDay, 3);
});

test("V14 migration is additive, dates legacy access, keeps FREE_INTERNAL out of automatic wallet renewal", () => {
  const sql=fs.readFileSync(migrationPath,"utf8");
  assert.doesNotMatch(sql,/\bDROP\s+(?:TABLE|COLUMN)\b/i); assert.doesNotMatch(sql,/\bTRUNCATE\b/i); assert.doesNotMatch(sql,/\bDELETE\s+FROM\b/i);
  assert.match(sql,/CREATE TABLE "AgencyBillingWallet"/); assert.match(sql,/CREATE TABLE "BillingWalletTransaction"/); assert.match(sql,/CREATE TABLE "CreatorBillingPeriod"/);
  assert.match(sql,/"currentPeriodStartedAt" = COALESCE\(e\."currentPeriodStartedAt", e\."coreValidFrom"\)/);
  assert.match(sql,/SELECT l\."lineTotalCents" FROM "BillingOrderLine" l WHERE l\."orderId" = e\."coreLastOrderId"/);
  assert.match(sql,/"billingMode" <> 'FREE_INTERNAL'::"BillingMode"/);
  assert.match(sql,/WHERE "tier" <> 'CUSTOM'::"CreatorBillingTier"/);
});

test("V14.0.1 repair migration requires explicit wallet opt-in for legacy ADMIN/LEGACY/PAYMENT access", () => {
  const sql = fs.readFileSync(repairMigrationPath, "utf8");
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN)\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.match(sql, /ADD COLUMN "billingAnchorDay" INTEGER/);
  assert.match(sql, /EXTRACT\(DAY FROM COALESCE\(e\."currentPeriodStartedAt", e\."coreValidFrom", e\."subscriptionStartedAt"\)\)/);
  assert.match(sql, /"autoRenewEnabled" = false/);
  assert.doesNotMatch(sql, /SET\s+(?:(?!WHERE)[\s\S])*"autoRenewEnabled"\s*=\s*true/i);
  assert.match(sql, /'ADMIN'::"BillingEntitlementSource"/);
  assert.match(sql, /'LEGACY'::"BillingEntitlementSource"/);
  assert.match(sql, /'PAYMENT'::"BillingEntitlementSource"/);
  assert.doesNotMatch(sql, /'WALLET'::"BillingEntitlementSource"/);
});

test("admin helper defaults ordinary creator billing profiles to AUTO and only CUSTOM to MANUAL", () => {
  const admin = fs.readFileSync(adminPath, "utf8");
  assert.match(admin, /TIER_CATALOG.*billing-catalog-service/);
  assert.match(admin, /tierMode: key === "CUSTOM" \? "MANUAL" : "AUTO"/);
});

test("schema has wallet ledger and explicit subscription period dates", () => {
  const schema=fs.readFileSync(schemaPath,"utf8");
  for (const token of ["model AgencyBillingWallet", "model BillingWalletTransaction", "model CreatorBillingPeriod", "subscriptionStartedAt DateTime?", "currentPeriodStartedAt DateTime?", "currentPeriodEndsAt DateTime?", "nextRenewalAt DateTime?", "billingAnchorDay Int?", "autoRenewEnabled Boolean", "WALLET_TOP_UP"]) assert.match(schema,new RegExp(token.replace(/[?]/g,"\\?")));
});

test("customer direct tier/period checkout endpoints are retired", () => {
  const route=fs.readFileSync(routePath,"utf8");
  assert.match(route,/router\.post\("\/quote"[\s\S]*?status\(410\)/);
  assert.match(route,/router\.post\("\/checkout"[\s\S]*?status\(410\)/);
  assert.match(route,/router\.post\("\/wallet\/top-up"/);
  assert.match(route,/router\.post\("\/creators\/:creatorId\/start"/);
});

test("future creator profiles default to AUTO and migration preserves legacy sandbox/live wallet identity", () => {
  const schema=fs.readFileSync(schemaPath,"utf8");
  const sql=fs.readFileSync(migrationPath,"utf8");
  assert.match(schema,/tierMode String @default\("AUTO"\)/);
  assert.match(sql,/ALTER COLUMN "tierMode" SET DEFAULT 'AUTO'/);
  assert.match(sql,/SELECT o\."testMode" FROM "BillingOrder" o WHERE o\."id" = e\."coreLastOrderId"/);
});

test("an active paid period cannot be silently switched between sandbox and live wallets", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const db=makeDb({balanceCents:10_000n,revenue30dCents:50_000,capturedAt:now,testMode:false});
  db._entitlements.set("creator-1", { id:"ent-1", agencyId:"agency-1", creatorId:"creator-1", coreValidUntil:new Date("2026-09-14T12:00:00Z"), autoRenewEnabled:false, walletTestMode:false });
  const svc=loadWalletService(db);
  await assert.rejects(() => svc.startCreatorSubscription({agencyId:"agency-1",creatorId:"creator-1",testMode:true,db,now}), (e)=>e.code==="BILLING_WALLET_ENVIRONMENT_MISMATCH");
  const live = await svc.startCreatorSubscription({agencyId:"agency-1",creatorId:"creator-1",testMode:false,db,now});
  assert.equal(live.alreadyActive,true);
  assert.equal(live.entitlement.walletTestMode,false);
});


test("wallet top-up accepts arbitrary whole cents inside provider-safe bounds", () => {
  const svc=loadNowPaymentsService({});
  for (const amount of [100, 137, 2000, 6000, 12345, 10_000_000]) assert.equal(svc.normalizeTopUpAmountCents(amount), amount);
  for (const amount of [0, 99, 10_000_001, 12.5, "nope"]) assert.throws(() => svc.normalizeTopUpAmountCents(amount), (e)=>e.code==="BILLING_TOP_UP_AMOUNT_INVALID");
});

test("hosted wallet top-up creation is retired and cannot contact NOWPayments", async () => {
  const svc=loadNowPaymentsService({});
  const oldFetch=global.fetch;
  let calls=0;
  global.fetch=async()=>{ calls+=1; throw new Error("provider must not be called"); };
  try {
    await assert.rejects(
      svc.createWalletTopUpCheckout({agencyId:"agency-1",actorUserId:"owner-1",checkoutKey:"123e4567-e89b-42d3-a456-426614174000",amountCents:6137}),
      (e)=>e.code==="BILLING_HOSTED_WALLET_TOP_UP_RETIRED" && e.status===410,
    );
    assert.equal(calls,0);
  } finally { global.fetch=oldFetch; }
});

test("a stale failed renewal cannot overwrite error state after another worker already renewed the creator", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const db = makeDb({ balanceCents: 0n, revenue30dCents: 50_000, capturedAt: now });
  const due = {
    id: "ent-1", agencyId: "agency-1", creatorId: "creator-1",
    coreValidUntil: new Date("2026-08-14T11:00:00Z"),
    autoRenewEnabled: true, walletTestMode: false,
    lastRenewalErrorCode: null, nextRenewalAt: new Date("2026-08-14T11:00:00Z"),
  };
  db._entitlements.set("creator-1", { ...due });
  const rawTransaction = db.$transaction;
  db.$transaction = async (fn) => {
    try { return await rawTransaction(fn); }
    catch (err) {
      db._entitlements.set("creator-1", {
        ...db._entitlements.get("creator-1"),
        coreValidUntil: new Date("2026-09-14T12:00:00Z"),
        currentPeriodEndsAt: new Date("2026-09-14T12:00:00Z"),
        nextRenewalAt: new Date("2026-09-14T12:00:00Z"),
        lastRenewalErrorCode: null,
      });
      throw err;
    }
  };
  const svc = loadWalletService(db);
  const result = await svc.renewCreatorSubscription({ entitlement: due, db, now });
  assert.equal(result.renewed, false);
  assert.equal(result.reason, "BILLING_WALLET_INSUFFICIENT_BALANCE");
  const final = db._entitlements.get("creator-1");
  assert.equal(final.lastRenewalErrorCode, null);
  assert.equal(final.coreValidUntil.toISOString(), "2026-09-14T12:00:00.000Z");
  assert.equal(final.nextRenewalAt.toISOString(), "2026-09-14T12:00:00.000Z");
});

test("hourly renewal sweep closes expired billing-period rows even when nothing can renew", async () => {
  const db=makeDb();
  db._periods.set("expired", {id:"expired",agencyId:"agency-1",creatorId:"creator-1",status:"ACTIVE",endsAt:new Date("2026-08-14T11:00:00Z")});
  const svc=loadWalletService(db);
  const result=await svc.renewDueCreatorSubscriptions({db,now:new Date("2026-08-14T12:00:00Z")});
  assert.equal(result.scanned,0);
  assert.equal(db._periods.get("expired").status,"COMPLETED");
});


test("admin dated access keeps V14 display dates coherent instead of leaving stale wallet-period metadata", () => {
  const admin=fs.readFileSync(adminPath,"utf8");
  assert.match(admin,/subscriptionStartedAt: coreUntil/);
  assert.match(admin,/currentPeriodStartedAt: coreUntil/);
  assert.match(admin,/currentPeriodEndsAt: coreUntil/);
  assert.match(admin,/nextRenewalAt: null/);
  assert.match(admin,/billingAnchorDay: coreUntil/);
  assert.match(admin,/amountChargedForPeriodCents: 0/);
  assert.match(admin,/autoRenewEnabled: false/);
  assert.match(admin,/walletTestMode: null/);
});
